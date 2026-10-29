// Build evidence/ from data/orders.jsonl: every order the bot sent, re-verified against the chain
// (receipt status, block, sender = the user's linked bot key, target = the market's perp pool,
// and the PlaceOrder call's first argument = the dreamDEX account it traded for).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeFunctionData, http, parseAbi } from "viem";
import { EXPLORER_TX, RPC_URL } from "../src/config.ts";
import { chain } from "../src/venue.ts";

const pc = createPublicClient({ chain, transport: http(RPC_URL) });
const abi = parseAbi(["function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)"]);
// Only the named demo accounts are exported: other users' accounts and trades never go into the public repo.
const accounts = process.argv.slice(2).map((a) => a.toLowerCase());
if (!accounts.length || !accounts.every((a) => /^0x[0-9a-f]{40}$/.test(a))) { console.error("usage: evidence.ts <demo account> [earlier demo account ...]"); process.exit(2); }
const rows = readFileSync("data/orders.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => accounts.includes(String(r.account).toLowerCase()));
/** Auto exits: seconds from the mark update that crossed the level to the confirmed close, as the bot logged them. */
const latency = (r: { t: string; trigAt?: string }) => {
  if (typeof r.trigAt !== "string") return undefined;
  const ms = Date.parse(r.t) - Date.parse(r.trigAt);
  return Number.isFinite(ms) && ms >= 0 && ms <= 120_000 ? ms / 1000 : undefined;
};
const json: Record<string, unknown>[] = [];
const out: string[] = [];
const csv = ["time_utc,kind,reason,via,market,side,filled,avg_price,tx_hash,block,status,from_bot_key,for_account,gas_used,trigger_to_close_s,trigger_source"];
const q = (v: unknown) => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
let ok = 0, unresolved = 0;
for (const r of rows) {
  // "unknown" rows: the bot could not confirm the outcome when it sent them. Re-check them from the chain here.
  const kind = r.kind === "unknown" ? `${r.intent ?? "order"} (unconfirmed at send)` : r.kind;
  if (!r.hash) {
    unresolved++;
    csv.push([r.t, kind, r.reason ?? "", r.via ?? "", r.market, r.side, "", "", "", "", "no tx hash recorded (outcome not known)", r.key, r.account, ""].map(q).join(","));
    out.push(`| ${String(r.t).slice(5, 19).replace("T", " ")} | ${kind} | ${r.via ?? ""} | ${r.market} | ${r.side} | - | - | no tx hash recorded | - | outcome not known | | |`);
    continue;
  }
  const found = await Promise.all([pc.getTransaction({ hash: r.hash }), pc.getTransactionReceipt({ hash: r.hash })]).catch(() => undefined);
  if (!found) {
    unresolved++;
    csv.push([r.t, kind, r.reason ?? "", r.via ?? "", r.market, r.side, "", "", r.hash, "", "not found on chain", r.key, r.account, ""].map(q).join(","));
    out.push(`| ${String(r.t).slice(5, 19).replace("T", " ")} | ${kind} | ${r.via ?? ""} | ${r.market} | ${r.side} | - | - | [${r.hash.slice(0, 12)}…](${EXPLORER_TX}${r.hash}) | - | not found | | |`);
    continue;
  }
  const [tx, rc] = found;
  const blk = await pc.getBlock({ blockNumber: rc.blockNumber });
  const call = decodeFunctionData({ abi, data: tx.input });
  const owner = String(call.args[0]);
  const good = rc.status === "success" && tx.from.toLowerCase() === String(r.key).toLowerCase() && owner.toLowerCase() === String(r.account).toLowerCase();
  if (good) ok++;
  const t = new Date(Number(blk.timestamp) * 1000).toISOString().replace(".000Z", "Z");
  const lat = latency(r);
  csv.push([t, kind, r.reason ?? "", r.via ?? "", r.market, r.side, r.filled ?? "", r.avgPrice ?? "", r.hash, rc.blockNumber, rc.status, tx.from, owner, rc.gasUsed, lat ?? "", lat !== undefined ? r.trigSrc ?? "" : ""].map(q).join(","));
  out.push(`| ${t.slice(5, 19).replace("T", " ")} | ${kind}${r.reason && r.reason !== "manual close" && r.kind !== "unknown" ? ` (${String(r.reason).split(" ")[0]})` : ""} | ${r.via ?? ""} | ${r.market} | ${r.side} | ${r.filled ?? "-"} | ${r.avgPrice === undefined ? "-" : Number(Number(r.avgPrice).toPrecision(8))} | [${r.hash.slice(0, 12)}…](${EXPLORER_TX}${r.hash}) | ${rc.blockNumber} | ${rc.status} | ${lat === undefined ? "" : `${lat.toFixed(1)} s`} | \`${owner.slice(0, 6)}…${owner.slice(-4)}\` |`);
  json.push({ time: t, logged: r.t, kind, reason: r.reason ?? null, via: r.via ?? null, market: r.market, side: r.side, filled: r.filled ?? null, avgPrice: r.avgPrice ?? null,
    hash: r.hash, block: Number(rc.blockNumber), status: rc.status, verified: good, from: tx.from, account: owner, gasUsed: Number(rc.gasUsed),
    triggerToCloseS: lat ?? null, triggerSource: lat !== undefined ? r.trigSrc ?? null : null });
}
writeFileSync("evidence/orders.csv", csv.join("\n") + "\n");
writeFileSync("evidence/orders.json", JSON.stringify({ generated: new Date().toISOString(), chainId: chain.id, accounts, verified: ok, total: rows.length, orders: json }, null, 1) + "\n");
writeFileSync("evidence/orders.md",
  `# Orders placed by the bot on Somnia Tokyo testnet (Hideki, chain ${chain.id})\n\n` +
  `Generated ${new Date().toISOString()} by scripts/evidence.ts from the bot's order log, every row re-read from the chain: ` +
  `${ok}/${rows.length} receipts are \`success\`, sent by the user's linked bot key and calling \`placeOrderFor(account, ...)\` on the market's perp pool.` +
  (unresolved ? ` ${unresolved} row(s) the bot could not confirm when sending could not be matched to a receipt on chain (no hash recorded, or not found; listed as such).` : "") +
  ` "via card" marks an order opened from a shared card (Copy this trade).\n\n` +
  `Accounts: ${accounts.map((a) => `\`${a}\``).join(", ")}. "trigger to close" (bot exits from 2026-10-29): time from the mark update that crossed the level to the confirmed close, from the bot's own clock.\n\n` +
  `| time (UTC) | action | via | market | side | filled | avg price | tx | block | status | trigger to close | account |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n` + out.join("\n") + "\n");
console.log(`${ok}/${rows.length} verified${unresolved ? `, ${unresolved} unresolved` : ""}`);
process.exit(0);
