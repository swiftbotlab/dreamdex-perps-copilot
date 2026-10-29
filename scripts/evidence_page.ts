// Build docs/index.html (the public evidence page, GitHub Pages) from evidence/orders.json (written by
// scripts/evidence.ts, every order re-read from the chain) and evidence/stops_demo.json (the chain-held stop
// check run; each tx is re-read here and the page is not written if any is missing or failed).
// Usage: node --import tsx scripts/evidence_page.ts [video url]
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { EXPLORER_ADDR, EXPLORER_TX, RPC_URL } from "../src/config.ts";
import { chain } from "../src/venue.ts";

const REPO = "https://github.com/swiftbotlab/dreamdex-perps-copilot";
const BOT = "https://t.me/SwiftPerpsBot";
// The demo video: argument, else evidence/video_url.txt (one https URL), else the mp4 on the v1.0.0 release.
const videoFile = (() => { try { return readFileSync("evidence/video_url.txt", "utf8").trim(); } catch { return ""; } })();
const VIDEO = process.argv[2] ?? (/^https:\/\/[^\s"<>]+$/.test(videoFile) ? videoFile : `${REPO}/releases/download/v1.0.0/demo.mp4`);
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HASH = /^0x[0-9a-fA-F]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/;
const tx = (h: string) => { if (!HASH.test(h)) throw new Error(`bad hash ${h}`); return `<a href="${EXPLORER_TX}${h}"><code>${h.slice(0, 10)}…${h.slice(-6)}</code></a>`; };
const ad = (a: string) => { if (!ADDR.test(a)) throw new Error(`bad address ${a}`); return `<a href="${EXPLORER_ADDR}${a}"><code>${a.slice(0, 6)}…${a.slice(-4)}</code></a>`; };

interface Row { time: string; kind: string; reason: string | null; via: string | null; market: string; side: string; filled: number | null; avgPrice: number | null; hash: string; block: number; status: string; verified: boolean; account: string; triggerToCloseS: number | null; triggerSource: string | null }
const ev = JSON.parse(readFileSync("evidence/orders.json", "utf8")) as { generated: string; chainId: number; accounts: string[]; verified: number; total: number; orders: Row[] };
const demo = JSON.parse(readFileSync("evidence/stops_demo.json", "utf8")) as { title: string; account: string; note: string; steps: { t: string; who: string; what: string; tx?: string; quote?: string }[] };

const pc = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 30_000 }) });
for (const s of demo.steps) {
  if (!s.tx) continue;
  const rc = await pc.getTransactionReceipt({ hash: s.tx as `0x${string}` });
  if (rc.status !== "success") throw new Error(`demo step tx ${s.tx} is ${rc.status}`);
}

