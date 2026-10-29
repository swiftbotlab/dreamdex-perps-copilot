// Chain-held stops (/stops): classification, the health checks from feedback reports 28/29, the bot command,
// the /positions mirror, and the stop-health alerts (once per stop and problem; fired / dropped notices).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMarket, stopKind, warnKey, type NativeStop } from "../src/stops.ts";
import { addr, cb, makeBot, msg } from "./_harness.ts";

const stop = (o: Partial<NativeStop> = {}): NativeStop => ({
  id: "0x00000000000000000000000000000000000000aa_1", registry: "0x00000000000000000000000000000000000000aa", orderId: "1", base: "ETH",
  isBid: false, qty: 0, trigger: 1900, op: 1, market: true, linked: false, reduceOnly: true, onChain: true, ...o,
});
const long = { base: "ETH", side: "long" as const, size: 2, mark: 2000 };
const cap = (o: Partial<{ position: number; pendingBid: number; pendingAsk: number; effective: number }> = {}) => ({ position: 2, pendingBid: 0, pendingAsk: 0, effective: 2, ...o });

test("S1: TP/SL kind from the trigger direction and the closing side", () => {
  assert.equal(stopKind(stop({ isBid: false, op: 1 }), "long"), "SL");   // sell at or below: stop-loss on a long
  assert.equal(stopKind(stop({ isBid: false, op: 0 }), "long"), "TP");
  assert.equal(stopKind(stop({ isBid: true, op: 0 }), "short"), "SL");   // buy at or above: stop-loss on a short
  assert.equal(stopKind(stop({ isBid: true, op: 1 }), "short"), "TP");
  assert.equal(stopKind(stop({ isBid: true, op: 1 }), "long"), "stop", "a buy cannot reduce a long");
});

test("S2: a healthy whole-position SL is OK and says what it closes", () => {
  const r = checkMarket("ETH", long, [stop()], cap(), 0.004);
  assert.equal(r.level, "ok");
  assert.match(r.lines[0]!.text, /^SL 1,900\.00 \(market, whole position\) · 5\.00% from the mark: OK, closes 2 ETH when it fires$/);
});

test("S3 (report 28): resting closing-side orders cut the stop to the reducing capacity: partly, or to nothing", () => {
  const part = checkMarket("ETH", long, [stop()], cap({ pendingAsk: 1.5, effective: 0.5 }), 0.004);
  assert.equal(part.level, "warn");
  assert.match(part.lines[0]!.text, /will close only 0\.5 of 2 ETH\. Your resting sell orders \(1\.5 ETH\) reserve the rest/);
  assert.equal(part.lines[0]!.willClose, 0.5);
  const none = checkMarket("ETH", long, [stop()], cap({ pendingAsk: 2, effective: 0 }), 0.004);
  assert.match(none.lines[0]!.text, /will close NOTHING when it fires\. Your resting sell orders on ETH-PERP \(2 ETH\).*ReduceOnlyBelowMinQty/);
  const dust = checkMarket("ETH", long, [stop()], cap({ pendingAsk: 1.998, effective: 0.002 }), 0.004);
  assert.match(dust.lines[0]!.text, /NOTHING/, "capacity below the pool minimum = nothing placed");
  // a short is cut by resting BUY orders
  const short = checkMarket("ETH", { ...long, side: "short" }, [stop({ isBid: true, op: 0, trigger: 2100 })], cap({ position: -2, pendingBid: 1, effective: 1 }), 0.004);
  assert.match(short.lines[0]!.text, /SL 2,100\.00 .*will close only 1 of 2 ETH\. Your resting buy orders \(1 ETH\)/);
});

