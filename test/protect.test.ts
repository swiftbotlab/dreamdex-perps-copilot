// Protection engine against a fake venue: TP/SL/guard close once, warnings are rate limited,
// a failed close backs off instead of hammering the chain on every push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Protector } from "../src/protect.ts";
import { Store } from "../src/store.ts";

const POOL = "0xd6cb1dd58580b84d76068ac21594219ce03aeddf";
function setup(pos: { side: "long" | "short"; entry: number; liq?: number }) {
  const store = new Store(mkdtempSync(`${tmpdir()}/ddmvp-test-`));
  const u = store.add({ id: 7, created: 0, keyAddress: "0x0000000000000000000000000000000000000001", key: { v: 1, iv: "", ct: "", tag: "" } });
  u.owner = "0x0000000000000000000000000000000000000002";
  const market = { display: "ETH-PERP", info: { poolAddress: POOL } };
  const venue = {
    account: async () => ({ positions: [{ base: "ETH", pool: POOL, side: pos.side, size: 0.01, entry: pos.entry, mark: pos.entry, upnl: 0, notional: 20, liq: pos.liq }] }),
    marketByPool: (p: string) => (p.toLowerCase() === POOL ? market : undefined),
    baseOf: () => "ETH",
    mark: async () => pos.entry,
  };
  const closes: string[] = [], warns: string[] = [];
  let failNext = false;
  const p = new Protector(venue as never, store, async (_u, base, _f, reason, o) => { if (failNext) { failNext = false; throw new Error("x"); } closes.push(`${base}:${o.kind}:${o.limit ?? "mkt"}:${reason}`); }, async (_u, _b, t) => { warns.push(t); }, () => {});
  (p as unknown as { subscribe: () => Promise<void> }).subscribe = async () => {}; // no network in tests
  return { store, u, p, closes, warns, fail: () => { failNext = true; } };
}

test("take-profit closes once when the pushed mark crosses it", async () => {
  const s = setup({ side: "long", entry: 2000, liq: 1500 });
  s.u.rules.ETH = { side: "long", tp: 2100, sl: 1900, setAt: 0 };
  await s.p.refreshUser(s.u);
  await s.p.onMark(POOL, 2050);
  assert.equal(s.closes.length, 0);
  await s.p.onMark(POOL, 2100.5);
  assert.equal(s.closes.length, 1);
  assert.match(s.closes[0]!, /^ETH:tp:2100:take-profit/); // TP exits with an IOC limited to the TP price
});

test("stop-loss on a short fires above the level", async () => {
  const s = setup({ side: "short", entry: 2000, liq: 2600 });
  s.u.rules.ETH = { side: "short", sl: 2050, setAt: 0 };
  await s.p.refreshUser(s.u);
  await s.p.onMark(POOL, 2049);
  assert.equal(s.closes.length, 0);
  await s.p.onMark(POOL, 2051);
  assert.match(s.closes[0]!, /^ETH:sl:mkt:stop-loss/); // SL exits at market
});

test("liquidation warning is sent once per cooldown; guard closes", async () => {
  const s = setup({ side: "long", entry: 2000, liq: 1900 });
  await s.p.refreshUser(s.u);
  await s.p.onMark(POOL, 2000); // 5% away, default warn 10%
  await s.p.onMark(POOL, 1999);
  assert.equal(s.warns.length, 1);
  s.u.guardPct = 3;
  await s.p.onMark(POOL, 1955); // 2.8% away
  assert.equal(s.closes.length, 1);
  assert.match(s.closes[0]!, /liquidation guard/);
});

test("a failed close backs off instead of retrying on every push", async () => {
  const s = setup({ side: "long", entry: 2000, liq: 1500 });
  s.u.rules.ETH = { side: "long", tp: 2100, setAt: 0 };
  await s.p.refreshUser(s.u);
  s.fail();
  await s.p.onMark(POOL, 2200);
  await s.p.onMark(POOL, 2201);
  await s.p.onMark(POOL, 2202);
  assert.equal(s.closes.length, 0);
});

test("rules for a market without a position are dropped", async () => {
  const s = setup({ side: "long", entry: 2000 });
  s.u.rules.BTC = { side: "long", tp: 1, setAt: 0 };
  await s.p.refreshUser(s.u);
  assert.equal(s.u.rules.BTC, undefined);
});

test("store: torn users.json falls back to the .bak copy; unlinked users are pruned", async () => {
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(`${tmpdir()}/ddmvp-store-`);
  const s1 = new Store(dir);
  s1.add({ id: 1, created: 0, keyAddress: "0x0000000000000000000000000000000000000001", key: { v: 1, iv: "", ct: "", tag: "" } });
  const u2 = s1.add({ id: 2, created: 0, keyAddress: "0x0000000000000000000000000000000000000002", key: { v: 1, iv: "", ct: "", tag: "" } });
  u2.owner = "0x0000000000000000000000000000000000000003"; s1.save();
  writeFileSync(`${dir}/users.json`, "{\"users\": {\"1\":"); // torn write
  const s2 = new Store(dir);
  assert.equal(s2.count(), 2);
  assert.equal(s2.pruneUnlinked(1_000, 10_000), 1);
  assert.equal(s2.get(1), undefined);
  assert.ok(s2.get(2));
});
