// Read-only probe: markets, an account's margin/positions, link status, and a 20 s somnia_watch sample.
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { createPublicClient, webSocket, parseAbi } from "viem";
import { loadConfig, makeChain } from "../src/vendor/perp-core/config.ts";
import { perpMarkets, markOf } from "../src/vendor/perp-core/markets.ts";
process.env.NETWORK = "hideki";
const cfg = loadConfig();
const chain = makeChain(cfg);
const ex = new SomniaMarkets({ indexerUrl: cfg.indexerUrl, chain, wsRpcUrl: cfg.wsRpcUrl, addresses: SOMNIA_TESTNET_ADDRESSES });
const ms = await perpMarkets(ex);
for (const m of ms) console.log(m.display, m.symbol, "pool", m.info.poolAddress, "mb", m.info.marginBank, "min", m.info.minQuantity, "lot", m.info.lotSize, "tick", m.info.tickSize, "imBps", m.info.initialMarginBps, "dec", m.info.baseDecimals, m.info.quoteDecimals, "mark", markOf(m.info).toFixed(4));
const owner = (process.argv[2] ?? "0x0e7E8DF6Eac2E14165b4fA4CB2BD4e445d0E3817") as `0x${string}`;
const op = (process.argv[3] ?? "0x2A11e7388D1D2F9690f2636846d44b478f61bF08") as `0x${string}`;
const eth = ms.find((m) => m.display === "ETH-PERP")!;
const acct = await ex.client.getMarginAccount(eth.info.marginBank, owner);
console.log("margin", JSON.stringify(acct, (_k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 900));
for (const m of ms) {
  const p = await ex.client.getPerpPosition({ marginBank: m.info.marginBank, account: owner, pool: m.info.poolAddress });
  if (p.size !== 0n) console.log("POS", m.display, JSON.stringify(p, (_k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 400));
}
const pc = createPublicClient({ chain, transport: webSocket(cfg.wsRpcUrl) });
const abi = parseAbi(["function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)"]);
console.log("link place", await pc.readContract({ address: eth.info.poolAddress, abi, functionName: "isOperatorAuthorized", args: [owner, op, "0x80054449"] }));
console.log("maxLev", await ex.client.getPerpMaxLeverage({ marginBank: eth.info.marginBank, account: owner, pool: eth.info.poolAddress }));
const counts: Record<string, number> = {};
const t0 = Date.now();
const { unsubscribe } = await (pc.transport as any).subscribe({
  params: ["somnia_watch", { address: [eth.info.poolAddress], topics: undefined, eth_calls: [], context: undefined, push_changes_only: false }],
  onData: (n: any) => { const r = n?.result ?? n?.params?.result; const t = r?.topics?.[0] ?? "?"; counts[t] = (counts[t] ?? 0) + 1; },
  onError: (e: any) => console.log("watch error", String(e).slice(0, 200)),
});
await new Promise((r) => setTimeout(r, 20_000));
console.log("somnia_watch 20s on ETH pool:", JSON.stringify(counts), "elapsed", Date.now() - t0);
await unsubscribe();
process.exit(0);