// The chain-fired stop run (scripts/exitguard_evidence.ts wrote it from the chain); every tx is re-checked here too.
interface ChainStop {
  title: string; account: string; implementation: { address: string; deployTx: string; gasUsed: number; codeBytes: number; time: string };
  delegation: { tx: string; time: string; gasUsed: number; authorization: { address: string; chainId: number; nonce: number } };
  open: { tx: string; time: string }; arm: { tx: string; time: string; gasUsed: number; sl: number; markAtArm: number; slippageBps: number; maxChecks: number; expiresAt: string; intervalMs: number; scheduleSubscription: string; heartbeatSubscription: string; pool: string };
  botStopped: string; botStarted: string;
  fire: { tx: string; block: number; time: string; gasUsed: number; effectiveGasPriceGwei: number; from: string; type: string; nonce: string; nonceBlock: number; nonceQueueIndex: number; signature: { r: string; s: string }; kind: string; mark: number; trigger: number; checks: number; poolOrderFilledLogs: number; avgFillPrice: number | null; ended: { reason: string } | null };
  timings: { armToFireS: number; botStoppedToFireS: number; fireToBotStartS: number };
  noncesBefore: Record<string, number>; noncesAfter: Record<string, number>; costs?: { sttSpentArmToFire: number; closeStt: number; perWakeStt: number | null };
}
const cs = (() => { try { return JSON.parse(readFileSync("evidence/chain_fired_stop.json", "utf8")) as ChainStop; } catch { return undefined; } })();
if (cs) for (const h of [cs.implementation.deployTx, cs.delegation.tx, cs.open.tx, cs.arm.tx, cs.fire.tx]) {
  const rc = await pc.getTransactionReceipt({ hash: h as `0x${string}` });
  if (rc.status !== "success") throw new Error(`chain-fired stop tx ${h} is ${rc.status}`);
}
const t8 = (iso: string) => esc(iso.slice(11, 19));
// The bot's own /stops and /positions replies about it (copied as sent); their txs are re-checked too.
const csBot = (() => { try { return JSON.parse(readFileSync("evidence/chain_fired_stop_bot.json", "utf8")) as { note: string; quotes: { t: string; cmd: string; after: string; text: string }[]; txs: Record<string, string> }; } catch { return undefined; } })();
if (csBot) for (const h of Object.values(csBot.txs)) {
  const rc = await pc.getTransactionReceipt({ hash: h as `0x${string}` });
  if (rc.status !== "success") throw new Error(`chain-fired stop capture tx ${h} is ${rc.status}`);
}
const csQuotes = !csBot ? "" : `<p class="mut">What the bot shows (its Telegram replies, copied as sent). ${esc(csBot.note)} Txs: open ${tx(csBot.txs.open!)}, arm ${tx(csBot.txs.arm!)}, disarm ${tx(csBot.txs.disarm!)}, close ${tx(csBot.txs.close!)}.</p>
${csBot.quotes.map((q) => `<div class="st"><span class="t">${t8(q.t)}</span><span class="who b">bot</span><code>${esc(q.cmd)}</code>${q.after ? ` <span>after ${esc(q.after)}</span>` : ""}</div><blockquote>${esc(q.text).replace(/\n/g, "<br>")}</blockquote>`).join("\n")}`;
const csHtml = !cs ? "" : `
<h2>${esc(cs.title)}</h2>
<p>The demo account ${ad(cs.account)} points its code at <a href="${EXPLORER_ADDR}${esc(cs.implementation.address)}">ExitGuard</a> (our ${cs.implementation.codeBytes}-byte contract, <a href="${REPO}/blob/main/chain/src/ExitGuard.sol">source</a>) with one EIP-7702 transaction, and arms a stop on itself. From then on Somnia Reactivity wakes the account every 5 s (a one-shot Schedule it renews on every wake) and every epoch; when the mark crosses the level, the account closes its own position. Nobody signs that close: it is a reactive transaction the validators add to the block. This run was made with the Telegram bot <b>stopped</b>.</p>
<ol class="steps">
<li><div class="st"><span class="t">${t8(cs.open.time)}</span><span class="who b">bot</span></div><div><code>/long HYPE 2 5x sl 1.5%</code> in Telegram: the bot opened 0.12 HYPE long through its linked key, as for any user (the bot-side SL at -1.5 % stays as a fallback) · ${tx(cs.open.tx)}</div></li>
<li><div class="st"><span class="t">${t8(cs.implementation.time)}</span><span class="who o">account owner</span></div><div>Deployed ExitGuard (${cs.implementation.gasUsed.toLocaleString("en-US")} gas) · ${tx(cs.implementation.deployTx)}</div></li>
<li><div class="st"><span class="t">${t8(cs.delegation.time)}</span><span class="who o">account owner</span></div><div>EIP-7702 (type-4) transaction: the account's code is now <code>0xef0100</code> + ExitGuard (authorization for chain ${cs.delegation.authorization.chainId}) · ${tx(cs.delegation.tx)}</div></li>
<li><div class="st"><span class="t">${t8(cs.arm.time)}</span><span class="who o">account owner</span></div><div>Armed the chain-fired stop: SL ${esc(cs.arm.sl)} (mark ${esc(cs.arm.markAtArm.toFixed(3))}), fills at most ${(cs.arm.slippageBps / 100).toFixed(2)} % from the mark, at most ${cs.arm.maxChecks.toLocaleString("en-US")} checks, expires ${esc(cs.arm.expiresAt.slice(11, 16))} UTC. Reactivity subscriptions owned by the account: <code>${esc(cs.arm.scheduleSubscription)}</code> (a wake-up in ${cs.arm.intervalMs / 1000} s, renewed on every wake) and <code>${esc(cs.arm.heartbeatSubscription)}</code> (every epoch) · ${tx(cs.arm.tx)}</div></li>
<li><div class="st"><span class="t">${t8(cs.botStopped)}</span><span class="who o">operator</span></div><div><code>systemctl --user stop ddmvp</code>: the bot process is stopped (systemd journal: "Stopped ddmvp.service")</div></li>
<li><div class="st"><span class="t">${t8(cs.fire.time)}</span><span class="who b">chain</span></div><div><b>${esc(cs.fire.kind)} fired by the chain</b> after ${cs.fire.checks.toLocaleString("en-US")} checks: mark ${esc(Number(cs.fire.mark.toFixed(4)))} at or below ${esc(cs.fire.trigger)}; the account sold its whole position in the same transaction (${cs.fire.poolOrderFilledLogs} fill${cs.fire.poolOrderFilledLogs === 1 ? "" : "s"}${cs.fire.avgFillPrice !== null ? ` at ${esc(cs.fire.avgFillPrice)}` : ""}), then removed both subscriptions${cs.fire.ended ? ` (${esc(cs.fire.ended.reason)})` : ""} · ${tx(cs.fire.tx)}</div></li>
<li><div class="st"><span class="t">${t8(cs.botStarted)}</span><span class="who o">operator</span></div><div><code>systemctl --user restart ddmvp</code>: the bot is back; it finds the position already closed</div></li>
</ol>
<div class="scroll"><table class="facts">
<thead><tr><th>check</th><th>what the chain shows</th></tr></thead>
<tbody>
<tr><td>Who sent the close</td><td>from ${ad(cs.fire.from)} (the subscription owner) to itself, input <code>onEvent(...)</code>, type ${esc(cs.fire.type)}, signature r = ${esc(cs.fire.signature.r)}, s = ${esc(cs.fire.signature.s)} (a placeholder: nobody signed it)</td></tr>
<tr><td>Reactive nonce</td><td><code>${esc(cs.fire.nonce)}</code> = block ${cs.fire.nonceBlock} &lt;&lt; 24 | queue position ${cs.fire.nonceQueueIndex}: a validator-made reactive transaction, not one of the account's own nonces</td></tr>
<tr><td>Account and bot key nonces</td><td>demo account ${esc(cs.noncesBefore.account)} → ${esc(cs.noncesAfter.account)}, bot key ${esc(cs.noncesBefore.botKey)} → ${esc(cs.noncesAfter.botKey)} across the window: neither key sent anything</td></tr>
<tr><td>Timings</td><td>armed → fired ${cs.timings.armToFireS} s · bot stopped → fired ${cs.timings.botStoppedToFireS} s · fired → bot back ${cs.timings.fireToBotStartS} s</td></tr>
<tr><td>Gas</td><td>delegation ${cs.delegation.gasUsed.toLocaleString("en-US")} · arm ${cs.arm.gasUsed.toLocaleString("en-US")} · the close ${cs.fire.gasUsed.toLocaleString("en-US")} at ${esc(cs.fire.effectiveGasPriceGwei)} gwei${cs.costs ? ` · the account paid ${esc(cs.costs.sttSpentArmToFire)} STT from arming to the fire (${cs.fire.checks} wake-ups at ~${esc(cs.costs.perWakeStt)} STT each, and ${esc(cs.costs.closeStt)} STT for the close)` : ""}</td></tr>
</tbody></table></div>
${csQuotes}
<p class="mut">This is ExitGuard version 3. Version 1 woke on every new order on the book and would have cost up to ~36 STT an hour on a busy book; version 2 never renewed its schedule. Both are retired; their transactions are in <a href="${REPO}/blob/main/evidence/exitguard_ops.jsonl">evidence/exitguard_ops.jsonl</a> and what each taught us is in the README.</p>
<p class="mut">Limits: one stop per account (one market) at a time; a check every 5 s, each paid by the account (about 0.0026 STT, ~1.8 STT an hour), and the account must keep 32 STT to renew its wake-up (below that the epoch heartbeat still checks every ~5 minutes); the level here was set 0.06 % under the mark so it would fire within minutes for this run. Testnet only.</p>
`;

