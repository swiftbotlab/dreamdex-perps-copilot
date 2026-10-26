// Send hardening: outcome by phase (H3), one send at a time per key (H4), relink clears per-account state
// (H1), single instance (H9). T1 uses only venue.ts + operator.ts through namespaces, so it can also run
// against the old code (git stash) and fail there for the right reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { acquireInstanceLock } from "../src/instance.ts";

const V: Record<string, any> = await import("../src/venue.ts");
const HASH = `0x${"cd".repeat(32)}` as const;
const OWNER = "0x00000000000000000000000000000000000000aa";
const mkt = (pool: string) => ({ display: "SOL-PERP", symbol: "SOL/USDso:USDso", info: { poolAddress: pool, baseDecimals: 2, tickSize: "1", minQuantity: "1" } });
const M = mkt("0x1111111111111111111111111111111111111111");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A TradingKey whose clients are fakes: each step can be made to fail. */
function fakeKey(o: { simulate?: () => Promise<unknown>; write?: () => Promise<string>; wait?: (a: { hash: string; timeout?: number }) => Promise<unknown> } = {}, operator = "0x00000000000000000000000000000000000000b1") {
  return {
    owner: OWNER, operator, account: { address: operator },
    publicClient: {
      simulateContract: async () => (o.simulate ? o.simulate() : { request: {} }),
      waitForTransactionReceipt: async (a: { hash: string; timeout?: number }) => (o.wait ? o.wait(a) : { status: "success", logs: [] }),
    },
    walletClient: { writeContract: async () => (o.write ? o.write() : HASH) },
  };
}
const send = (v: any, tk: unknown, m = M) => v.send(tk, m, "long", 1n, 1n) as Promise<unknown>;
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { hash?: string }; } throw new Error("expected a rejection"); };

test("T1a (control): a simulate-time revert says nothing was sent", async () => {
  const e = await errOf(send(new V.Venue(), fakeKey({ simulate: async () => { throw new Error('The contract function "placeOrderFor" reverted.\n\nError: ImmediateOrCancelNoFill()'); } })));
  assert.match(e.message, /Nothing was sent/);
  assert.ok(!V.OutcomeUnknown || !(e instanceof V.OutcomeUnknown));
});

test("T1b: tx posted, receipt wait times out -> outcome unknown with the hash, never 'Nothing was sent'", async () => {
  let timeoutSeen: number | undefined;
  const e = await errOf(send(new V.Venue(), fakeKey({ wait: async (a) => { timeoutSeen = a.timeout; throw new Error(`Timed out while waiting for transaction with hash "${a.hash}" to be confirmed.`); } })));
  assert.doesNotMatch(e.message, /Nothing was sent/);
  assert.match(e.message, new RegExp(HASH));
  assert.match(e.message, /will not resend/);
  assert.ok(V.OutcomeUnknown && e instanceof V.OutcomeUnknown);
  assert.equal(e.hash, HASH);
  assert.equal(timeoutSeen, 60_000);
});

test("T1c: the raw send fails ('already known') -> outcome unknown, never 'Nothing was sent'", async () => {
  const e = await errOf(send(new V.Venue(), fakeKey({ write: async () => { throw new Error("already known"); } })));
  assert.ok(e instanceof V.OutcomeUnknown);
  assert.doesNotMatch(e.message, /Nothing was sent/);
  assert.match(e.message, /could not confirm/);
});

test("T1d: a node 'insufficient funds' refusal of the raw tx and a mined revert keep their exact meaning", async () => {
  const gas = await errOf(send(new V.Venue(), fakeKey({ write: async () => { throw new Error("insufficient funds for gas * price + value"); } })));
  assert.ok(!(gas instanceof V.OutcomeUnknown));
  assert.match(gas.message, /no STT for gas/);
  const rev = await errOf(send(new V.Venue(), fakeKey({ wait: async () => ({ status: "reverted", logs: [] }) })));
  assert.ok(!(rev instanceof V.OutcomeUnknown));
  assert.match(rev.message, new RegExp(`reverted on chain: tx ${HASH}`));
});

test("T1e: writes are never retried by the transport; reads keep viem's retries", async () => {
  const { createTradingKey } = await import("../src/vendor/perp-core/operator.ts");
  const { generatePrivateKey } = await import("viem/accounts");
  const tk = createTradingKey({ owner: OWNER, privateKey: generatePrivateKey(), chain: V.chain, rpcUrl: "http://127.0.0.1:9" });
  assert.equal((tk.walletClient.transport as { retryCount?: number }).retryCount, 0);
  assert.equal((tk.publicClient.transport as { retryCount?: number }).retryCount, 3);
});

