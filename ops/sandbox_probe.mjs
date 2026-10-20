// Run through run_sandboxed.sh to prove what the jail allows. With --no-guard it is the positive
// control: the same probes without ops/guard.cjs show which blocks come from the guard.
import net from "node:net";
import fs from "node:fs";
import cp from "node:child_process";
const t = async (name, f) => { try { console.log(name, "->", await f()); } catch (e) { console.log(name, "-> BLOCKED", String(e.message ?? e).slice(0, 80)); } };
const tcp = (host, port) => new Promise((res, rej) => { const s = net.connect({ host, port }); s.setTimeout(4000); s.on("connect", () => { s.destroy(); res("CONNECTED"); }); s.on("error", rej); s.on("timeout", () => { s.destroy(); rej(new Error("timeout")); }); });
await t("rpc eth_chainId (somnia)", async () => (await (await fetch("https://api.hideki2.infra.testnet.somnia.network", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })).text()).slice(0, 60));
await t("telegram api reachable", async () => (await fetch("https://api.telegram.org/bot0:x/getMe", { redirect: "manual" })).status + " (401/404 = reached)");
await t("other host (example.com)", async () => (await fetch("https://example.com/")).status);
await t("loopback 127.0.0.1:9222 (DevTools)", () => tcp("127.0.0.1", 9222));
await t("localhost:9222", () => tcp("localhost", 9222));
await t("list secrets dir", () => fs.readdirSync("/home/agent/agent/secrets").length + " entries");
await t("read a file elsewhere in $HOME (~/agent/CHARTER.md)", () => fs.readFileSync("/home/agent/agent/CHARTER.md", "utf8").length + " bytes");
await t("read bot token file", () => fs.readFileSync("/home/agent/agent/secrets/ddmvp_bot.env", "utf8").length + " bytes (expected: readable)");
await t("list $HOME", () => fs.readdirSync("/home/agent").join(","));
await t("write product dir", () => { fs.writeFileSync("/home/agent/agent/products/dreamdex-mvp/x_probe", "x"); return "WROTE"; });
await t("write data/", () => { fs.writeFileSync("/home/agent/agent/products/dreamdex-mvp/data/.probe", "x"); fs.unlinkSync("/home/agent/agent/products/dreamdex-mvp/data/.probe"); return "WROTE (expected)"; });
await t("spawn /usr/bin/id", () => cp.execFileSync("/usr/bin/id").toString().trim());
process.exit(0);
