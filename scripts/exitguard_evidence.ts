// Build evidence/chain_fired_stop.json: the chain-fired stop run on the demo account, every fact re-read from the
// chain (receipts, decoded events, the reactive close transaction's shape) and the bot's stop/start times taken from
// its systemd journal lines (passed in). Exits non-zero if anything does not check out.
// Usage: node --import tsx scripts/exitguard_evidence.ts --arm <arm tx> --open <bot open tx> --fire-block <block> \
//          --bot-stopped <ISO> --bot-started <ISO> [--nonces-before "a:37,k:35"] [--nonces-after "a:37,k:35"]
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, formatUnits, http, parseAbi, type Hex, type Log } from "viem";
import { EXITGUARD_IMPL, RPC_URL } from "../src/config.ts";
import { chain } from "../src/venue.ts";
import { delegationTarget, END_REASONS, EXITGUARD_ABI } from "../src/exitguard.ts";

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const need = (n: string) => { const v = arg(n); if (!v) throw new Error(`missing ${n}`); return v; };
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ACCOUNT = "0x2A11e7388D1D2F9690f2636846d44b478f61bF08";
const BOT_KEY = "0xDD5DDD125d6a9b3D4641e5BDB5456E5Ec098FB18";
const PRECOMPILE = "0x0000000000000000000000000000000000000100";
const pub = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 30_000 }) });
const fail = (m: string): never => { throw new Error(`evidence check failed: ${m}`); };
const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString().replace(".000Z", "Z");