const orders = [...ev.orders].sort((a, b) => (a.time < b.time ? 1 : -1));
const autoExits = ev.orders.filter((o) => o.kind === "close" && /^(take-profit|stop-loss|liquidation guard)/.test(o.reason ?? ""));
const measured = ev.orders.filter((o) => o.triggerToCloseS !== null).map((o) => o.triggerToCloseS!) ;
const lat = measured.length ? measured[measured.length - 1]! : undefined;
const days = new Set(ev.orders.map((o) => o.time.slice(0, 10)));
const latest = orders[0];
const sched = ev.orders.filter((o) => o.via === "schedule").length;
const kindOf = (o: Row) => {
  const r = o.reason ?? "";
  const k = r.startsWith("take-profit") ? "take-profit (bot)" : r.startsWith("stop-loss") ? "stop-loss (bot)" : r.startsWith("liquidation guard") ? "guard (bot)" : r.startsWith("scheduled flatten") ? "flatten (schedule)" : "";
  return `${esc(o.kind)}${k ? ` · ${k}` : ""}${o.via === "card" ? " · card copy" : o.via === "schedule" ? " · scheduled" : ""}`;
};

const rows = orders.map((o) => `<tr><td>${esc(o.time.slice(5, 16).replace("T", " "))}</td><td>${kindOf(o)}</td><td>${esc(o.market)} ${esc(o.side)}</td><td class="n">${esc(o.filled ?? "-")}</td><td class="n">${o.avgPrice === null ? "-" : esc(Number(o.avgPrice.toPrecision(7)))}</td><td>${tx(o.hash)}</td><td class="n">${esc(o.block)}</td><td>${o.verified ? `<span class="ok">${esc(o.status)}</span>` : `<span class="bad">${esc(o.status)}</span>`}</td><td class="n">${o.triggerToCloseS !== null ? `${o.triggerToCloseS.toFixed(1)} s` : ""}</td><td>${ad(o.account)}</td></tr>`).join("\n");
const steps = demo.steps.map((s) => `<li><div class="st"><span class="t">${esc(s.t.slice(11, 19))}</span><span class="who ${s.who === "bot" ? "b" : "o"}">${s.who === "bot" ? "bot" : "account owner"}</span></div><div>${esc(s.what)}${s.tx ? ` · ${tx(s.tx)}` : ""}</div>${s.quote ? `<blockquote>${esc(s.quote).replace(/\n/g, "<br>")}</blockquote>` : ""}</li>`).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Perps Copilot Evidence</title>
<meta name="description" content="Perps Copilot for dreamDEX: every order the Telegram bot sent on Somnia Tokyo testnet, re-read from the chain, and a live check of dreamDEX's chain-held TP/SL.">
<style>
:root { --bg:#fbfaf8; --fg:#1c1b19; --mut:#6b6760; --card:#ffffff; --line:#e6e2db; --acc:#3a5bd9; --ok:#1f7a4a; --bad:#b3261e; --q:#f2efe9; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141413; --fg:#ecebe8; --mut:#a19d95; --card:#1d1c1a; --line:#2e2c29; --acc:#8ea2ff; --ok:#5fcf8e; --bad:#ff8a80; --q:#25241f; } }
:root[data-theme="dark"] { --bg:#141413; --fg:#ecebe8; --mut:#a19d95; --card:#1d1c1a; --line:#2e2c29; --acc:#8ea2ff; --ok:#5fcf8e; --bad:#ff8a80; --q:#25241f; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.9rem; line-height:1.2; margin: 0 0 8px; letter-spacing:-0.01em; }
h2 { font-size: 1.25rem; margin: 40px 0 10px; }
p { margin: 8px 0; } .mut { color: var(--mut); }
a { color: var(--acc); text-decoration: none; } a:hover { text-decoration: underline; }
code { font: 0.86em/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
.links { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0 4px; }
.links a { border:1px solid var(--line); background:var(--card); padding:6px 12px; border-radius:999px; font-size:.93rem; }
.tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:12px; margin: 22px 0 8px; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.tile b { display:block; font-size:1.6rem; line-height:1.2; font-variant-numeric: tabular-nums; }
.tile span { color:var(--mut); font-size:.88rem; }
.try { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 18px; }
.try li { margin: 4px 0; }
ol.steps { list-style:none; padding:0; margin:0; border-left:2px solid var(--line); }
ol.steps li { position:relative; padding: 4px 0 14px 18px; }
ol.steps li::before { content:""; position:absolute; left:-6px; top:10px; width:10px; height:10px; border-radius:50%; background:var(--acc); }
.st { display:flex; gap:10px; align-items:center; font-size:.85rem; color:var(--mut); }
.who { padding:1px 8px; border-radius:999px; border:1px solid var(--line); }
.who.b { color:var(--acc); } .who.o { color:var(--mut); }
blockquote { margin:6px 0 0; padding:8px 12px; background:var(--q); border-radius:8px; font-size:.92rem; white-space:normal; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--card); }
table { border-collapse:collapse; width:100%; font-size:.86rem; min-width: 860px; }
th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--mut); font-weight:600; position:sticky; top:0; background:var(--card); }
td.n { text-align:right; font-variant-numeric: tabular-nums; }
table.facts { min-width: 0; } table.facts td, table.facts th { white-space: normal; vertical-align: top; } table.facts td:first-child { white-space: nowrap; }
.ok { color:var(--ok); } .bad { color:var(--bad); }
footer { margin-top:40px; color:var(--mut); font-size:.85rem; }
</style>
</head>
<body>
<main>
<h1>Perps Copilot for dreamDEX: evidence</h1>
<p>A Telegram copilot for dreamDEX perps on Somnia Tokyo testnet: one-line market orders, exits that close for you, liquidation alerts, PnL cards friends can copy, and a check of the TP/SL that dreamDEX's chain holds for you. Everything below is read back from the chain.</p>
<div class="links"><a href="${BOT}">Open @SwiftPerpsBot</a><a href="${REPO}">GitHub repo</a><a href="${esc(VIDEO)}">Demo video</a><a href="${REPO}/blob/main/evidence/orders.md">Order table (Markdown)</a><a href="${REPO}/blob/main/evidence/orders.csv">CSV</a></div>

