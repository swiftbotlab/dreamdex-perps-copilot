// Chain-link watchdog: the state machine with fake clients, the bot wiring, and a real viem/SDK socket that
// gets stuck exactly like production (server gone until viem stops reconnecting) and is healed by closeSockets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";
import { RpcWatchdog } from "../src/watchdog.ts";
import { createPublicClient, webSocket } from "viem";
import { socketClientCache } from "viem/utils";
import { makeBot, venueMod } from "./_harness.ts";
import { PUSH_WS_OPTS, pushSocketId } from "../src/protect.ts";

function fake(opts: { failLimit?: number; exitAfter?: number; probeTimeoutMs?: number } = {}) {
  const st = { ok: true, hang: false, rebuilds: 0, exits: [] as number[], logs: [] as string[], probes: 0 };
  const w = new RpcWatchdog({
    probe: async () => {
      st.probes++;
      if (st.hang) await new Promise(() => {});
      if (!st.ok) throw new Error("RpcError: @somnia-chain/markets-sdk: rpc getBlockNumber failed: WebSocket request failed.");
    },
    rebuild: async () => { st.rebuilds++; },
    exit: (c) => { st.exits.push(c); },
    log: (...a: unknown[]) => { st.logs.push(a.map(String).join(" ")); },
    ...opts,
  });
  return { w, st };
}

test("WD1: 5 failed rounds do nothing, the 6th rebuilds once; 6 more after the rebuild exit 75 once", async () => {
  const { w, st } = fake();
  st.ok = false;
  for (let i = 0; i < 5; i++) assert.equal(await w.round(), "fail");
  assert.equal(st.rebuilds, 0);
  assert.equal(await w.round(), "rebuilt");
  assert.equal(st.rebuilds, 1);
  assert.match(st.logs.at(-1)!, /6 failed checks in a row \(last: RpcError.*WebSocket request failed.*rebuilding the chain clients/);
  for (let i = 0; i < 5; i++) assert.equal(await w.round(), "fail");
  assert.deepEqual(st.exits, []);
  assert.equal(await w.round(), "exit");
  assert.deepEqual(st.exits, [75]);
  assert.match(st.logs.at(-1)!, /still failing 6 checks after the rebuild .* exiting 75 so systemd restarts the bot/);
  assert.equal(await w.round(), "exit");
  assert.deepEqual(st.exits, [75], "exit is requested once");
  assert.equal(st.rebuilds, 1, "no second rebuild");
});

test("WD2: a success resets the streak; recovery after a rebuild logs one line and arms a fresh cycle", async () => {
  const { w, st } = fake();
  st.ok = false;
  for (let i = 0; i < 5; i++) await w.round();
  st.ok = true;
  assert.equal(await w.round(), "ok");
  assert.match(st.logs.at(-1)!, /^rpc watchdog: chain reads recovered after \d+ s$/);
  st.ok = false;
  for (let i = 0; i < 5; i++) await w.round();
  assert.equal(st.rebuilds, 0, "5 + 5 failures with a success between: no rebuild");
  await w.round();
  assert.equal(st.rebuilds, 1);
  st.ok = true;
  const before = st.logs.length;
  assert.equal(await w.round(), "ok");
  assert.equal(st.logs.length, before + 1, "exactly one line for the recovery");
  assert.match(st.logs.at(-1)!, /recovered after \d+ s \(after a client rebuild\)/);
  assert.ok(w.healthy);
  // A new outage starts from scratch: rebuild again before any exit.
  st.ok = false;
  for (let i = 0; i < 6; i++) await w.round();
  assert.equal(st.rebuilds, 2);
  assert.deepEqual(st.exits, []);
  assert.equal(w.healthy, false);
});

test("WD3: a probe that hangs counts as a failure (timeout), and an all-failed sweep counts even if the probe answers", async () => {
  const { w, st } = fake({ probeTimeoutMs: 20 });
  st.hang = true;
  assert.equal(await w.round(), "fail");
  assert.match(w.lastError!, /timed out after 20 ms/);
  st.hang = false;
  assert.equal(await w.round({ failed: true, error: "refresh failed RpcError: getAccountState took too long" }), "fail");
  assert.equal(w.failures, 2);
  assert.match(w.lastError!, /getAccountState/);
  assert.equal(await w.round({ failed: false }), "ok");
  assert.equal(w.failures, 0);
});

test("WD4: the bot wiring: a dead chain client is rebuilt (streams re-subscribed), then the bot stops with exit code 75", async () => {
  const h = makeBot();
  let rebuilds = 0, resets = 0, probes = 0;
  h.bot.venue.probe = async () => { probes++; throw new Error("WebSocket request failed."); };
  h.bot.venue.rebuildClient = async () => { rebuilds++; return 2; };
  h.bot.protector.resetStreams = () => { resets++; };
  h.bot.protector.sweepFailed = () => ({ failed: false });
  for (let i = 0; i < 6; i++) await h.bot.watchdogRound();
  assert.equal(rebuilds, 1);
  assert.equal(resets, 1, "push streams re-subscribed on the rebuild");
  assert.equal(h.bot.stopping, false);
  for (let i = 0; i < 6; i++) await h.bot.watchdogRound();
  assert.equal(probes, 12);
  assert.equal(h.bot.stopping, true, "the bot stops taking work");
  assert.equal(h.bot.exitCode, 75);
  // /status-style line reflects the degraded link while it lasts
  assert.match(h.bot.linkLine(), /degraded/);
});

test("WD5: the bot wiring: an all-failed sweep feeds the watchdog; a healthy probe and sweep keep it OK", async () => {
  const h = makeBot();
  let rebuilds = 0;
  h.bot.venue.probe = async () => {};
  h.bot.venue.rebuildClient = async () => { rebuilds++; return 0; };
  h.bot.protector.resetStreams = () => {};
  h.bot.protector.sweepFailed = () => ({ failed: true, error: "refresh failed" });
  for (let i = 0; i < 6; i++) await h.bot.watchdogRound();
  assert.equal(rebuilds, 1);
  h.bot.protector.sweepFailed = () => ({ failed: false });
  await h.bot.watchdogRound();
  assert.match(h.bot.linkLine(), /^Chain link: OK, last verified \d+ s ago$/);
});

// ---------- real socket: reproduce the production failure and heal it ----------
async function freePort(): Promise<number> {
  return new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
}
function rpcServer(port: number): Promise<WebSocketServer> {
  return new Promise((res) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port }, () => res(wss));
    wss.on("connection", (c) => c.on("message", (m) => {
      const req = JSON.parse(String(m)) as { id: number; method: string };
      c.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method === "eth_blockNumber" ? "0x2a" : "0x1" }));
    }));
  });
}
const stopServer = (wss: WebSocketServer) => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); });