test("S4: fixed-size stop smaller than the grown position; wrong side; no position; opening stop; linked pair note", () => {
  const fixed = checkMarket("ETH", long, [stop({ qty: 0.5 })], cap(), 0.004);
  assert.match(fixed.lines[0]!.text, /covers 0\.5 of your 2 ETH\. Its size was fixed when it was armed; the other 1\.5 has no SL/);
  const wrong = checkMarket("ETH", long, [stop({ isBid: true })], cap(), 0.004);
  assert.match(wrong.lines[0]!.text, /it buys, which cannot reduce your long; it places nothing if it fires/);
  const nopos = checkMarket("ETH", undefined, [stop()], undefined, 0.004);
  assert.match(nopos.lines[0]!.text, /no open ETH-PERP position, so it places nothing if it fires and still spends its STT fee/);
  const opening = checkMarket("ETH", long, [stop({ reduceOnly: false })], cap(), 0.004);
  assert.equal(opening.lines[0]!.level, "note");
  const pair = checkMarket("ETH", long, [stop({ linked: true }), stop({ id: "x_2", orderId: "2", op: 0, trigger: 2200, linked: true })], cap(), 0.004);
  assert.equal(pair.level, "ok");
  assert.ok(pair.notes.some((n) => /if one leg fills only partly, the registry cancels the other leg/.test(n)));
  const bare = checkMarket("ETH", long, [], undefined, 0.004);
  assert.ok(bare.notes.some((n) => /No chain-held TP\/SL on this long/.test(n)));
  const tpOnly = checkMarket("ETH", long, [stop({ op: 0, trigger: 2200 })], cap(), 0.004);
  assert.ok(tpOnly.notes.some((n) => /take-profit but no chain-held stop-loss/.test(n)));
  assert.notEqual(warnKey(fixed.lines[0]!), warnKey(wrong.lines[0]!));
});

test("S5: /stops works for anyone with an address (read only), validates it, and is rate limited", async () => {
  const h = makeBot();
  const A = addr(0xabc);
  h.state.positions.set(A.toLowerCase(), [{ base: "ETH", side: "long", size: 2, entry: 100 }]);
  h.state.stops = [stop({ trigger: 95 })];
  h.state.cap = { position: 2, pendingBid: 0, pendingAsk: 1.5, effective: 0.5 };
  await h.handle(msg(70, `/stops ${A}`));
  const out = h.to(70).at(-1)!.html;
  assert.equal(h.bot.store.get(70), undefined, "no user record");
  assert.match(out, /<b>Chain-held stops<\/b> for <a href=/);
  assert.match(out, /fires them itself, even when no bot is running/);
  assert.match(out, /<b>ETH-PERP long 2<\/b> · mark 100/);
  assert.match(out, /⚠️ SL 95\.000 .*will close only 0\.5 of 2 ETH/);
  assert.match(out, /1 chain-held stop, 1 warning/);
  for (const bad of ["0x12", "<b>", "0x0000000000000000000000000000000000000000"]) {
    await h.handle(msg(71, `/stops ${bad}`));
    assert.match(h.to(71).at(-1)!.html, /for any dreamDEX account \(read only\)/);
  }
  await h.handle(msg(72, "/stops"));
  assert.match(h.to(72).at(-1)!.html, /Linked users can send just \/stops/);
  for (let i = 0; i < 3; i++) await h.handle(msg(70, `/stops ${A}`));
  await h.handle(msg(70, `/stops ${A}`));
  assert.match(h.to(70).at(-1)!.html, /a few times a minute/);
});

test("S6: /positions shows the chain-held layer next to the bot-side one; a failed read says so", async () => {
  const h = makeBot();
  const O = addr(0xdef);
  const u = h.addUser(80, O);
  u.rules.ETH = { side: "long", tp: 120, setAt: 0 };
  h.state.positions.set(O.toLowerCase(), [{ base: "ETH", side: "long", size: 2, entry: 100 }]);
  h.state.stops = [stop({ trigger: 95 })];
  h.state.cap = { position: 2, pendingBid: 0, pendingAsk: 0, effective: 2 };
  await h.handle(msg(80, "/positions"));
  let out = h.to(80).at(-1)!.html;
  assert.match(out, /chain-held: SL 95\.000 ✅/);
  assert.match(out, /bot-side: TP 120\.000/);
  h.state.stops = [];
  await h.handle(msg(80, "/positions"));
  assert.match(h.to(80).at(-1)!.html, /chain-held TP\/SL: none \(only the bot-side exits below\)/);
  h.bot.venue.nativeStops = async () => { throw new Error("indexer down"); };
  await h.handle(msg(80, "/positions"));
  out = h.to(80).at(-1)!.html;
  assert.match(out, /chain-held TP\/SL: could not be read right now/);
  assert.match(out, /PnL/, "the rest of /positions still works");
});