<div class="tiles">
<div class="tile"><b>${ev.total}</b><span>orders the bot sent on chain, ${ev.verified} verified <code>success</code></span></div>
<div class="tile"><b>${autoExits.length}</b><span>exits the bot fired by itself (take-profit, stop-loss, guard)</span></div>
<div class="tile"><b>${lat !== undefined ? `${lat.toFixed(1)} s` : "n/a"}</b><span>from the pushed mark crossing a TP/SL level to the confirmed close (latest of ${measured.length} measured)</span></div>
<div class="tile"><b>${days.size}</b><span>days with orders; newest ${esc(latest?.time.slice(0, 16).replace("T", " "))} UTC${sched ? `, ${sched} scheduled` : ""}</span></div>
</div>

<h2>Try it in 60 seconds</h2>
<ol class="try">
<li><code>/try</code>: one real order in about 5 seconds on the bot's own testnet sandbox account. 12 USDso, closed by itself within 10 minutes; you get the tx link.</li>
<li><code>/demo</code>: the bot's own live account, its last orders with tx links and the live Reactivity streams. No wallet needed.</li>
<li><code>/stops 0xAnyAccount</code>: the dreamDEX TP/SL the chain holds for that account, and whether each one will close what it should. Read only.</li>
<li><code>/watch 0xAnyAccount</code>: liquidation pings for any account. Read only.</li>
<li><code>/start</code>, Link a bot in the dreamDEX app, then <code>/long ETH 20 5x tp 4% sl 2%</code>.</li>
</ol>

