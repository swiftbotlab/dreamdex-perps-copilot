// Scheduled demo trades: one capped, silent order per slot on the demo account; skips; off switch; flatten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { makeBot, msg, PATHS, POOLS } from "./_harness.ts";

POOLS.XRP = "0x2222222222222222222222222222222222222222"; // the schedule rotates XRP, SOL, ETH

const DEMO = "0x2A11e7388D1D2F9690f2636846d44b478f61bF08" as const;
const at = (iso: string) => Date.parse(iso);

function setup() {
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

test("SC1: one order per slot, in slot hours only, silent, capped size, quiet TP/SL; the slot is not repeated after a restart", async () => {
  const { h, u } = setup();
  assert.equal(await h.bot.demoScheduleTick(at("2026-10-29T03:10:00Z")), "idle", "before minute 20");
  assert.equal(await h.bot.demoScheduleTick(at("2026-10-29T05:30:00Z")), "idle", "not a slot hour");
  const r = await h.bot.demoScheduleTick(at("2026-10-29T03:25:00Z"));
  assert.match(r, /^opened (long|short) (XRP|SOL|ETH)/);
  assert.equal(h.state.opens.length, 1);
  assert.equal(h.state.opens[0]!.notional, 12, "2.4 USDso x 5x");
  assert.equal(h.sent.length, 0, "no chat message at all");
  const base = h.state.opens[0]!.base;
  assert.equal(u.rules[base].quiet, true);
  assert.ok(u.rules[base].tp && u.rules[base].sl);
  const row = JSON.parse(readFileSync(`${PATHS.data}/orders.jsonl`, "utf8").trim().split("\n").at(-1)!);
  assert.equal(row.via, "schedule");
  assert.equal(await h.bot.demoScheduleTick(at("2026-10-29T03:40:00Z")), "done");
  const dir = h.bot.store["dir"];
  const h2 = makeBot(); // a "restart" sharing the data dir
  PATHS.data = dir;
  h2.bot.store = h.bot.store;
  assert.equal(await h2.bot.demoScheduleTick(at("2026-10-29T03:50:00Z")), "done", "persisted slot");
});

test("SC2: skips when a position is open, when equity is low, after `until`, and while the off file exists", async () => {
  const { h } = setup();
  h.state.positions.set(DEMO.toLowerCase(), [{ base: "BTC", side: "long", size: 0.001, entry: 100 }]);
  assert.match(await h.bot.demoScheduleTick(at("2026-10-29T11:21:00Z")), /^skip: the demo account holds BTC/);
  h.state.positions.clear();
  const acct = h.bot.venue.account;
  h.bot.venue.account = async (o: string) => ({ ...(await acct(o)), equity: 1.5 });
  assert.match(await h.bot.demoScheduleTick(at("2026-10-29T19:21:00Z")), /^skip: equity 1\.50 below 2\.8/);
  h.bot.venue.account = acct;
  assert.equal(await h.bot.demoScheduleTick(at("2026-11-02T03:21:00Z")), "off");
  writeFileSync(`${PATHS.data}/demo_schedule.off`, "");
  assert.equal(await h.bot.demoScheduleTick(at("2026-10-30T03:21:00Z")), "off");
  assert.equal(h.state.opens.length, 0);
});

test("SC3: flatten closes a scheduled position still open, quietly; a quiet rule's auto-exit sends no message; /tp un-quiets", async () => {
  const { h, u, closes } = setup();
  await h.bot.demoScheduleTick(at("2026-10-29T03:25:00Z"));
  const { base, side } = h.state.opens[0]!;
  await h.bot.scheduledFlatten(u, base, side, h.bot.sandboxPos.get(base));
  assert.deepEqual(closes, [base]);
  assert.equal(h.sent.length, 0);
  // next slot, the TP fires through autoClose: still silent, logged as a bot exit
  assert.match(await h.bot.demoScheduleTick(at("2026-10-29T11:25:00Z")), /^opened/);
  const o2 = h.state.opens[1]!;
  await h.bot.autoClose(u, o2.base, 1, `take-profit 1 reached (mark 1)`, { kind: "tp", side: o2.side, owner: DEMO.toLowerCase(), at: Date.now() - 2000, source: "push" });
  assert.equal(h.sent.length, 0);
  // a level the user sets later is reported
  assert.match(await h.bot.demoScheduleTick(at("2026-10-29T19:25:00Z")), /^opened/);
  const o3 = h.state.opens[2]!;
  await h.handle(msg(8684117854, `/sl ${o3.base} 2%`));
  assert.equal(u.rules[o3.base].quiet, undefined);
});
