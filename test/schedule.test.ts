// Scheduled demo trades: one capped, silent order per slot on the demo account, as a persisted sandbox job;
// retried within the slot hour while busy; closed by the sweep after the hold time, also after a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { makeBot, msg, PATHS, POOLS } from "./_harness.ts";

POOLS.XRP = "0x2222222222222222222222222222222222222222"; // the schedule rotates XRP, SOL, ETH
const DEMO = "0x2A11e7388D1D2F9690f2636846d44b478f61bF08" as const;
const at = (iso: string) => Date.parse(iso);
const jobs = () => { try { return JSON.parse(readFileSync(`${PATHS.data}/sandbox_jobs.json`, "utf8")); } catch { return []; } };

export function setup() {
  const h = makeBot();
  const u = h.addUser(8684117854, DEMO);
  const closes: string[] = [];
  h.bot.venue.close = async (tk: { owner: string }, base: string) => {
    const list = h.state.positions.get(tk.owner.toLowerCase()) ?? [];
    const p = list.find((x) => x.base === base)!;
    h.state.positions.set(tk.owner.toLowerCase(), list.filter((x) => x !== p));
    closes.push(base);
    return { hash: `0x${"cd".repeat(32)}`, filledBase: p.size, avgPrice: 100, requestedBase: p.size, base, side: p.side === "long" ? "short" : "long", realizedPnl: 0, entry: p.entry, prevSize: p.size };
  };
  return { h, u, closes };
}

test("SC1: one order per slot, slot hours only, silent, capped size and touch, quiet TP/SL, a persisted job; no repeat after a restart", async () => {
  const { h, u } = setup();
  assert.equal(await h.bot.demoScheduleTick(at("2026-10-29T03:10:00Z")), "idle", "before minute 20");
  assert.equal(await h.bot.demoScheduleTick(at("2026-10-29T05:30:00Z")), "idle", "not a slot hour");
  const r = await h.bot.demoScheduleTick(at("2026-10-29T03:25:00Z"));
  assert.match(r, /^opened (long|short) (XRP|SOL|ETH)/);
  assert.equal(h.state.opens.length, 1);
  assert.equal(h.state.opens[0]!.notional, 12, "2.4 USDso x 5x");
  assert.equal(h.state.opens[0]!.opts.maxTouchPct, 0.15);
  assert.equal(h.sent.length, 0, "no chat message at all");
  const base = h.state.opens[0]!.base;
  assert.equal(u.rules[base].quiet, true);
  const j = jobs();
  assert.equal(j.length, 1);
  assert.equal(j[0].kind, "schedule"); assert.equal(j[0].base, base); assert.ok(j[0].hash && j[0].size > 0);
  const row = JSON.parse(readFileSync(`${PATHS.data}/orders.jsonl`, "utf8").trim().split("\n").at(-1)!);
  assert.equal(row.via, "schedule");
  assert.equal(await h.bot.demoScheduleTick(at("2026-10-29T03:40:00Z")), "done");
  const dir = h.bot.store["dir"];
  const h2 = makeBot(); // a "restart" sharing the data dir
  PATHS.data = dir;
  h2.bot.store = h.bot.store;
  assert.equal(await h2.bot.demoScheduleTick(at("2026-10-29T03:50:00Z")), "done", "persisted slot");
});

