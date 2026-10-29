// /try: one capped real order on the sandbox (demo) account for anyone; off by default; caps; fail closed;
// memory checks before any chain read; trials stay out of the scheduled slots; the trier hears how it ended.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { cb, makeBot, msg, PATHS, POOLS } from "./_harness.ts";

POOLS.XRP = "0x2222222222222222222222222222222222222222";
const DEMO = "0x2A11e7388D1D2F9690f2636846d44b478f61bF08" as const;

function setup(on = true) {
  const h = makeBot();
  const owner = h.addUser(8684117854, DEMO);
  h.bot.venue.close = async (tk: { owner: string }, base: string) => {
    const list = h.state.positions.get(tk.owner.toLowerCase()) ?? [];
    const p = list.find((x) => x.base === base)!;
    h.state.positions.set(tk.owner.toLowerCase(), list.filter((x) => x !== p));
    return { hash: `0x${"cd".repeat(32)}`, filledBase: p.size, avgPrice: 101, requestedBase: p.size, base, side: p.side === "long" ? "short" : "long", realizedPnl: 0, entry: p.entry, prevSize: p.size };
  };
  if (on) writeFileSync(`${PATHS.data}/try.on`, "");
  // outside the scheduled slot hours unless a test says otherwise
  const realNow = Date.now;
  return { h, owner, realNow };
}
const clearBuckets = (h: ReturnType<typeof makeBot>) => { h.bot.buckets = new (h.bot.buckets.constructor)(); };

test("TR1: off by default: /try and its buttons send nothing; try.off wins", async () => {
  const { h } = setup(false);
  await h.handle(msg(700, "/try"));
  assert.match(h.to(700).at(-1)!.html, /Live trials are off right now/);
  await h.handle(cb(700, "ty:ETH:l"));
  assert.match(h.to(700).at(-1)!.html, /off right now/);
  writeFileSync(`${PATHS.data}/try.on`, ""); writeFileSync(`${PATHS.data}/try.off`, "");
  await h.handle(cb(701, "ty:ETH:l"));
  assert.equal(h.state.opens.length, 0);
});

test("TR2: on: a stranger gets one capped order on the sandbox with a tx link; owner's chat stays quiet; no id in the order log", async () => {
  const { h, owner } = setup();
  h.bot.trySandboxBusy = () => undefined; // not near a scheduled slot
  await h.handle(msg(701, "/try"));
  assert.deepEqual(h.cbData(h.to(701).at(-1)), ["ty:ETH:l", "ty:ETH:s", "ty:SOL:l", "ty:SOL:s", "ty:XRP:l", "ty:XRP:s"]);
  await h.handle(cb(701, "ty:SOL:s"));
  assert.equal(h.bot.store.get(701), undefined, "no user record for the trier");
  assert.equal(h.state.opens.length, 1);
  assert.equal(h.state.opens[0]!.notional, 12);
  assert.equal(h.state.opens[0]!.opts.maxTouchPct, 0.15);
  assert.match(h.to(701).at(-1)!.html, /<b>Filled<\/b> short .* SOL .* on the sandbox account/);
  assert.equal(h.to(owner.id).length, 0, "nothing in the sandbox owner's chat");
  const row = JSON.parse(readFileSync(`${PATHS.data}/orders.jsonl`, "utf8").trim().split("\n").at(-1)!);
  assert.equal(row.via, "try");
  assert.ok(!JSON.stringify(row).includes("701"));
});

