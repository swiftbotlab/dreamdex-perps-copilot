// Owner-side tool for ExitGuard (chain/src/ExitGuard.sol) on the demo account. NOT part of the bot: the bot never
// holds this key. The key is read in-process from an env file (EXITGUARD_KEY_ENV, KEY=VALUE lines,
// DREAMDEX_TESTNET_PRIVATE_KEY) and never printed; output is addresses, ids and tx hashes only.
//
//   status                                  account code, balance, nonce, armed stop, subscriptions
//   deploy [--go]                           deploy the ExitGuard implementation (constructor: the MarginBank)
//   delegate <impl> [--go]                  EIP-7702: point the account's code at <impl> (type-4 tx)
//   undelegate [--go]                       EIP-7702: clear the account's code again
//   arm <BASE> --sl <price|pct%> [--tp <price|pct%>] [--bps 50] [--checks 20000] [--hours 6] [--interval 5] [--go]
//   disarm [--go]
//   botsim <BASE>                           eth_call: can the linked bot key still close for the account? (no send)
// Dry run unless --go. Testnet only (chain id asserted). Every sent tx is appended to evidence/exitguard_ops.jsonl.
import { appendFileSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, formatUnits, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, RPC_URL } from "../src/config.ts";
import { chain, Venue } from "../src/venue.ts";
import { delegationTarget, EXITGUARD_ABI, END_REASONS } from "../src/exitguard.ts";
import { alignPrice, toRaw } from "../src/vendor/perp-core/markets.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY_ENV = process.env.EXITGUARD_KEY_ENV ?? "/home/agent/agent/secrets/dreamdex_testnet.env";
const EXPECT = (process.env.EXITGUARD_ACCOUNT ?? "0x2A11e7388D1D2F9690f2636846d44b478f61bF08").toLowerCase();
const BOT_KEY = "0xDD5DDD125d6a9b3D4641e5BDB5456E5Ec098FB18" as const; // the linked operator (for botsim only)
const OPS_LOG = `${ROOT}evidence/exitguard_ops.jsonl`;
const ARTIFACT = `${ROOT}chain/out/ExitGuard.sol/ExitGuard.json`;

const argv = process.argv.slice(2);
const go = argv.includes("--go");
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const VALUE_FLAGS = new Set(["--sl", "--tp", "--bps", "--checks", "--hours", "--interval"]);
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i]!)) { i++; continue; }
  if (!argv[i]!.startsWith("--")) positional.push(argv[i]!);
}
const [cmd, arg1] = positional;

function loadKey(): Hex {
  const env = Object.fromEntries(readFileSync(KEY_ENV, "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
  const k = env.DREAMDEX_TESTNET_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k ?? "")) throw new Error("no well-formed key in the env file");
  return k as Hex;
}

const account = privateKeyToAccount(loadKey());
if (account.address.toLowerCase() !== EXPECT) throw new Error("the key does not belong to the expected demo account");
const pub = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 30_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL, { timeout: 30_000, retryCount: 0 }) });
const ME = account.address;