test("WD6 (real socket): the SDK's client stays dead after its server returns; closeSockets() heals it (positive control)", { timeout: 60_000 }, async () => {
  const { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } = await import("@somnia-chain/markets-sdk");
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  let wss = await rpcServer(port);
  const ex = new SomniaMarkets({ indexerUrl: "http://127.0.0.1:9/v1/graphql", chain: venueMod.chain, wsRpcUrl: url, addresses: SOMNIA_TESTNET_ADDRESSES });
  const read = () => ex.client.getViemClient().getBlockNumber({ cacheTime: 0 });
  const quiet = console.error; console.error = () => {}; // viem prints each failed reconnect
  try {
    assert.equal(await read(), 42n, "healthy at first");
    await stopServer(wss);
    // viem retries 5 times, 2 s apart, then gives up and keeps the dead socket cached.
    await new Promise((r) => setTimeout(r, 14_000));
    wss = await rpcServer(port);
    await new Promise((r) => setTimeout(r, 2_500));
    await assert.rejects(read(), /unknown RPC error|WebSocket|socket|closed/i, "positive control: still stuck although the server is back");
    await assert.rejects(read(), /unknown RPC error|WebSocket|socket|closed/i, "and it stays stuck");
    const closed = venueMod.closeSockets(url);
    assert.ok(closed >= 1, `closed ${closed} cached socket(s)`);
    assert.equal(await read(), 42n, "a fresh socket after closeSockets()");
  } finally {
    console.error = quiet;
    venueMod.closeSockets(url);
    await ex.close().catch(() => {});
    await stopServer(wss);
  }
});

test("WD7 (real socket): pushSocketId names exactly the push client's cached socket, so a push reset leaves the SDK's socket alone", { timeout: 30_000 }, async () => {
  const { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES } = await import("@somnia-chain/markets-sdk");
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const wss = await rpcServer(port);
  const push = createPublicClient({ chain: venueMod.chain, transport: webSocket(url, { ...PUSH_WS_OPTS, timeout: 5_000 }) });
  const ex = new SomniaMarkets({ indexerUrl: "http://127.0.0.1:9/v1/graphql", chain: venueMod.chain, wsRpcUrl: url, addresses: SOMNIA_TESTNET_ADDRESSES });
  try {
    assert.equal(await push.getBlockNumber({ cacheTime: 0 }), 42n);
    assert.equal(await ex.client.getViemClient().getBlockNumber({ cacheTime: 0 }), 42n);
    const mine = [...socketClientCache.entries()].filter(([, c]) => c.url === url);
    assert.equal(mine.length, 2, "two sockets for one URL: push + SDK");
    assert.ok(socketClientCache.has(pushSocketId(url)), "the id matches viem's");
    socketClientCache.get(pushSocketId(url))!.close();
    assert.equal([...socketClientCache.values()].filter((c) => c.url === url).length, 1, "the SDK's socket is untouched");
    assert.equal(await ex.client.getViemClient().getBlockNumber({ cacheTime: 0 }), 42n, "SDK reads still work");
    assert.equal(await push.getBlockNumber({ cacheTime: 0 }), 42n, "the push client reopens on its next request");
  } finally {
    venueMod.closeSockets(url);
    await ex.close().catch(() => {});
    await stopServer(wss);
  }
});