test("S7: stop-health alerts: a warning is sent once (persisted), a fired stop and a dropped stop are reported", async () => {
  const h = makeBot();
  const O = addr(0x123);
  h.addUser(90, O);
  h.state.positions.set(O.toLowerCase(), [{ base: "ETH", side: "long", size: 2, entry: 100 }]);
  const sl = stop({ trigger: 95 });
  const tp = stop({ id: "0x00000000000000000000000000000000000000aa_2", orderId: "2", op: 0, trigger: 110 });
  h.state.stops = [sl, tp];
  h.state.cap = { position: 2, pendingBid: 0, pendingAsk: 2, effective: 0 };
  await h.bot.stopHealthRound();
  const warns = h.to(90).filter((s) => /Stop health/.test(s.html));
  assert.equal(warns.length, 1, "one message per market");
  assert.equal((warns[0]!.html.match(/will close NOTHING/g) ?? []).length, 2, "both stops in it");
  assert.deepEqual(h.cbData(warns[0]), ["sk"]);
  await h.bot.stopHealthRound();
  assert.equal(h.to(90).filter((s) => /Stop health/.test(s.html)).length, 1, "not repeated");
  assert.equal(Object.keys(h.bot.store.get(90).stopWarned).length, 2, "persisted");
  // The SL fires on chain (TRIGGERED), the TP is dropped (TRIGGER_FAILED, below min qty).
  h.state.stops = [];
  h.state.stopRows = [
    { registry: sl.registry, orderIdRaw: "1", status: "TRIGGERED", dropReason: null, cancelReason: null },
    { registry: tp.registry, orderIdRaw: "2", status: "TRIGGER_FAILED", dropReason: "ReduceOnlyBelowMinQty", cancelReason: null },
  ];
  await h.bot.stopHealthRound();
  const tail = h.to(90).slice(-2).map((s) => s.html);
  assert.ok(tail.some((t) => /✅ Your chain-held SL 95\.000 on ETH-PERP fired: the chain placed its closing order by itself/.test(t)));
  assert.ok(tail.some((t) => /⚠️ Your chain-held TP 110\.000 on ETH-PERP fired but placed nothing: what it could close was below the minimum order size/.test(t)));
  // A raw indexer value never reaches the message.
  h.state.stops = [stop({ id: "0x00000000000000000000000000000000000000aa_3", orderId: "3" })];
  await h.bot.stopHealthRound();
  h.state.stops = [];
  h.state.stopRows = [{ registry: sl.registry, orderIdRaw: "3", status: "TRIGGER_FAILED", dropReason: "<script>x</script>", cancelReason: null }];
  await h.bot.stopHealthRound();
  assert.match(h.to(90).at(-1)!.html, /fired but placed nothing: it was dropped\./);
  assert.ok(!h.sent.some((s) => s.html.includes("<script>")));
});

test("S8: the Show my stops button works for a linked user", async () => {
  const h = makeBot();
  const O = addr(0x456);
  h.addUser(95, O);
  await h.handle(cb(95, "sk"));
  assert.match(h.to(95).at(-1)!.html, /No open positions and no pending chain-held stops/);
});

