// 30 s somnia_watch sample: mark-price pushes (eth_call tryGetMarkPrice, push_changes_only) on ETH-PERP and BTC-PERP.
import { createPublicClient, webSocket, defineChain, decodeAbiParameters } from "viem";
const chain = defineChain({ id: 50383, name: "Hideki", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: ["https://api.hideki2.infra.testnet.somnia.network"], webSocket: ["wss://api.hideki2.infra.testnet.somnia.network/ws"] } } });
const pc = createPublicClient({ chain, transport: webSocket("wss://api.hideki2.infra.testnet.somnia.network/ws") });
const pools: Record<string, `0x${string}`> = { ETH: "0xd6cb1dd58580b84d76068ac21594219ce03aeddf", BTC: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0" };
const SEL = "0xb3a6e0e8"; // placeholder, replaced below
import { toFunctionSelector } from "viem";
const sel = toFunctionSelector("tryGetMarkPrice()");
for (const [name, pool] of Object.entries(pools)) {
  let n = 0; const t0 = Date.now();
  await (pc.transport as any).subscribe({
    params: ["somnia_watch", { address: [pool], eth_calls: [{ to: pool, data: sel }], push_changes_only: true }],
    onData: (msg: any) => { const r = msg?.result ?? msg?.params?.result; n++; const [ok, px] = decodeAbiParameters([{ type: "bool" }, { type: "uint256" }], r.simulationResults[0]); if (n <= 4 || n % 10 === 0) console.log(name, ((Date.now() - t0) / 1000).toFixed(1) + "s", ok, (Number(px) / 1e18).toFixed(4), "#" + n); },
    onError: (e: any) => console.log("err", String(e).slice(0, 200)),
  });
}
await new Promise((r) => setTimeout(r, 30_000));
process.exit(0);