const ops = readFileSync("evidence/exitguard_ops.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { what: string; hash: string; block: string; t: string });
// The run is named by its arming tx; the deploy and delegation are the last ones before it in the ops log.
const armHash = need("--arm").toLowerCase();
const armIdx = ops.findIndex((o) => o.what === "arm" && o.hash.toLowerCase() === armHash);
if (armIdx < 0) fail("that arm tx is not in the ops log");
const lastBefore = (what: string) => [...ops.slice(0, armIdx)].reverse().find((o) => o.what === what) ?? fail(`no ${what} before the arm in the ops log`);
const deploy = lastBefore("deploy"), delegate = lastBefore("delegate"), arm = ops[armIdx]!;

async function receipt(hash: string) {
  if (!HASH.test(hash)) fail(`bad hash ${hash}`);
  const [rc, tx] = await Promise.all([pub.getTransactionReceipt({ hash: hash as Hex }), pub.getTransaction({ hash: hash as Hex })]);
  if (rc.status !== "success") fail(`${hash} is ${rc.status}`);
  const blk = await pub.getBlock({ blockNumber: rc.blockNumber });
  return { rc, tx, time: iso(blk.timestamp), ts: Number(blk.timestamp) };
}
const guardEvents = (logs: Log[]) => logs.filter((l) => l.address.toLowerCase() === ACCOUNT.toLowerCase()).map((l) => {
  try { return decodeEventLog({ abi: EXITGUARD_ABI, data: l.data, topics: l.topics as never }); } catch { return undefined; }
}).filter((x) => !!x);

// 1. implementation
const d = await receipt(deploy.hash);
if (d.rc.contractAddress?.toLowerCase() !== EXITGUARD_IMPL.toLowerCase()) fail("deploy did not create the configured implementation");
const implCode = (await pub.getCode({ address: EXITGUARD_IMPL })) ?? "0x";
// 2. EIP-7702 delegation
const g = await receipt(delegate.hash);
if (g.tx.type !== "eip7702") fail(`delegation tx type ${g.tx.type}`);
const auth = (g.tx as { authorizationList?: { address: string; chainId: number; nonce: number }[] }).authorizationList?.[0] ?? fail("no authorization list");
if (auth.address.toLowerCase() !== EXITGUARD_IMPL.toLowerCase() || g.tx.from.toLowerCase() !== ACCOUNT.toLowerCase()) fail("authorization target/sender");
const code = await pub.getCode({ address: ACCOUNT });
const target = delegationTarget(code) ?? fail("account is not delegated now");
if (target !== EXITGUARD_IMPL.toLowerCase()) fail("account delegates elsewhere");
// 3. the bot's open (placeOrderFor by the linked bot key)
const o = await receipt(need("--open"));
if (o.tx.from.toLowerCase() !== BOT_KEY.toLowerCase()) fail("open was not sent by the bot key");
if (!o.tx.input.toLowerCase().includes(ACCOUNT.slice(2).toLowerCase())) fail("open is not placeOrderFor the demo account");
// 4. arming
const a = await receipt(arm.hash);
if (a.tx.from.toLowerCase() !== ACCOUNT.toLowerCase() || a.tx.to?.toLowerCase() !== ACCOUNT.toLowerCase()) fail("arm is not a self-call");
const armed = guardEvents(a.rc.logs).find((e) => e.eventName === "Armed") ?? fail("no Armed event");
const aa = armed.args as unknown as { pool: string; isLong: boolean; slPrice: bigint; tpPrice: bigint; mark: bigint; slippageBps: number; maxChecks: number; expiresAt: bigint; intervalMs: number; scheduleSubId: bigint; tickSubId: bigint };
const subCreated = a.rc.logs.filter((l) => l.address.toLowerCase() === PRECOMPILE).length;
// 5. the fire: the reactive transaction at --fire-block that emitted Fired
const fireBlock = BigInt(need("--fire-block"));
const blk = await pub.getBlock({ blockNumber: fireBlock, includeTransactions: true });
let fire: { hash: Hex; ev: ReturnType<typeof guardEvents> } | undefined;
for (const t of blk.transactions) {
  if (t.to?.toLowerCase() !== ACCOUNT.toLowerCase()) continue;
  const rc = await pub.getTransactionReceipt({ hash: t.hash });
  const ev = guardEvents(rc.logs);
  if (ev.some((e) => e.eventName === "Fired")) { fire = { hash: t.hash, ev }; break; }
}
if (!fire) fail(`no Fired event in block ${fireBlock}`);
const f = await receipt(fire!.hash);
const fired = fire!.ev.find((e) => e.eventName === "Fired")!.args as unknown as { pool: string; kind: number; mark: bigint; trigger: bigint; quantity: bigint; remaining: bigint; orderId: bigint; checks: number };
const disarmed = fire!.ev.find((e) => e.eventName === "Disarmed")?.args as unknown as { reason: number; checks: number; scheduleUnsubscribed: boolean; tickUnsubscribed: boolean } | undefined;
const nonce = BigInt(f.tx.nonce);
const packedBlock = nonce >> 24n, queueIndex = nonce & 0xffffffn;
if (packedBlock !== f.rc.blockNumber) fail("the close tx nonce does not carry its block number (not a reactive tx?)");
if (f.tx.input.slice(0, 10) !== "0x53edf33d") fail("the close tx does not call onEvent");
if (f.tx.from.toLowerCase() !== ACCOUNT.toLowerCase()) fail("reactive tx from != subscription owner");
const poolLogs = f.rc.logs.filter((l) => l.address.toLowerCase() === aa.pool.toLowerCase());
const placed = poolLogs.filter((l) => l.topics[0] === "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d").length;
const fillLogs = poolLogs.filter((l) => l.topics[0] === "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399");
const filled = fillLogs.length;
// OrderFilled(uint128 indexed taker, uint128 indexed maker, uint256 quantityFilled, uint256 takerRemaining, uint256 makerRemaining, uint256 fillPrice)
const fills = fillLogs.map((l) => { const w = (i: number) => BigInt(`0x${l.data.slice(2 + 64 * i, 66 + 64 * i)}`); return { q: w(0), px: w(3) }; });
const fq = fills.reduce((x, y) => x + y.q, 0n);
const avgFill = fq > 0n ? Number(formatUnits(fills.reduce((x, y) => x + y.q * y.px, 0n) / fq, 18)) : null;
// position after the fire, and the subscriptions
const bankAbi = parseAbi(["function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))"]);
const posAfter = await pub.readContract({ address: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394", abi: bankAbi, functionName: "getPosition", args: [ACCOUNT, aa.pool as Hex], blockNumber: f.rc.blockNumber });
const subsNow = await pub.request({ method: "somnia_reactivityGetSubscriptions", params: [ACCOUNT] } as never).catch(() => "unavailable");
// bot window (from the systemd journal) and the fire inside it
const stopped = need("--bot-stopped"), started = need("--bot-started");
if (!(Date.parse(stopped) < f.ts * 1000 && f.ts * 1000 < Date.parse(started))) fail("the close is not inside the window the bot was stopped");
const nonceSpec = (s?: string) => Object.fromEntries((s ?? "").split(",").filter(Boolean).map((p) => p.split(":")).map(([k, v]) => [k, Number(v)]));

const out = {
  title: "Chain-fired stop-loss: closed by Somnia Reactivity while the bot was stopped",
  chainId: chain.id,
  account: ACCOUNT,
  generated: new Date().toISOString(),
  implementation: { address: EXITGUARD_IMPL, deployTx: deploy.hash, block: Number(d.rc.blockNumber), time: d.time, gasUsed: Number(d.rc.gasUsed), codeBytes: (implCode.length - 2) / 2 },
  delegation: { tx: delegate.hash, type: g.tx.type, block: Number(g.rc.blockNumber), time: g.time, gasUsed: Number(g.rc.gasUsed), authorization: { address: auth.address, chainId: Number(auth.chainId), nonce: Number(auth.nonce) }, accountCodeNow: code },
  open: { tx: o.tx.hash, from: o.tx.from, block: Number(o.rc.blockNumber), time: o.time, note: "placeOrderFor(demo account, ...) sent by the linked bot key: /long HYPE 2 5x sl 1.5% in Telegram" },
  arm: {
    tx: arm.hash, block: Number(a.rc.blockNumber), time: a.time, gasUsed: Number(a.rc.gasUsed), subscriptionLogs: subCreated,
    pool: aa.pool, isLong: aa.isLong, sl: Number(formatUnits(aa.slPrice, 18)), tp: aa.tpPrice > 0n ? Number(formatUnits(aa.tpPrice, 18)) : null,
    markAtArm: Number(formatUnits(aa.mark, 18)), slippageBps: aa.slippageBps, maxChecks: aa.maxChecks, expiresAt: iso(aa.expiresAt),
    intervalMs: aa.intervalMs, scheduleSubscription: aa.scheduleSubId.toString(), heartbeatSubscription: aa.tickSubId.toString(),
  },
  botStopped: stopped,
  fire: {
    tx: fire!.hash, block: Number(f.rc.blockNumber), time: f.time, gasUsed: Number(f.rc.gasUsed), effectiveGasPriceGwei: Number(formatUnits(f.rc.effectiveGasPrice, 9)),
    from: f.tx.from, to: f.tx.to, type: f.tx.type, nonce: nonce.toString(), nonceBlock: Number(packedBlock), nonceQueueIndex: Number(queueIndex),
    signature: { r: f.tx.r, s: f.tx.s }, selector: f.tx.input.slice(0, 10),
    kind: fired.kind === 1 ? "stop-loss" : "take-profit", mark: Number(formatUnits(fired.mark, 18)), trigger: Number(formatUnits(fired.trigger, 18)),
    quantityRaw: fired.quantity.toString(), remainingRaw: fired.remaining.toString(), checks: fired.checks,
    poolOrderPlacedLogs: placed, poolOrderFilledLogs: filled, avgFillPrice: avgFill, positionAfterRaw: posAfter.size.toString(),
    ended: disarmed ? { reason: END_REASONS[disarmed.reason] ?? String(disarmed.reason), scheduleUnsubscribed: disarmed.scheduleUnsubscribed, tickUnsubscribed: disarmed.tickUnsubscribed } : null,
  },
  botStarted: started,
  timings: {
    armToFireS: f.ts - a.ts,
    botStoppedToFireS: Math.round(f.ts - Date.parse(stopped) / 1000),
    fireToBotStartS: Math.round(Date.parse(started) / 1000 - f.ts),
  },
  noncesBefore: nonceSpec(arg("--nonces-before")),
  noncesAfter: nonceSpec(arg("--nonces-after")),
  subscriptionsNow: subsNow,
};
if (posAfter.size !== 0n) fail("position not flat after the fire");
// What the account paid from arming to the fire (it sent nothing itself in between: its nonce is unchanged).
const [balArm, balFire, nArm, nFire] = await Promise.all([
  pub.getBalance({ address: ACCOUNT, blockNumber: a.rc.blockNumber }), pub.getBalance({ address: ACCOUNT, blockNumber: f.rc.blockNumber }),
  pub.getTransactionCount({ address: ACCOUNT, blockNumber: a.rc.blockNumber }), pub.getTransactionCount({ address: ACCOUNT, blockNumber: f.rc.blockNumber }),
]);
if (nArm !== nFire) fail("the account sent a transaction between arming and the fire");
const spent = balArm - balFire, fireFee = f.rc.gasUsed * f.rc.effectiveGasPrice;
(out as Record<string, unknown>).costs = {
  sttSpentArmToFire: Number(Number(formatUnits(spent, 18)).toFixed(4)),
  closeStt: Number(Number(formatUnits(fireFee, 18)).toFixed(4)),
  perWakeStt: fired.checks > 1 ? Number((Number(formatUnits(spent - fireFee, 18)) / (fired.checks - 1)).toFixed(5)) : null,
  accountNonceArmToFire: [nArm, nFire],
};
writeFileSync("evidence/chain_fired_stop.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.timings), "fire", out.fire.tx, out.fire.kind, "checks", out.fire.checks);
process.exit(0);
