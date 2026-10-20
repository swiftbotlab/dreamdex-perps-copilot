// Build evidence/ from data/orders.jsonl: every order the bot sent, re-verified against the chain
// (receipt status, block, sender = the user's linked bot key, target = the market's perp pool,
// and the PlaceOrder call's first argument = the dreamDEX account it traded for).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeFunctionData, http, parseAbi } from "viem";
import { EXPLORER_TX, RPC_URL } from "../src/config.ts";
import { chain } from "../src/venue.ts";

const pc = createPublicClient({ chain, transport: http(RPC_URL) });
const abi = parseAbi(["function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)"]);
// Only the named demo account is exported: other users' accounts and trades never go into the public repo.
const account = (process.argv[2] ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(account)) { console.error("usage: evidence.ts <demo account address>"); process.exit(2); }
const rows = readFileSync("data/orders.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => String(r.account).toLowerCase() === account);
const out: string[] = [];
const csv = ["time_utc,kind,reason,market,side,filled,avg_price,tx_hash,block,status,from_bot_key,for_account,gas_used"];
let ok = 0;
for (const r of rows) {
  const [tx, rc] = await Promise.all([pc.getTransaction({ hash: r.hash }), pc.getTransactionReceipt({ hash: r.hash })]);
  const blk = await pc.getBlock({ blockNumber: rc.blockNumber });
  const call = decodeFunctionData({ abi, data: tx.input });
  const owner = String(call.args[0]);
  const good = rc.status === "success" && tx.from.toLowerCase() === String(r.key).toLowerCase() && owner.toLowerCase() === String(r.account).toLowerCase();
  if (good) ok++;
  const t = new Date(Number(blk.timestamp) * 1000).toISOString().replace(".000Z", "Z");
  const q = (v: unknown) => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  csv.push([t, r.kind, r.reason ?? "", r.market, r.side, r.filled, r.avgPrice ?? "", r.hash, rc.blockNumber, rc.status, tx.from, owner, rc.gasUsed].map(q).join(","));
  out.push(`| ${t.slice(5, 19).replace("T", " ")} | ${r.kind}${r.reason && r.reason !== "manual close" ? ` (${String(r.reason).split(" ")[0]})` : ""} | ${r.market} | ${r.side} | ${r.filled} | ${r.avgPrice === undefined ? "-" : Number(Number(r.avgPrice).toPrecision(8))} | [${r.hash.slice(0, 12)}…](${EXPLORER_TX}${r.hash}) | ${rc.blockNumber} | ${rc.status} |`);
}
writeFileSync("evidence/orders.csv", csv.join("\n") + "\n");
writeFileSync("evidence/orders.md",
  `# Orders placed by the bot on Somnia Tokyo testnet (Hideki, chain ${chain.id})\n\n` +
  `Generated ${new Date().toISOString()} by scripts/evidence.ts from the bot's order log, every row re-read from the chain: ` +
  `${ok}/${rows.length} receipts are \`success\`, sent by the user's linked bot key and calling \`placeOrderFor(account, ...)\` on the market's perp pool.\n\n` +
  `| time (UTC) | action | market | side | filled | avg price | tx | block | status |\n|---|---|---|---|---|---|---|---|---|\n` + out.join("\n") + "\n");
console.log(`${ok}/${rows.length} verified`);
process.exit(0);
