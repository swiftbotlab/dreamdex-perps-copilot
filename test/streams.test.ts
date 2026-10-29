// Push-stream self-heal and the sweep signal the watchdog reads (Protector, fake venue, fake socket).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Protector } from "../src/protect.ts";
import { Store } from "../src/store.ts";

const POOL = "0xd6cb1dd58580b84d76068ac21594219ce03aeddf";
function setup(opts: { accountFails?: () => boolean } = {}) {
  const store = new Store(mkdtempSync(`${tmpdir()}/ddmvp-st-`));
  const u = store.add({ id: 7, created: 0, keyAddress: "0x0000000000000000000000000000000000000001", key: { v: 1, iv: "", ct: "", tag: "" } });
  u.owner = "0x0000000000000000000000000000000000000002";
  const market = { display: "ETH-PERP", info: { poolAddress: POOL } };
  const venue = {
    account: async () => {
      if (opts.accountFails?.()) throw new Error("RpcError: @somnia-chain/markets-sdk: rpc getBlockNumber failed: WebSocket request failed.");
      return { positions: [{ base: "ETH", pool: POOL, side: "long", size: 0.01, entry: 2000, mark: 2000, upnl: 0, notional: 20, liq: 1500 }] };
    },
    marketByPool: (p: string) => (p.toLowerCase() === POOL ? market : undefined),
    baseOf: () => "ETH",
    mark: async () => 2000,
  };
  const logs: string[] = [];
  const p = new Protector(venue as never, store, async () => {}, async () => {}, (...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  const sock = { subscribeOk: false, subscribes: 0 };
  (p as unknown as { ws: unknown }).ws = {
    transport: {
      subscribe: async () => {
        sock.subscribes++;
        if (!sock.subscribeOk) throw new Error("An unknown RPC error occurred.");
        return { unsubscribe: async () => {} };
      },
    },
  };
  return { store, u, p, logs, sock };
}
const subs = (p: Protector) => (p as unknown as { subs: Map<string, { startedAt: number; lastPush: number }> }).subs;
const ageAll = (p: Protector, ms: number) => { for (const s of subs(p).values()) { s.startedAt -= ms; s.lastPush = 0; } };
const tick = () => new Promise((r) => setTimeout(r, 5));

test("ST1: after 3 failed subscribes in a row the push socket is reopened once (one log line), then streams retry", async () => {
  const s = setup();
  await s.p.refreshUser(s.u);
  await tick();
  assert.equal(s.sock.subscribes, 1);
  const fallback = () => (s.p as unknown as { fallback: () => Promise<void> }).fallback();
  for (let i = 0; i < 2; i++) { ageAll(s.p, 100_000); await fallback(); await tick(); }
  assert.equal(s.sock.subscribes, 3);
  assert.equal(s.logs.filter((l) => l.startsWith("push streams:")).length, 0, "no reset before the 3rd failure is counted");
  ageAll(s.p, 100_000); await fallback(); await tick();
  const resets = s.logs.filter((l) => l.startsWith("push streams:"));
  assert.equal(resets.length, 1);
  assert.match(resets[0]!, /3 subscribe failures in a row; reopened the WebSocket/);
  assert.equal(s.p.stats.streamResets, 1);
  // The socket works again: the next subscribe succeeds and the streak stays at zero.
  s.sock.subscribeOk = true;
  ageAll(s.p, 100_000); await fallback(); await tick();
  assert.equal(s.logs.filter((l) => l.startsWith("push streams:")).length, 1, "no second reset");
  assert.equal(s.p.watching().length, 1);
});

test("ST2: resetStreams drops and re-creates every subscription", async () => {
  const s = setup();
  s.sock.subscribeOk = true;
  await s.p.refreshUser(s.u);
  await tick();
  const before = s.sock.subscribes;
  s.p.resetStreams();
  await tick();
  assert.equal(s.sock.subscribes, before + 1);
  assert.equal(s.p.watching().length, 1);
  assert.equal(s.p.stats.streamResets, 1);
});

test("ST3: sweepFailed is true only when every account read of a recent sweep failed", async () => {
  let fail = true;
  const s = setup({ accountFails: () => fail });
  const sweep = () => (s.p as unknown as { sweep: () => Promise<void> }).sweep();
  assert.deepEqual(s.p.sweepFailed(), { failed: false }, "no sweep yet");
  await sweep();
  const f = s.p.sweepFailed();
  assert.equal(f.failed, true);
  assert.match(f.error!, /WebSocket request failed/);
  fail = false;
  await sweep();
  assert.equal(s.p.sweepFailed().failed, false);
  // A stale sweep result is ignored.
  fail = true; await sweep();
  s.p.lastSweep!.at -= 10 * 60_000;
  assert.equal(s.p.sweepFailed().failed, false);
});