test("S9: /stops says when the indexer lags; ids from the registry logs reach the stop read; fresh refs expire", async () => {
  const h = makeBot();
  const O = addr(0x789);
  h.addUser(96, O);
  h.state.lag = 151;
  await h.handle(msg(96, "/stops"));
  assert.match(h.to(96).at(-1)!.html, /indexer is 151 s behind the chain .*\(for your linked account the bot also reads the registries' own logs every minute/);
  await h.handle(msg(97, `/stops ${O}`));
  assert.doesNotMatch(h.to(97).at(-1)!.html, /for your linked account/, "not the viewer's account");
  h.state.lag = 3;
  await h.handle(msg(96, "/stops"));
  assert.doesNotMatch(h.to(96).at(-1)!.html, /behind the chain/);
  const seen: unknown[][] = [];
  h.bot.venue.recentStopIds = async (owners: string[]) => new Map(owners.map((o) => [o.toLowerCase(), [{ registry: "0x00000000000000000000000000000000000000aa", orderId: "77" }]]));
  h.bot.venue.nativeStops = async (_o: string, refs: unknown[] = []) => { seen.push(refs); return []; };
  await h.bot.stopHealthRound();
  assert.deepEqual(seen.at(-1), [{ registry: "0x00000000000000000000000000000000000000aa", orderId: "77" }]);
  for (const v of h.bot.stopLogs.get(O.toLowerCase()).values()) v.at -= 16 * 60_000;
  h.bot.venue.recentStopIds = async () => new Map();
  await h.bot.stopHealthRound();
  assert.deepEqual(seen.at(-1), [], "expired after 15 minutes");
});

test("S10 (review): a failed alert send is retried next pass; /stops on your own account skips the global limit; logs only for your own account", async () => {
  const h = makeBot();
  const O = addr(0x999);
  h.addUser(98, O);
  h.state.positions.set(O.toLowerCase(), [{ base: "ETH", side: "long", size: 2, entry: 100 }]);
  h.state.stops = [stop({ trigger: 95 })];
  h.state.cap = { position: 2, pendingBid: 0, pendingAsk: 2, effective: 0 };
  h.blocked.add(98);
  await h.bot.stopHealthRound();
  assert.equal(Object.keys(h.bot.store.get(98).stopWarned ?? {}).length, 0, "not marked: Telegram refused it");
  h.blocked.delete(98); delete h.bot.store.get(98).blockedAt;
  await h.bot.stopHealthRound();
  assert.equal(h.to(98).filter((s) => /Stop health/.test(s.html)).length, 1, "sent on the next pass");
  // fill the global /stops budget with other people's lookups
  for (let i = 0; i < 70; i++) h.bot.buckets.allow("stops:all", 60, 60_000);
  await h.handle(msg(98, "/stops"));
  assert.match(h.to(98).at(-1)!.html, /Chain-held stops/, "own account still answered");
  await h.handle(msg(99, `/stops ${O}`));
  assert.match(h.to(99).at(-1)!.html, /a few times a minute/, "another account waits on the global limit");
  // log-found ids reach only the owner's own view
  const calls: unknown[][] = [];
  h.bot.venue.nativeStops = async (_o: string, refs: unknown[] = []) => { calls.push(refs); return []; };
  h.bot.addRecent(O, [{ registry: "0x00000000000000000000000000000000000000aa", orderId: "5" }]);
  h.bot.stopCache.clear();
  await h.bot.stopReports(O, { withLogs: false });
  await h.bot.stopReports(O, { withLogs: true });
  assert.deepEqual(calls.map((c) => c.length), [0, 1]);
});

test("S11 (review): a relink starts stop tracking afresh (no 'fired' news about the old account); opening stops are not tracked", async () => {
  const h = makeBot();
  const A = addr(0xa1), B = addr(0xb2);
  const u = h.addUser(120, A);
  h.state.positions.set(A.toLowerCase(), [{ base: "ETH", side: "long", size: 2, entry: 100 }]);
  h.state.cap = { position: 2, pendingBid: 0, pendingAsk: 0, effective: 2 };
  h.state.stops = [stop({ trigger: 95 }), stop({ id: "0x00000000000000000000000000000000000000aa_9", orderId: "9", reduceOnly: false })];
  await h.bot.stopHealthRound();
  u.owner = B; h.bot.store.save();
  h.state.stops = [];
  h.state.stopRows = [{ registry: "0x00000000000000000000000000000000000000aa", orderIdRaw: "1", status: "TRIGGERED", dropReason: null, cancelReason: null }];
  await h.bot.stopHealthRound();
  assert.ok(!h.to(120).some((s) => /fired/.test(s.html)), "no news about the old account");
  u.owner = A; h.bot.store.save();
  h.state.stops = [stop({ id: "0x00000000000000000000000000000000000000aa_9", orderId: "9", reduceOnly: false })];
  await h.bot.stopHealthRound();
  h.state.stops = [];
  h.state.stopRows = [{ registry: "0x00000000000000000000000000000000000000aa", orderIdRaw: "9", status: "TRIGGERED", dropReason: null, cancelReason: null }];
  await h.bot.stopHealthRound();
  assert.ok(!h.to(120).some((s) => /fired/.test(s.html)), "an opening stop is not reported as a TP/SL");
});

test("S12 (review): /stops keeps under Telegram's limit with many stops, whole markets only", async () => {
  const h = makeBot();
  const O = addr(0xc3);
  const many: NativeStop[] = [];
  for (let i = 0; i < 30; i++) many.push(stop({ id: `0x00000000000000000000000000000000000000aa_${i}`, orderId: String(i), base: i % 2 ? "ETH" : "SOL", trigger: 90 + i }));
  h.state.stops = many;
  await h.handle(msg(130, `/stops ${O}`));
  const out = h.to(130).at(-1)!.html;
  assert.ok(out.length < 4_000, `length ${out.length}`);
  assert.match(out, /… and \d+ more stops on (ETH|SOL)-PERP/);
  assert.equal((out.match(/<b>/g) ?? []).length, (out.match(/<\/b>/g) ?? []).length, "tags balanced");
});