/** writeContract reads the key's nonce, waits, then increments it: overlapping sends of one key collide. */
function nonceKeys() {
  const nonce = new Map<string, number>(), used: number[] = [];
  const key = (op: string) => fakeKey({ write: async () => { const n = nonce.get(op) ?? 0; await sleep(40); used.push(n); nonce.set(op, n + 1); return HASH; } }, op);
  return { key, used };
}

test("T2: one send at a time per trading key: two pools, one key -> nonces 0 and 1; two keys run in parallel", async () => {
  const v = new V.Venue();
  const { key, used } = nonceKeys();
  const tk = key("0x00000000000000000000000000000000000000c1");
  await Promise.all([send(v, tk, mkt("0x2222222222222222222222222222222222222222")), send(v, tk, mkt("0x3333333333333333333333333333333333333333"))]);
  assert.deepEqual(used.sort(), [0, 1]);
  const t0 = Date.now();
  await Promise.all([send(v, key("0x00000000000000000000000000000000000000c2")), send(v, key("0x00000000000000000000000000000000000000c3"))]);
  assert.ok(Date.now() - t0 < 70, `different keys must not wait for each other (${Date.now() - t0} ms)`);
});

test("T2 (positive control): with a pass-through lock the same two sends collide on nonce 0", async () => {
  const v = new V.Venue();
  v.sendLock = { run: (_k: string, f: () => Promise<unknown>) => f() };
  const { key, used } = nonceKeys();
  const tk = key("0x00000000000000000000000000000000000000c4");
  await Promise.all([send(v, tk), send(v, tk, mkt("0x4444444444444444444444444444444444444444"))]);
  assert.deepEqual(used, [0, 0]);
});

async function relinkSetup() {
  const H = await import("./_harness.ts");
  const { Protector } = await import("../src/protect.ts");
  const h = H.makeBot();
  const X = H.addr(0xa1), Y = H.addr(0xa2);
  h.state.positions.set(X, [{ base: "ETH", side: "long", size: 1, entry: 2000, liq: 1000 }]);
  h.state.positions.set(Y, [{ base: "ETH", side: "long", size: 1, entry: 2000, liq: 1000 }]);
  const acts: string[] = [];
  const p = new Protector(h.bot.venue, h.bot.store, async (u, base) => { acts.push(`${u.owner}:${base}`); }, async () => {}, () => {});
  (p as any).subscribe = async () => {};
  h.bot.protector = p;
  const u = h.addUser(1, X);
  u.rules.ETH = { side: "long", sl: 1900, setAt: 0 };
  u.opens.ETH = { margin: 20, leverage: 5, at: 0 };
  u.lastClosed = { base: "SOL", side: "long", entry: 100, exit: 101, size: 1, pnl: 1, at: 0, reason: "manual close" };
  u.pendingCopy = { card: "aaaaaaaaaa", at: Date.now() };
  return { h, p, u, X, Y, acts, pool: H.POOLS.ETH! };
}

test("T3: relinking to another account clears TP/SL, opens, lastClosed and pendingCopy; the old SL never fires", async () => {
  const { h, p, u, Y, acts, pool } = await relinkSetup();
  await h.bot.attach(u, 1, Y);
  assert.equal(u.owner, Y);
  assert.deepEqual(u.rules, {});
  assert.deepEqual(u.opens, {});
  assert.equal(u.lastClosed, undefined);
  assert.equal(u.pendingCopy, undefined);
  await p.onMark(pool, 1850); // below the old account's SL 1900, on the new account's ETH long
  assert.deepEqual(acts, []);
});

test("T3 (positive control): re-linking the SAME account keeps the rules, and the SL fires once", async () => {
  const { h, p, u, X, acts, pool } = await relinkSetup();
  await h.bot.attach(u, 1, X);
  assert.equal(u.rules.ETH?.sl, 1900);
  await p.onMark(pool, 1850);
  assert.deepEqual(acts, [`${X}:ETH`]);
});

test("unlink also clears opens, lastClosed and pendingCopy", async () => {
  const { h, u } = await relinkSetup();
  await h.bot.cmdUnlink(u, 1);
  assert.equal(u.owner, undefined);
  assert.deepEqual([u.rules, u.opens, u.lastClosed, u.pendingCopy], [{}, {}, undefined, undefined]);
});

