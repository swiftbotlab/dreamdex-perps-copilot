// ExitGuard (chain/src/ExitGuard.sol): a stop-loss / take-profit the CHAIN fires. The account delegates its code to
// ExitGuard with EIP-7702 and arms a stop; Somnia Reactivity then wakes the account on a fixed schedule (a one-shot
// Schedule it renews on every wake, every 5 s here) and every epoch, and the account closes its own position when the
// mark crosses the level.
// This module only READS it: is the account delegated to our ExitGuard, and what is armed. It never sends anything.
import { formatUnits, parseAbi, type PublicClient } from "viem";

export const EXITGUARD_ABI = parseAbi([
  "function arm(address pool, uint128 slPrice, uint128 tpPrice, uint16 slippageBps, uint32 maxChecks, uint64 expiresAt, uint32 intervalMs) returns (uint64 scheduleSubId, uint64 tickSubId)",
  "function disarm()",
  "function onEvent(address emitter, bytes32[] eventTopics, bytes data)",
  "function stopState() view returns ((address pool, bool isLong, uint16 slippageBps, uint8 failures, uint64 expiresAt, uint128 slPrice, uint128 tpPrice, uint64 scheduleSubId, uint64 tickSubId, uint32 checksLeft, uint32 checks, uint64 lastCheckBlock, uint128 lastMark, uint64 nextWakeMs, uint32 intervalMs, uint32 armedAtBlock))",
  "function lastEnd() view returns ((address pool, uint40 endedAtBlock, uint32 checks, uint8 reason))",
  "function MARGIN_BANK() view returns (address)",
  "function VERSION() view returns (uint256)",
  "event Armed(address indexed pool, bool isLong, uint256 slPrice, uint256 tpPrice, uint256 mark, uint16 slippageBps, uint32 maxChecks, uint64 expiresAt, uint32 intervalMs, uint64 scheduleSubId, uint64 tickSubId)",
  "event Fired(address indexed pool, uint8 kind, uint256 mark, uint256 trigger, uint256 quantity, uint256 remaining, uint128 orderId, uint32 checks)",
  "event CloseFailed(address indexed pool, uint256 mark, bytes4 reason, uint8 failures)",
  "event RescheduleFailed(address indexed pool, uint64 wakeMs)",
  "event Disarmed(address indexed pool, uint8 reason, uint32 checks, bool scheduleUnsubscribed, bool tickUnsubscribed)",
  "error NotSelf()", "error NotPrecompile()", "error ForeignSubscription()", "error AlreadyArmed()", "error NotArmed()",
  "error BadPool()", "error NoPosition()", "error NoMark()", "error BadLevels()", "error BadSlippage()", "error BadBudget()",
  "error BadExpiry()", "error BadInterval()", "error LowBalance()", "error SubscribeFailed()",
]);

export const END_REASONS: Record<number, string> = {
  1: "disarmed by the account", 2: "fired: position closed", 3: "expired", 4: "check budget used up",
  5: "position closed or flipped elsewhere first", 6: "gave up after 3 failed closes", 7: "only dust left",
};

/** The implementation an EIP-7702 account points at: its code is exactly 0xef0100 || address (23 bytes). */
export function delegationTarget(code: string | undefined): `0x${string}` | undefined {
  if (!code) return undefined;
  const c = code.toLowerCase();
  if (!/^0xef0100[0-9a-f]{40}$/.test(c)) return undefined;
  return `0x${c.slice(8)}` as `0x${string}`;
}

export interface GuardStop {
  pool: `0x${string}`; isLong: boolean; slippageBps: number; failures: number; expiresAt: number;
  sl: number; tp?: number; scheduleSubId: string; tickSubId: string; checksLeft: number; checks: number;
  lastCheckBlock: number; lastMark?: number; nextWakeMs: number; intervalMs: number; armedAtBlock: number;
}
export interface GuardLast { pool: `0x${string}`; endedAtBlock: number; checks: number; reason: number }
export interface GuardView { delegated: boolean; stop?: GuardStop; last?: GuardLast }

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const px = (v: bigint) => Number(formatUnits(v, 18));