${csHtml}
<h2>${esc(demo.title)}</h2>
<p class="mut">Account ${ad(demo.account)}. ${esc(demo.note)}</p>
<ol class="steps">
${steps}
</ol>

<h2>Self-healing chain link</h2>
<p>On 2026-10-27 the bot's WebSocket client stopped reconnecting and every chain read failed for about 28 hours while the process looked healthy. Since 2026-10-29 a watchdog probes the chain every 30 s: 6 failed checks in a row rebuild the client and re-subscribe the Reactivity streams, 6 more stop the bot so systemd restarts it, and <code>/status</code> shows when the link was last verified. A test reproduces the failure with the real SDK and a local WebSocket server and shows the rebuild heals it.</p>

<h2>All orders</h2>
<p class="mut">Newest first. Each row re-read from its receipt by <code>scripts/evidence.ts</code>: status, sender = the linked bot key, and the <code>placeOrderFor</code> account. "trigger to close" is logged from 2026-10-29 on. Accounts: ${ev.accounts.map((a) => ad(a)).join(" (current demo account), ")} (earlier demo account).</p>
<div class="scroll"><table>
<thead><tr><th>UTC</th><th>action</th><th>market</th><th>filled</th><th>avg price</th><th>tx</th><th>block</th><th>status</th><th>trigger→close</th><th>account</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>

