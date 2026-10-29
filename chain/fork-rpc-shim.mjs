// Local JSON-RPC shim so `forge test --fork-url` works against Somnia Tokyo testnet's public RPC, which refuses EIP-1898
// block objects ({"blockNumber": ...}) and answers "0x" for an empty storage word. It rewrites the first to a plain
// block number and the second to 32 zero bytes. Listens on 127.0.0.1 only, forwards to one fixed upstream, exits
// after 15 minutes. Usage: node fork-rpc-shim.mjs 18545 & forge test --match-path test/ExitGuardFork.t.sol --fork-url http://127.0.0.1:18545
import http from "node:http";
const UP = "https://api.hideki2.infra.testnet.somnia.network";
const PORT = Number(process.argv[2] ?? 18545);
const fix = (p) => Array.isArray(p) ? p.map((x) => (x && typeof x === "object" && !Array.isArray(x) && ("blockNumber" in x || "blockHash" in x)) ? (x.blockNumber ?? "latest") : x) : p;
const one = async (r) => {
  const body = { ...r, params: fix(r.params) };
  const res = await fetch(UP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (r.method === "eth_getStorageAt" && j.result === "0x") j.result = "0x" + "0".repeat(64);
  return j;
};
let n = 0;
http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) { b += c; if (b.length > 5e6) { res.writeHead(413).end(); return; } }
  try {
    const q = JSON.parse(b);
    const out = Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q);
    n++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  } catch (e) { res.writeHead(500).end(String(e)); }
}).listen(PORT, "127.0.0.1", () => console.log("proxy up", PORT));
setTimeout(() => { console.log("proxy requests", n); process.exit(0); }, 900_000);