/** Decode stopState() defensively (an RPC answer is untrusted input). Undefined = nothing armed or malformed. */
export function decodeStop(s: Record<string, unknown> | undefined): GuardStop | undefined {
  if (!s || typeof s.pool !== "string" || !HEX40.test(s.pool) || BigInt(s.pool) === 0n) return undefined;
  const big = (k: string) => (typeof s[k] === "bigint" ? (s[k] as bigint) : undefined);
  const sl = big("slPrice"), tp = big("tpPrice"), exp = big("expiresAt"), ev = big("scheduleSubId"), tk = big("tickSubId"), lm = big("lastMark");
  const lcb = big("lastCheckBlock"), nw = big("nextWakeMs");
  if (sl === undefined || tp === undefined || exp === undefined || ev === undefined || tk === undefined || lm === undefined || lcb === undefined || nw === undefined) return undefined;
  const num = (k: string) => (typeof s[k] === "number" && Number.isFinite(s[k]) ? (s[k] as number) : 0);
  return {
    pool: s.pool as `0x${string}`, isLong: s.isLong === true, slippageBps: num("slippageBps"), failures: num("failures"),
    expiresAt: Number(exp), sl: px(sl), tp: tp > 0n ? px(tp) : undefined, scheduleSubId: ev.toString(), tickSubId: tk.toString(),
    checksLeft: num("checksLeft"), checks: num("checks"), lastCheckBlock: Number(lcb), lastMark: lm > 0n ? px(lm) : undefined,
    nextWakeMs: Number(nw), intervalMs: num("intervalMs"), armedAtBlock: num("armedAtBlock"),
  };
}

export function decodeLast(l: Record<string, unknown> | undefined): GuardLast | undefined {
  if (!l || typeof l.pool !== "string" || !HEX40.test(l.pool) || BigInt(l.pool) === 0n) return undefined;
  const reason = typeof l.reason === "number" ? l.reason : 0;
  return { pool: l.pool as `0x${string}`, endedAtBlock: Number(l.endedAtBlock ?? 0), checks: typeof l.checks === "number" ? l.checks : 0, reason };
}

/**
 * Read an account's ExitGuard. Only an account whose code is the designator for OUR implementation (`impl`) is read;
 * any other code is never called. Read-only (eth_getCode + two eth_calls).
 */
export async function readGuard(pub: PublicClient, account: `0x${string}`, impl: `0x${string}` | undefined): Promise<GuardView> {
  if (!impl) return { delegated: false };
  const code = await pub.getCode({ address: account });
  const target = delegationTarget(code);
  if (!target || target !== impl.toLowerCase()) return { delegated: false };
  const [st, la] = await Promise.all([
    pub.readContract({ address: account, abi: EXITGUARD_ABI, functionName: "stopState" }).catch(() => undefined),
    pub.readContract({ address: account, abi: EXITGUARD_ABI, functionName: "lastEnd" }).catch(() => undefined),
  ]);
  return { delegated: true, stop: decodeStop(st as never), last: decodeLast(la as never) };
}

const fp = (x: number) => (x >= 1000 ? x.toFixed(2) : Number(x.toPrecision(6)).toString());

/** The /stops (and /positions) line for an armed chain-fired stop. `base` is the market's symbol for the pool. */
export function guardLine(g: GuardStop, base: string, nowS = Math.floor(Date.now() / 1000)): string {
  const levels = `SL ${fp(g.sl)}${g.tp !== undefined ? ` · TP ${fp(g.tp)}` : ""}`;
  const left = g.expiresAt > nowS ? `${Math.max(1, Math.round((g.expiresAt - nowS) / 60))} min left` : "expired, ends at its next check";
  const mark = g.lastMark !== undefined ? ` · last mark it saw ${fp(g.lastMark)}` : "";
  return `Chain-fired stop armed on ${base}-PERP ${g.isLong ? "long" : "short"}: ${levels}, whole position, fills at most ${(g.slippageBps / 100).toFixed(2)}% from the mark. ` +
    `Somnia Reactivity wakes it every ${fp(g.intervalMs / 1000)} s and every epoch; checked ${g.checks} times${mark} · ${left}. It closes even if this bot is offline.`;
}

export function lastLine(l: GuardLast, base: string): string {
  return `Last chain-fired stop on ${base}-PERP: ${END_REASONS[l.reason] ?? "ended"} at block ${l.endedAtBlock} after ${l.checks} checks.`;
}