function log(rec: Record<string, unknown>) {
  appendFileSync(OPS_LOG, JSON.stringify({ t: new Date().toISOString(), account: ME, ...rec }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}

async function send(what: string, tx: Parameters<typeof wallet.sendTransaction>[0]) {
  const hash = await wallet.sendTransaction(tx);
  console.log(what, "sent", hash);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  const blk = await pub.getBlock({ blockNumber: rc.blockNumber });
  console.log(what, rc.status, "block", rc.blockNumber, "gasUsed", rc.gasUsed, "type", rc.type, "at", new Date(Number(blk.timestamp) * 1000).toISOString());
  log({ what, hash, status: rc.status, block: rc.blockNumber, gasUsed: rc.gasUsed, type: rc.type, blockTime: Number(blk.timestamp), contract: rc.contractAddress ?? undefined });
  if (rc.status !== "success") throw new Error(`${what} reverted`);
  return rc;
}

async function status(v?: Venue) {
  const [code, bal, nonce] = await Promise.all([pub.getCode({ address: ME }), pub.getBalance({ address: ME }), pub.getTransactionCount({ address: ME })]);
  const target = delegationTarget(code);
  console.log("account", ME, "STT", formatUnits(bal, 18), "nonce", nonce, "code", code ?? "none", target ? `-> delegated to ${target}` : "");
  if (target) {
    const [st, la] = await Promise.all([
      pub.readContract({ address: ME, abi: EXITGUARD_ABI, functionName: "stopState" }).catch((e) => `ERR ${String(e).slice(0, 80)}`),
      pub.readContract({ address: ME, abi: EXITGUARD_ABI, functionName: "lastEnd" }).catch((e) => `ERR ${String(e).slice(0, 80)}`),
    ]);
    console.log("stopState", JSON.stringify(st, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    const l = la as { reason?: number };
    console.log("lastEnd", JSON.stringify(la, (_k, x) => (typeof x === "bigint" ? x.toString() : x)), l?.reason ? `(${END_REASONS[l.reason]})` : "");
  }
  const subs = await pub.request({ method: "somnia_reactivityGetSubscriptions", params: [ME] } as never).catch((e) => `ERR ${String(e).slice(0, 120)}`);
  console.log("subscriptions", JSON.stringify(subs));
  if (v) {
    const acct = await v.account(ME);
    console.log("positions", JSON.stringify(acct.positions.map((p) => ({ base: p.base, side: p.side, size: p.size, entry: p.entry, mark: p.mark }))), "equity", acct.equity.toFixed(4));
  }
}

function level(spec: string | undefined, mark: number, below: boolean): number | undefined {
  if (!spec) return undefined;
  const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(spec);
  if (!m) throw new Error(`bad level ${spec}`);
  const x = Number(m[1]);
  if (!m[2]) return x;
  if (x <= 0 || x > 20) throw new Error("percent level must be in (0, 20]");
  return mark * (1 + (below ? -x : x) / 100);
}

const id = await pub.getChainId();
if (id !== CHAIN_ID) throw new Error(`chain id ${id}, expected ${CHAIN_ID} (testnet only)`);

if (cmd === "status") {
  const v = new Venue(); await v.init();
  await status(v);
  await v.exchange.close();
} else if (cmd === "deploy") {
  const art = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
  const v = new Venue(); await v.init();
  const bank = v.marginBank();
  const data = (art.bytecode.object + encodeAbiParameters([{ type: "address" }], [bank]).slice(2)) as Hex; // creation code ++ abi.encode(marginBank)
  console.log("deploy ExitGuard, MarginBank", bank, "initcode bytes", (data.length - 2) / 2);
  const gas = await pub.estimateGas({ account: ME, data }).catch((e) => { throw new Error(`estimate failed: ${String(e).slice(0, 200)}`); });
  console.log("estimated gas", gas);
  if (go) {
    const rc = await send("deploy", { data, gas: (gas * 3n) / 2n });
    console.log("implementation", rc.contractAddress, "code bytes", (((await pub.getCode({ address: rc.contractAddress! })) ?? "0x").length - 2) / 2);
  }
  await v.exchange.close();
} else if (cmd === "delegate" || cmd === "undelegate") {
  const impl = (cmd === "undelegate" ? "0x0000000000000000000000000000000000000000" : arg1) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(impl ?? "")) throw new Error("usage: delegate <implementation address>");
  if (cmd === "undelegate") {
    // Subscriptions outlive the code: removing it while armed would leave the chain calling a code-less account.
    const subs = await pub.request({ method: "somnia_reactivityGetSubscriptions", params: [ME] } as never) as unknown[];
    if (Array.isArray(subs) && subs.length) throw new Error(`refusing: ${subs.length} Reactivity subscription(s) still owned by the account; disarm first`);
  }
  if (cmd === "delegate") {
    const code = await pub.getCode({ address: impl });
    if (!code || code.length < 100) throw new Error("no contract code at the implementation address");
    const mb = await pub.readContract({ address: impl, abi: EXITGUARD_ABI, functionName: "MARGIN_BANK" });
    console.log("implementation", impl, "MARGIN_BANK", mb, "code bytes", (code.length - 2) / 2);
  }
  if (go) {
    // The account sends the type-4 tx itself, so the authorization nonce is its current nonce + 1 ('self').
    const authorization = await wallet.signAuthorization({ account, contractAddress: impl, executor: "self" });
    await send(cmd, { to: ME, data: "0x", authorizationList: [authorization], gas: 3_000_000n });
    console.log("code now", (await pub.getCode({ address: ME })) ?? "none");
  } else console.log(cmd, "dry run: would sign an authorization for", impl, "and send a type-4 tx to itself");
} else if (cmd === "arm") {
  const v = new Venue(); await v.init();
  const m = v.market(String(arg1 ?? "").toUpperCase());
  if (!m) throw new Error("unknown market");
  const acct = await v.account(ME);
  const pos = acct.positions.find((p) => p.base === v.baseOf(m));
  if (!pos) throw new Error(`no ${m.display} position on the account`);
  const mark = (await v.mark(m))!;
  const long = pos.side === "long";
  const sl = level(flag("--sl"), mark, long);
  const tp = level(flag("--tp"), mark, !long);
  if (sl === undefined) throw new Error("--sl is required");
  const bps = Number(flag("--bps") ?? 50), checks = Number(flag("--checks") ?? 20_000), hours = Number(flag("--hours") ?? 6);
  if (!Number.isInteger(bps) || bps < 1 || bps > 500) throw new Error("--bps must be 1-500");
  if (!Number.isInteger(checks) || checks < 1 || checks > 1_000_000) throw new Error("--checks must be 1-1,000,000");
  if (!(hours > 0 && hours <= 168)) throw new Error("--hours must be in (0, 168]");
  const intervalMs = Math.round(Number(flag("--interval") ?? 5) * 1000);
  if (!(intervalMs >= 2_000 && intervalMs <= 300_000)) throw new Error("--interval must be 2-300 seconds");
  const slRaw = alignPrice(toRaw(sl, 18), m.info);
  const tpRaw = tp !== undefined ? alignPrice(toRaw(tp, 18), m.info) : 0n;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(hours * 3600));
  console.log(m.display, pos.side, pos.size, "mark", mark, "SL", formatUnits(slRaw, 18), "TP", tpRaw ? formatUnits(tpRaw, 18) : "none", "bps", bps, "checks", checks, "every", intervalMs, "ms", "expires", new Date(Number(expiresAt) * 1000).toISOString());
  const data = encodeFunctionData({ abi: EXITGUARD_ABI, functionName: "arm", args: [m.info.poolAddress, slRaw, tpRaw, bps, checks, expiresAt, intervalMs] });
  const sim = await pub.call({ account: ME, to: ME, data, gas: 10_000_000n }).catch((e) => { throw new Error(`arm simulation failed: ${String(e.shortMessage ?? e).slice(0, 300)}`); });
  console.log("simulation ok", sim.data?.slice(0, 130));
  if (go) await send("arm", { to: ME, data, gas: 10_000_000n });
  await status(v);
  await v.exchange.close();
} else if (cmd === "disarm") {
  const data = encodeFunctionData({ abi: EXITGUARD_ABI, functionName: "disarm" });
  await pub.call({ account: ME, to: ME, data, gas: 5_000_000n }).catch((e) => { throw new Error(`disarm simulation failed: ${String(e.shortMessage ?? e).slice(0, 300)}`); });
  console.log("simulation ok");
  if (go) await send("disarm", { to: ME, data, gas: 5_000_000n });
  await status();
} else if (cmd === "botsim") {
  // Does the linked bot key's normal close path still pass the pool's checks for this account? eth_call only.
  const v = new Venue(); await v.init();
  const m = v.market(String(arg1 ?? "").toUpperCase());
  if (!m) throw new Error("unknown market");
  const acct = await v.account(ME);
  const pos = acct.positions.find((p) => p.base === v.baseOf(m));
  const mark = (await v.mark(m))!;
  const qty = pos ? toRaw(pos.size, m.info.baseDecimals) : BigInt(m.info.minQuantity);
  const isBid = pos ? pos.side === "short" : true;
  const price = alignPrice(toRaw(mark * (isBid ? 1.01 : 0.99), 18), m.info);
  const abi = parseAbi(["function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)"]);
  const data = encodeFunctionData({ abi, functionName: "placeOrderFor", args: [ME, isBid, 0n, price, qty, BigInt(Math.floor(Date.now() / 1000) + 60) * 1_000_000_000n, 2, 0, "0x0000000000000000000000000000000000000000", 0n] });
  const r = await pub.call({ account: BOT_KEY, to: m.info.poolAddress, data, gas: 10_000_000n }).then(() => "ok").catch((e) => `REVERT ${String(e.shortMessage ?? e).slice(0, 200)}`);
  console.log("bot key placeOrderFor", m.display, pos ? `close ${pos.side} ${pos.size}` : `buy ${formatUnits(qty, m.info.baseDecimals)} (no position)`, "->", r);
  await v.exchange.close();
} else {
  console.log("usage: status | deploy | delegate <impl> | undelegate | arm <BASE> --sl .. | disarm | botsim <BASE>  [--go]");
}
process.exit(0);