test("unknown close outcome: logged as 'unknown', the same size is blocked for 20 s, and nothing is resent", async () => {
  const H = await import("./_harness.ts");
  const h = H.makeBot();
  const owner = H.addr(0xa3);
  const u = h.addUser(2, owner);
  let sends = 0;
  h.bot.venue.close = async (_tk: unknown, _b: string, _f: number, _l: unknown, guard?: (a: number, s: string) => void) => {
    guard?.(1.5, "long");
    sends++;
    throw new H.venueMod.OutcomeUnknown(`The order was sent (tx ${H.HASH}) but its result is not confirmed yet. Check /positions; I will not resend it.`, H.HASH);
  };
  await assert.rejects(h.bot.autoClose(u, "ETH", 1, "stop-loss 1,900.00 reached", { kind: "sl", side: "long" }), /not confirmed/);
  assert.equal(sends, 1);
  const warn = h.to(2).at(-1)!.html;
  assert.match(warn, /not confirmed yet/);
  assert.doesNotMatch(warn, /keep retrying/);
  // The Protector's next attempt within 20 s reads the same size: refused before anything is sent.
  await assert.rejects(h.bot.doClose(u, 2, "ETH", 1, "stop-loss", { expectSide: "long", auto: true }), /just went through/);
  assert.equal(sends, 1); // the guard refused before the fake's send step
  const rows = readFileSync(`${H.PATHS.data}/orders.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.kind, r.intent, r.hash, r.market, r.side]), [["unknown", "close", H.HASH, "ETH-PERP", "short"]]);
});

test("unknown open outcome is logged as 'unknown' (intent open) and the user is told not to retry blindly", async () => {
  const H = await import("./_harness.ts");
  const h = H.makeBot();
  const u = h.addUser(3, H.addr(0xa4));
  h.bot.venue.open = async () => { throw new H.venueMod.OutcomeUnknown("I could not confirm that the order reached the chain. Check /positions before you try again; I will not resend it."); };
  await h.handle(H.msg(3, "/long ETH 20 5x"));
  assert.match(h.to(3).at(-1)!.html, /could not confirm/);
  const rows = readFileSync(`${H.PATHS.data}/orders.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.kind, r.intent, r.hash]), [["unknown", "open", undefined]]);
  assert.equal(u.opens.ETH, undefined);
});

test("T4: a second instance is refused; release removes the lock file", () => {
  const dir = mkdtempSync(`${tmpdir()}/ddmvp-lock-`);
  const release = acquireInstanceLock(dir, { beatMs: 1_000, staleMs: 12_000 });
  assert.ok(existsSync(`${dir}/instance.lock`));
  assert.throws(() => acquireInstanceLock(dir, { beatMs: 1_000, staleMs: 12_000 }), /another instance/);
  release();
  assert.equal(existsSync(`${dir}/instance.lock`), false);
  acquireInstanceLock(dir, { beatMs: 1_000, staleMs: 12_000 })(); // free again after release
});

test("T4 (positive control): a lock whose heartbeat is 30 s old is taken over", () => {
  const dir = mkdtempSync(`${tmpdir()}/ddmvp-lock-`);
  writeFileSync(`${dir}/instance.lock`, "999999:dead");
  const old = new Date(Date.now() - 30_000);
  utimesSync(`${dir}/instance.lock`, old, old);
  const release = acquireInstanceLock(dir, { beatMs: 1_000, staleMs: 12_000 });
  assert.notEqual(readFileSync(`${dir}/instance.lock`, "utf8"), "999999:dead");
  release();
});

test("instance lock: the heartbeat keeps it fresh; a lock taken over by another process is reported lost, not deleted", async () => {
  const dir = mkdtempSync(`${tmpdir()}/ddmvp-lock-`);
  let lost = 0;
  const release = acquireInstanceLock(dir, { beatMs: 30, staleMs: 12_000, onLost: () => { lost++; } });
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${dir}/instance.lock`, old, old);
  await sleep(80);
  assert.ok(Date.now() - (await import("node:fs")).statSync(`${dir}/instance.lock`).mtimeMs < 5_000, "heartbeat refreshed the mtime");
  writeFileSync(`${dir}/instance.lock`, "other:token");
  await sleep(80);
  assert.equal(lost, 1);
  release();
  assert.equal(readFileSync(`${dir}/instance.lock`, "utf8"), "other:token");
});
