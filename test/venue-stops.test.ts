// Venue.nativeStops: indexer rows are untrusted (only a known market's own registry and the owner's rows, well-formed
// numbers); the registry read is the truth; a market without a valid registry never breaks the account's view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { venueMod } from "./_harness.ts";

const OWNER = "0x00000000000000000000000000000000000000c1";
const R1 = "0x00000000000000000000000000000000000000a1";
const P1 = "0x00000000000000000000000000000000000000b1";
const PBAD = "0x00000000000000000000000000000000000000b2";
const mk = (display: string, pool: string, reg: string) => ({ display, symbol: display, info: { poolAddress: pool, stopRegistry: reg, baseDecimals: 18, marginBank: "0x00000000000000000000000000000000000000d1", minQuantity: "1000" } });
const row = (o: Record<string, unknown> = {}) => ({ registry: R1, orderIdRaw: "1", owner: OWNER, isBid: false, quantity: "0", triggerPrice: "1900000000000000000000", triggerOperator: 1, orderType: 1, siblingOrderId: null, intent: "reduceOnly", market: { poolAddress: P1 }, ...o });

function venue(rows: unknown[], reads: (refs: { registry: string; orderId: string }[]) => unknown[]) {
  const v = new venueMod.Venue() as any;
  const eth = mk("ETH-PERP", P1, R1), bad = mk("BAD-PERP", PBAD, undefined as unknown as string); // no stop registry at all
  v.markets = new Map([["ETH", eth], ["BAD", bad]]);
  v.byPool = new Map([[P1, eth], [PBAD, bad]]);
  v.byRegistry = new Map([[R1, eth]]);
  v.exchange = { client: { listPerpStopOrders: async () => rows, getPerpStopOrders: async (refs: { registry: string; orderId: string }[]) => reads(refs) } };
  return v as InstanceType<typeof venueMod.Venue>;
}
const present = (o: Record<string, unknown> = {}) => ({ status: "present", order: { owner: OWNER, isBid: false, quantity: 0n, triggerPrice: 1_900n * 10n ** 18n, triggerOperator: 1, orderType: 1, siblingOrderId: 0n, intent: "reduceOnly", ...o } });

test("VS1: garbage and foreign indexer rows are skipped; a market without a valid registry does not throw", async () => {
  const v = venue([
    row(),
    row({ orderIdRaw: "2", market: { poolAddress: PBAD }, registry: "garbage" }), // market with no valid registry
    row({ orderIdRaw: "3", owner: "0x00000000000000000000000000000000000000ee" }),  // someone else's
    row({ orderIdRaw: "4", quantity: "-5" }),                                         // bad number
    row({ orderIdRaw: "5", registry: "0x00000000000000000000000000000000000000a9" }), // not this market's registry
    row({ orderIdRaw: "x<b>" }),
    row({ orderIdRaw: "6", triggerOperator: 7 }),
  ], (refs) => refs.map(() => present()));
  const out = await v.nativeStops(OWNER as `0x${string}`);
  assert.deepEqual(out.map((s) => s.orderId), ["1"]);
  assert.equal(out[0]!.base, "ETH");
  assert.equal(out[0]!.onChain, true);
});

test("VS2: the registry read wins; absent = not live; a failed read keeps the indexer row, labelled; log ids are confirmed on chain", async () => {
  const v = venue([row(), row({ orderIdRaw: "2" }), row({ orderIdRaw: "3", quantity: "2000000000000000000" })], (refs) => refs.map((r) =>
    r.orderId === "1" ? present({ quantity: 5n * 10n ** 17n, siblingOrderId: 9n }) : r.orderId === "2" ? { status: "absent" } : r.orderId === "77" ? present({ triggerOperator: 0, triggerPrice: 2_100n * 10n ** 18n }) : { status: "failed" }));
  const out = await v.nativeStops(OWNER as `0x${string}`, [{ registry: R1 as `0x${string}`, orderId: "77" }, { registry: "0x00000000000000000000000000000000000000a9" as `0x${string}`, orderId: "88" }]);
  const by = Object.fromEntries(out.map((s) => [s.orderId, s]));
  assert.deepEqual(Object.keys(by).sort(), ["1", "3", "77"]);
  assert.equal(by["1"]!.qty, 0.5); assert.equal(by["1"]!.linked, true);
  assert.equal(by["3"]!.onChain, false); assert.equal(by["3"]!.qty, 2);
  assert.equal(by["77"]!.onChain, true); assert.equal(by["77"]!.trigger, 2100); assert.equal(by["77"]!.op, 0);
});
