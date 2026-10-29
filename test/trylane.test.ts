// /try: one capped real order on the sandbox (demo) account for anyone; off by default; caps; fail closed.
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
  return { h, owner };
}

test("TR1: off by default: /try and its buttons send nothing", async () => {
  const { h } = setup(false);
  await h.handle(msg(700, "/try"));
  assert.match(h.to(700).at(-1)!.html, /Live trials are off right now/);
  await h.handle(cb(700, "ty:ETH:l"));
  assert.match(h.to(700).at(-1)!.html, /off right now/);
  assert.equal(h.state.opens.length, 0);
  writeFileSync(`${PATHS.data}/try.on`, ""); writeFileSync(`${PATHS.data}/try.off`, "");
  await h.handle(cb(700, "ty:ETH:l"));
  assert.equal(h.state.opens.length, 0, "try.off wins over try.on");
});

test("TR2: on: a stranger (no record, no wallet) gets one capped order on the sandbox, with a tx link; the owner's chat stays quiet", async () => {
  const { h, owner } = setup();
  await h.handle(msg(701, "/try"));
  assert.deepEqual(h.cbData(h.to(701).at(-1)), ["ty:ETH:l", "ty:ETH:s", "ty:SOL:l", "ty:SOL:s", "ty:XRP:l", "ty:XRP:s"]);
  await h.handle(cb(701, "ty:SOL:s"));
  assert.equal(h.bot.store.get(701), undefined, "no user record for the trier");
  assert.equal(h.state.opens.length, 1);
  assert.deepEqual({ ...h.state.opens[0], opts: undefined }, { owner: DEMO, base: "SOL", side: "short", notional: 12, opts: undefined });
  assert.equal(h.state.opens[0]!.opts.maxTouchPct, 0.5);
  assert.match(h.to(701).at(-1)!.html, /<b>Filled<\/b> short .* SOL .* on the sandbox account/);
  assert.equal(h.to(owner.id).length, 0, "nothing in the sandbox owner's chat");
  assert.equal(owner.rules.SOL.quiet, true);
  const row = JSON.parse(readFileSync(`${PATHS.data}/orders.jsonl`, "utf8").trim().split("\n").at(-1)!);
  assert.equal(row.via, "try");
  assert.ok(!JSON.stringify(row).includes("701"), "no Telegram id in the order log");
});

test("TR3: caps: 2 per person per day, one trial per market, at most 2 open; equity and gas floors; bad buttons ignored", async () => {
  const { h } = setup();
  await h.handle(cb(702, "ty:ETH:l"));
  await h.handle(cb(703, "ty:ETH:s"));
  assert.match(h.to(703).at(-1)!.html, /already holds a ETH-PERP trial/);
  await h.handle(cb(703, "ty:SOL:l"));
  await h.handle(cb(704, "ty:XRP:l"));
  assert.match(h.to(704).at(-1)!.html, /busy with other trials/);
  assert.equal(h.state.opens.length, 2);
  h.state.positions.clear();
  await h.handle(cb(702, "ty:XRP:l"));
  h.state.positions.clear();
  await h.handle(cb(702, "ty:SOL:l"));
  assert.match(h.to(702).at(-1)!.html, /used your 2 live trials for today/);
  h.state.positions.clear();
  const acct = h.bot.venue.account;
  h.bot.venue.account = async (o: string) => ({ ...(await acct(o)), equity: 2.5 });
  await h.handle(cb(705, "ty:ETH:l"));
  assert.match(h.to(705).at(-1)!.html, /resting \(low balance\)/);
  h.bot.venue.account = acct;
  h.bot.venue.gasBalance = async () => 0.5;
  await h.handle(cb(705, "ty:ETH:l"));
  assert.match(h.to(705).at(-1)!.html, /resting \(low gas\)/);
  const before = h.state.opens.length;
  for (const bad of ["ty:BTC:l", "ty:ETH:x", "ty:eth:l", "ty:ETH:l:1"]) await h.handle(cb(706, bad));
  assert.equal(h.state.opens.length, before);
});

test("TR4: the global daily cap holds; unreadable cap state refuses (fail closed)", async () => {
  const { h } = setup();
  writeFileSync(`${PATHS.data}/try.json`, JSON.stringify({ day: new Date().toISOString().slice(0, 10), global: 12, users: {} }));
  await h.handle(cb(710, "ty:ETH:l"));
  assert.match(h.to(710).at(-1)!.html, /Today's 12 live trials are used up/);
  writeFileSync(`${PATHS.data}/try.json`, "{not json");
  await h.handle(cb(711, "ty:ETH:l"));
  assert.match(h.to(711).at(-1)!.html, /Live trials are not available right now/);
  assert.equal(h.state.opens.length, 0);
  rmSync(`${PATHS.data}/try.json`);
  await h.handle(cb(712, "ty:ETH:l"));
  assert.equal(h.state.opens.length, 1, "a missing state file is a fresh day");
});

test("TR5: after the hold time the trial is flattened and the trier hears how it ended", async () => {
  const { h, owner } = setup();
  await h.handle(cb(720, "ty:XRP:l"));
  await h.bot.tryEnded(owner, 720, "XRP", "long", Date.now() - 1000);
  assert.equal((h.state.positions.get(DEMO.toLowerCase()) ?? []).length, 0);
  assert.match(h.to(720).at(-1)!.html, /Your XRP-PERP trial is closed @ 101\.000\. Tx <a href=/);
});