<footer>Generated ${esc(ev.generated.slice(0, 16).replace("T", " "))} UTC (orders) from chain ${ev.chainId} by <code>scripts/evidence.ts</code> and <code>scripts/evidence_page.ts</code>. Testnet tokens only. Not financial advice. Swift Bot Labs is not affiliated with dreamDEX or Somnia.</footer>
</main>
</body>
</html>
`;
writeFileSync("docs/index.html", html);

// The same numbers in README.md, between its evidence markers (nothing else in the README is touched).
const opens = ev.orders.filter((o) => o.kind === "open").length, closes = ev.orders.filter((o) => o.kind === "close").length;
const perDay = [...days].sort().map((d) => `${ev.orders.filter((o) => o.time.startsWith(d)).length} on ${d}`).join(", ");
const md = (o: Row) => `| ${o.time.slice(5, 16).replace("T", " ")} | ${kindOf(o).replace(/ · /g, ", ")} | ${o.market} ${o.side} | ${o.filled ?? "-"} | ${o.avgPrice === null ? "-" : Number(o.avgPrice.toPrecision(7))} | [\`${o.hash.slice(0, 10)}…\`](${EXPLORER_TX}${o.hash}) | ${o.status} | ${o.triggerToCloseS !== null ? `${o.triggerToCloseS.toFixed(1)} s` : ""} |`;
const blocks: Record<string, string> = {
  headline: `**Evidence.** ${ev.total} real orders sent by the bot, ${ev.verified} verified \`success\` on chain, ${autoExits.length} of them exits the bot fired by itself, on ${days.size} days (newest ${latest?.time.slice(0, 16).replace("T", " ")} UTC)${sched ? `, ${sched} of them scheduled demo trades` : ""}; scheduled demo trades keep adding three a day until Nov 1. ${lat !== undefined ? `Latest measured time from the pushed mark crossing a TP/SL level to the confirmed close: ${lat.toFixed(1)} s.` : ""}`,
  summary: `${ev.total} orders (${opens} opens, ${closes} closes), ${ev.verified}/${ev.total} verified \`success\`: ${perDay}. ${autoExits.length} closes were fired by the bot itself (take-profit, stop-loss or guard). All of them are on our own demo accounts; the bot has had no outside users yet. Generated ${ev.generated.slice(0, 16).replace("T", " ")} UTC.`,
  latest: `Newest ${Math.min(10, orders.length)} (all ${ev.total} in [evidence/orders.md](evidence/orders.md)):\n\n| UTC | action | market | filled | avg price | tx | status | trigger to close |\n|---|---|---|---|---|---|---|---|\n${orders.slice(0, 10).map(md).join("\n")}`,
};
if (cs) {
  const l = (h: string) => `[\`${h.slice(0, 10)}…\`](${EXPLORER_TX}${h})`;
  blocks.chainstop = [
    `| UTC (${cs.fire.time.slice(0, 10)}) | step | tx |`, "|---|---|---|",
    `| ${cs.open.time.slice(11, 19)} | \`/long HYPE 2 5x sl 1.5%\` in Telegram: the bot opens 0.12 HYPE through its linked key | ${l(cs.open.tx)} |`,
    `| ${cs.implementation.time.slice(11, 19)} | ExitGuard deployed (${cs.implementation.codeBytes} bytes, ${cs.implementation.gasUsed.toLocaleString("en-US")} gas) | ${l(cs.implementation.deployTx)} |`,
    `| ${cs.delegation.time.slice(11, 19)} | EIP-7702 type-4 tx: the demo account's code becomes \`0xef0100\` + ExitGuard (${cs.delegation.gasUsed.toLocaleString("en-US")} gas) | ${l(cs.delegation.tx)} |`,
    `| ${cs.arm.time.slice(11, 19)} | Armed on the account: SL ${cs.arm.sl} (mark ${cs.arm.markAtArm.toFixed(3)}), at most ${(cs.arm.slippageBps / 100).toFixed(2)} % slippage; Reactivity subscriptions ${cs.arm.scheduleSubscription} (a wake-up every ${cs.arm.intervalMs / 1000} s, renewed on each wake) and ${cs.arm.heartbeatSubscription} (every epoch) (${cs.arm.gasUsed.toLocaleString("en-US")} gas) | ${l(cs.arm.tx)} |`,
    `| ${cs.botStopped.slice(11, 19)} | \`systemctl --user stop ddmvp\`: bot process stopped | - |`,
    `| ${cs.fire.time.slice(11, 19)} | **${cs.fire.kind} fired by the chain** after ${cs.fire.checks.toLocaleString("en-US")} checks: mark ${Number(cs.fire.mark.toFixed(4))} <= ${cs.fire.trigger}, whole position sold${cs.fire.avgFillPrice !== null ? ` at ${cs.fire.avgFillPrice}` : ""} in the same transaction, both subscriptions removed. Reactive tx: from = to = the account, nonce \`${cs.fire.nonce}\` = block ${cs.fire.nonceBlock}, queue position ${cs.fire.nonceQueueIndex}, signature r = s = 0x1 (${cs.fire.gasUsed.toLocaleString("en-US")} gas) | ${l(cs.fire.tx)} |`,
    `| ${cs.botStarted.slice(11, 19)} | \`systemctl --user restart ddmvp\`: bot back, position already closed | - |`,
    "",
    `Armed to fired ${cs.timings.armToFireS} s, bot stopped to fired ${cs.timings.botStoppedToFireS} s. Nonces across the window: demo account ${cs.noncesBefore.account} → ${cs.noncesAfter.account}, bot key ${cs.noncesBefore.botKey} → ${cs.noncesAfter.botKey} (neither sent anything).${cs.costs ? ` From arming to the fire the account paid ${cs.costs.sttSpentArmToFire} STT: ${cs.fire.checks} wake-ups at ~${cs.costs.perWakeStt} STT each and ${cs.costs.closeStt} STT for the close.` : ""}`,
  ].join("\n");
}
let readme = readFileSync("README.md", "utf8");
for (const [k, v] of Object.entries(blocks)) {
  const re = new RegExp(`(<!-- evidence:${k} -->)[\\s\\S]*?(<!-- /evidence:${k} -->)`);
  if (!re.test(readme)) { if (k === "chainstop") continue; throw new Error(`README marker ${k} missing`); }
  readme = readme.replace(re, (_m, a: string, b: string) => `${a}\n${v}\n${b}`);
}
writeFileSync("README.md", readme);
writeFileSync("docs/.nojekyll", "");
console.log(`docs/index.html: ${ev.total} orders, ${autoExits.length} bot exits, ${demo.steps.length} demo steps, ${html.length} bytes`);
process.exit(0);
