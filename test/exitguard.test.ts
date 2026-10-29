// ExitGuard reader (src/exitguard.ts) and its lines in /stops and /positions. The bot only READS the chain-fired stop:
// it recognises an EIP-7702 account by its exact designator for our implementation and never calls any other code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeLast, decodeStop, delegationTarget, guardLine, lastLine, readGuard } from "../src/exitguard.ts";
import { EXITGUARD_IMPL } from "../src/config.ts";
import { addr, makeBot, msg, POOLS } from "./_harness.ts";

const IMPL = EXITGUARD_IMPL;
const designator = (a: string) => `0xef0100${a.slice(2).toLowerCase()}`;
const rawStop = (o: Record<string, unknown> = {}) => ({
  pool: POOLS.ETH, isLong: true, slippageBps: 100, failures: 0, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
  slPrice: 95n * 10n ** 18n, tpPrice: 0n, scheduleSubId: 23423786n, tickSubId: 23423787n, checksLeft: 19_000, checks: 1_000,
  lastCheckBlock: 35_990_000n, lastMark: 99n * 10n ** 18n, nextWakeMs: 1_793_252_000_000n, intervalMs: 5_000, armedAtBlock: 35_983_384, ...o,
});

test("G1: the EIP-7702 designator is parsed exactly (23 bytes, 0xef0100 prefix), anything else is not delegated", () => {
  assert.equal(delegationTarget(designator(IMPL)), IMPL.toLowerCase());
  assert.equal(delegationTarget(designator(IMPL).toUpperCase().replace("0XEF0100", "0xef0100")), IMPL.toLowerCase());
  assert.equal(delegationTarget(undefined), undefined);
  assert.equal(delegationTarget("0x"), undefined);
  assert.equal(delegationTarget(`0xef0100${"00".repeat(19)}`), undefined, "too short");
  assert.equal(delegationTarget(`${designator(IMPL)}00`), undefined, "too long");
  assert.equal(delegationTarget(`0xef0101${IMPL.slice(2)}`), undefined, "wrong prefix");
  assert.equal(delegationTarget("0x6080604052"), undefined, "ordinary contract code");
});

test("G2: stopState / lastEnd decode defensively; a zero pool means nothing armed", () => {
  const s = decodeStop(rawStop());
  assert.ok(s);
  assert.equal(s.sl, 95);
  assert.equal(s.tp, undefined);
  assert.equal(s.checks, 1_000);
  assert.equal(s.scheduleSubId, "23423786");
  assert.equal(s.intervalMs, 5_000);
  assert.equal(decodeStop(rawStop({ pool: "0x0000000000000000000000000000000000000000" })), undefined);
  assert.equal(decodeStop(rawStop({ pool: "not an address" })), undefined);
  assert.equal(decodeStop(rawStop({ slPrice: "95" })), undefined, "a string where a bigint belongs is refused");
  assert.equal(decodeStop(undefined), undefined);
  assert.equal(decodeStop(rawStop({ tpPrice: 105n * 10n ** 18n }))!.tp, 105);
  const l = decodeLast({ pool: POOLS.ETH, endedAtBlock: 36_000_000, checks: 1_234, reason: 2 });
  assert.deepEqual(l, { pool: POOLS.ETH, endedAtBlock: 36_000_000, checks: 1_234, reason: 2 });
  assert.equal(decodeLast({ pool: "0x0000000000000000000000000000000000000000", endedAtBlock: 0, checks: 0, reason: 0 }), undefined);
});

test("G3: readGuard calls nothing unless the code is the designator for OUR implementation", async () => {
  const calls: string[] = [];
  const pub = (code: string | undefined) => ({
    getCode: async () => code,
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      return functionName === "stopState" ? rawStop() : { pool: "0x0000000000000000000000000000000000000000", endedAtBlock: 0, checks: 0, reason: 0 };
    },
  }) as never;
  const A = addr(0xa11);
  assert.deepEqual(await readGuard(pub(undefined), A, IMPL), { delegated: false });
  assert.deepEqual(await readGuard(pub(designator(addr(0xbad))), A, IMPL), { delegated: false }, "another implementation is never called");
  assert.deepEqual(await readGuard(pub("0x6080"), A, IMPL), { delegated: false });
  assert.deepEqual(await readGuard(pub(designator(IMPL)), A, undefined), { delegated: false }, "feature off without a configured implementation");
  assert.equal(calls.length, 0, "no eth_call so far");
  const g = await readGuard(pub(designator(IMPL)), A, IMPL);
  assert.equal(g.delegated, true);
  assert.equal(g.stop?.sl, 95);
  assert.equal(g.last, undefined);
  assert.deepEqual(calls.sort(), ["lastEnd", "stopState"]);
});