test("TR3: caps: 2 per person per day, one trial per market (from memory, no chain read), at most 2 open, floors, cooldown, global per-minute", async () => {
  const { h } = setup();
  const realBusy = h.bot.trySandboxBusy.bind(h.bot);
  h.bot.trySandboxBusy = (b: string) => realBusy(b, Date.parse("2026-10-29T06:00:00Z"));
  await h.handle(cb(702, "ty:ETH:l"));
  const reads = h.state.accountCalls;
  await h.handle(cb(703, "ty:ETH:s"));
  assert.match(h.to(703).at(-1)!.html, /already holds a ETH-PERP trial/);
  assert.equal(h.state.accountCalls, reads, "refused from memory: no chain read");
  await h.handle(cb(704, "ty:SOL:l"));
  await h.handle(cb(705, "ty:XRP:l"));
  assert.match(h.to(705).at(-1)!.html, /busy with other trials/);
  assert.equal(h.state.opens.length, 2);
  await h.handle(cb(704, "ty:XRP:l"));
  assert.match(h.to(704).at(-1)!.html, /One moment between trials/, "30 s cooldown per person");
  // trials end, caps
  h.state.positions.clear(); await h.bot.sandboxSweep(); clearBuckets(h);
  await h.handle(cb(702, "ty:XRP:l"));
  h.state.positions.clear(); await h.bot.sandboxSweep(); clearBuckets(h);
  await h.handle(cb(702, "ty:SOL:l"));
  assert.match(h.to(702).at(-1)!.html, /used your 2 live trials for today/);
  h.state.positions.clear(); await h.bot.sandboxSweep(); clearBuckets(h);
  const acct = h.bot.venue.account;
  h.bot.venue.account = async (o: string) => ({ ...(await acct(o)), equity: 2.9 });
  await h.handle(cb(706, "ty:ETH:l"));
  assert.match(h.to(706).at(-1)!.html, /resting \(low balance\)/, "trials stop at 3.0, above the schedule's floor");
  h.bot.venue.account = acct; clearBuckets(h);
  h.bot.venue.gasBalance = async () => 0.5;
  await h.handle(cb(706, "ty:ETH:l"));
  assert.match(h.to(706).at(-1)!.html, /resting \(low gas\)/);
  h.bot.venue.gasBalance = async () => 5; clearBuckets(h);
  for (let i = 0; i < 5; i++) h.bot.buckets.allow("try:all", 4, 60_000);
  await h.handle(cb(707, "ty:ETH:l"));
  assert.match(h.to(707).at(-1)!.html, /Lots of trials right now/);
  const before = h.state.opens.length;
  for (const bad of ["ty:BTC:l", "ty:ETH:x", "ty:eth:l", "ty:ETH:l:1"]) await h.handle(cb(708, bad));
  assert.equal(h.state.opens.length, before);
});

test("TR4: the global daily cap holds; unreadable cap state refuses (fail closed); a missing file is a fresh day", async () => {
  const { h } = setup();
  h.bot.trySandboxBusy = () => undefined;
  writeFileSync(`${PATHS.data}/try.json`, JSON.stringify({ day: new Date().toISOString().slice(0, 10), global: 12, users: {} }));
  await h.handle(cb(710, "ty:ETH:l"));
  assert.match(h.to(710).at(-1)!.html, /Today's 12 live trials are used up/);
  writeFileSync(`${PATHS.data}/try.json`, "{not json");
  await h.handle(cb(711, "ty:ETH:l"));
  assert.match(h.to(711).at(-1)!.html, /Live trials are not available right now/);
  assert.equal(h.state.opens.length, 0);
  rmSync(`${PATHS.data}/try.json`);
  await h.handle(cb(712, "ty:ETH:l"));
  assert.equal(h.state.opens.length, 1);
});

test("TR5: trials stay out of scheduled slots: refused from minute 15 of a slot hour until the slot ran, and while a scheduled trade is open", async () => {
  const { h } = setup();
  assert.match(h.bot.trySandboxBusy("ETH", Date.parse("2026-10-29T11:16:00Z")), /about to run its scheduled trade/);
  assert.equal(h.bot.trySandboxBusy("ETH", Date.parse("2026-10-29T11:10:00Z")), undefined);
  await h.bot.demoScheduleTick(Date.parse("2026-10-29T11:25:00Z"));
  assert.match(h.bot.trySandboxBusy("ETH", Date.parse("2026-10-29T11:30:00Z")), /running its scheduled trade/);
});

test("TR6: the trier hears how the trial ended: by its exit, or after the hold time by the sweep (also after a restart)", async () => {
  const { h } = setup();
  h.bot.trySandboxBusy = () => undefined;
  await h.handle(cb(720, "ty:XRP:l"));
  await h.bot.sandboxSweep(Date.now() + 11 * 60_000);
  assert.equal((h.state.positions.get(DEMO.toLowerCase()) ?? []).length, 0, "flattened");
  assert.match(h.to(720).at(-1)!.html, /Your XRP-PERP trial is closed @ 101\.000\. Tx <a href=/);
  clearBuckets(h);
  await h.handle(cb(721, "ty:SOL:l"));
  h.state.positions.clear(); // its TP fired (no close row in this fake log)
  await h.bot.sandboxSweep();
  assert.match(h.to(721).at(-1)!.html, /Your SOL-PERP trial has ended|Your SOL-PERP trial is closed/);
});

test("TR7: entry points appear only when trials are on: /demo and /start buttons, and the tr button opens the picker", async () => {
  const off = setup(false);
  await off.h.handle(msg(730, "/demo"));
  assert.ok(!off.h.cbData(off.h.to(730).at(-1)).includes("tr"));
  const { h } = setup();
  await h.handle(msg(731, "/demo"));
  assert.ok(h.cbData(h.to(731).at(-1)).includes("tr"));
  await h.handle(msg(732, "/start"));
  assert.ok(h.cbData(h.to(732).at(-1)).includes("tr"));
  await h.handle(cb(733, "tr"));
  assert.deepEqual(h.cbData(h.to(733).at(-1)), ["ty:ETH:l", "ty:ETH:s", "ty:SOL:l", "ty:SOL:s", "ty:XRP:l", "ty:XRP:s"]);
});