test("SC2: busy -> wait and retry within the hour; low equity, `until` and the off file skip", async () => {
  const { h } = setup();
  h.state.positions.set(DEMO.toLowerCase(), [{ base: "BTC", side: "long", size: 0.001, entry: 100 }]);
  assert.match(await h.bot.demoScheduleTick(at("2026-10-29T11:21:00Z")), /^wait: the demo account is busy \(BTC\)/);
  h.state.positions.clear();
  assert.match(await h.bot.demoScheduleTick(at("2026-10-29T11:40:00Z")), /^opened/, "retried in the same slot hour");
  const { h: k } = setup();
  const acct = k.bot.venue.account;
  k.bot.venue.account = async (o: string) => ({ ...(await acct(o)), equity: 1.5 });
  assert.match(await k.bot.demoScheduleTick(at("2026-10-29T19:21:00Z")), /^skip: equity 1\.50 below 2\.8/);
  assert.equal(await k.bot.demoScheduleTick(at("2026-10-29T19:30:00Z")), "done", "an equity skip uses the slot");
  k.bot.venue.account = acct;
  assert.equal(await k.bot.demoScheduleTick(at("2026-11-02T03:21:00Z")), "off");
  writeFileSync(`${PATHS.data}/demo_schedule.off`, "");
  assert.equal(await k.bot.demoScheduleTick(at("2026-10-30T03:21:00Z")), "off");
  assert.equal(k.state.opens.length, 0);
});

test("SC3: the sweep closes an overdue job (also from a fresh process), leaves an exited one, never touches a changed position", async () => {
  const { h, closes } = setup();
  await h.bot.demoScheduleTick(at("2026-10-29T03:25:00Z"));
  const base = h.state.opens[0]!.base;
  await h.bot.sandboxSweep();
  assert.equal(closes.length, 0, "not overdue yet");
  const dir = h.bot.store["dir"];
  const h2 = makeBot(); PATHS.data = dir; h2.bot.store = h.bot.store; h2.bot.venue = h.bot.venue; h2.bot.jobs = h.bot.jobs;
  await h2.bot.sandboxSweep(Date.now() + 46 * 60_000);
  assert.deepEqual(closes, [base], "closed after the hold time by a restarted bot");
  assert.equal(jobs().length, 0);
  assert.equal(h.sent.length + h2.sent.length, 0, "silent");
  // a job whose position exited by itself is dropped; a changed position is left alone
  await h.bot.demoScheduleTick(at("2026-10-29T11:25:00Z"));
  h.state.positions.clear();
  await h.bot.sandboxSweep(Date.now() + 46 * 60_000);
  assert.equal(jobs().length, 0);
  await h.bot.demoScheduleTick(at("2026-10-29T19:25:00Z"));
  const b3 = h.state.opens[2]!.base;
  const list = h.state.positions.get(DEMO.toLowerCase())!;
  list[0]!.size *= 2; // someone added to it
  await h.bot.sandboxSweep(Date.now() + 46 * 60_000);
  assert.ok(!closes.includes(b3), "a position that is no longer the job's is not closed");
  assert.equal(jobs().length, 0);
});

test("SC4: a fill whose SL could not be set is closed at the next sweep; a failed close is retried", async () => {
  const { h, u, closes } = setup();
  const open = h.bot.venue.open;
  h.bot.venue.open = async (...a: unknown[]) => { const r = await (open as (...x: unknown[]) => Promise<{ avgPrice: number }>)(...a); h.state.mark = r.avgPrice * 0.99; return r; }; // the mark already past one exit level
  await h.bot.demoScheduleTick(at("2026-10-29T03:25:00Z"));
  const base = h.state.opens[0]!.base;
  assert.ok(!(u.rules[base]?.tp && u.rules[base]?.sl), "TP or SL could not be set");
  const close = h.bot.venue.close;
  let fail = true;
  h.bot.venue.close = async (...a: unknown[]) => { if (fail) { fail = false; throw new Error("rpc down"); } return (close as (...x: unknown[]) => Promise<unknown>)(...a); };
  await h.bot.sandboxSweep();
  assert.equal(closes.length, 0, "first close failed");
  assert.equal(jobs()[0].attempts, 1);
  await h.bot.sandboxSweep();
  assert.deepEqual(closes, [base], "retried and closed");
});

test("SC5: a user's own /tp on that market is reported (un-quiet)", async () => {
  const { h, u } = setup();
  await h.bot.demoScheduleTick(at("2026-10-29T03:25:00Z"));
  const base = h.state.opens[0]!.base;
  await h.handle(msg(8684117854, `/sl ${base} 2%`));
  assert.equal(u.rules[base].quiet, undefined);
});