test("G4: the /stops line says what is armed, how it is woken, and that it fires without the bot", () => {
  const s = decodeStop(rawStop({ tpPrice: 105n * 10n ** 18n }))!;
  const line = guardLine(s, "HYPE", Number(s.expiresAt) - 1800);
  assert.match(line, /^Chain-fired stop armed on HYPE-PERP long: SL 95 · TP 105, whole position, fills at most 1\.00% from the mark\./);
  assert.match(line, /Somnia Reactivity wakes it every 5 s and every epoch; checked 1000 times · last mark it saw 99 · 30 min left\. It closes even if this bot is offline\.$/);
  assert.match(guardLine(s, "HYPE", Number(s.expiresAt) + 5), /expired, ends at its next check/);
  assert.equal(lastLine({ pool: POOLS.ETH, endedAtBlock: 36_000_123, checks: 456, reason: 2 }, "ETH"), "Last chain-fired stop on ETH-PERP: fired: position closed at block 36000123 after 456 checks.");
});

test("G5: /stops and /positions show an armed chain-fired stop; nothing when the account is not delegated", async () => {
  const h = makeBot();
  const O = addr(0xdef);
  h.addUser(81, O);
  h.state.positions.set(O.toLowerCase(), [{ base: "ETH", side: "long", size: 2, entry: 100 }]);
  await h.handle(msg(81, "/stops"));
  let out = h.to(81).at(-1)!.html;
  assert.doesNotMatch(out, /Chain-fired/);
  h.state.guard = { delegated: true, stop: decodeStop(rawStop()), head: 35_990_100 };
  h.bot.stopCache.clear(); h.bot.buckets = new (h.bot.buckets.constructor)();
  await h.handle(msg(81, "/stops"));
  out = h.to(81).at(-1)!.html;
  assert.match(out, /<b>ETH-PERP long 2<\/b>[^]*⛓ Chain-fired stop armed on ETH-PERP long: SL 95, whole position/);
  assert.match(out, /0 chain-held stops \+ 1 chain-fired stop armed \(ExitGuard\)/);
  await h.handle(msg(81, "/positions"));
  assert.match(h.to(81).at(-1)!.html, /chain-fired stop armed: SL 95\.000 ⛓ \(ExitGuard, fires with no bot; \/stops\)/);
  // armed on a market with no position: its own section
  h.state.positions.set(O.toLowerCase(), []);
  h.bot.stopCache.clear(); h.bot.buckets = new (h.bot.buckets.constructor)();
  await h.handle(msg(81, "/stops"));
  assert.match(h.to(81).at(-1)!.html, /<b>ETH-PERP<\/b> \(no position\)\n⛓ Chain-fired stop armed/);
  // after it fired: a recent end is reported, an old one is not
  h.state.guard = { delegated: true, last: decodeLast({ pool: POOLS.ETH, endedAtBlock: 35_990_000, checks: 321, reason: 2 }), head: 35_990_500 };
  h.bot.stopCache.clear(); h.bot.buckets = new (h.bot.buckets.constructor)();
  await h.handle(msg(81, "/stops"));
  assert.match(h.to(81).at(-1)!.html, /ℹ️ Last chain-fired stop on ETH-PERP: fired: position closed at block 35990000 after 321 checks\./);
  h.state.guard = { delegated: true, last: decodeLast({ pool: POOLS.ETH, endedAtBlock: 35_000_000, checks: 321, reason: 2 }), head: 35_990_500 };
  h.bot.stopCache.clear(); h.bot.buckets = new (h.bot.buckets.constructor)();
  await h.handle(msg(81, "/stops"));
  assert.doesNotMatch(h.to(81).at(-1)!.html, /chain-fired/i, "an end more than a day old is not news");
  // a failing guard read never breaks /stops
  h.bot.venue.guard = async () => { throw new Error("rpc down"); };
  h.bot.stopCache.clear(); h.bot.buckets = new (h.bot.buckets.constructor)();
  await h.handle(msg(81, "/stops"));
  assert.match(h.to(81).at(-1)!.html, /Chain-held stops/);
  // a pool that is not a known market is not shown
  h.bot.venue.guard = async () => ({ delegated: true, stop: decodeStop(rawStop({ pool: addr(0x999) })), head: 1 });
  h.bot.stopCache.clear(); h.bot.buckets = new (h.bot.buckets.constructor)();
  await h.handle(msg(81, "/stops"));
  assert.doesNotMatch(h.to(81).at(-1)!.html, /Chain-fired/);
});
