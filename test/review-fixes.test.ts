// Fixes from the 2026-10-26 review of commit 4e5c299 (security, correctness and product passes).
// Every test here failed on 4e5c299 for the reason in its name; each fix keeps a positive control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { keccak256 } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { addr, cb, HASH, LIMITS, makeBot, msg, PATHS, POOLS, Store, venueMod } from "./_harness.ts";
import { Protector } from "../src/protect.ts";
import { createTradingKey } from "../src/vendor/perp-core/operator.ts";

type H = ReturnType<typeof makeBot>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = () => { try { return readFileSync(`${PATHS.data}/orders.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const last = (h: H, id: number) => h.to(id).at(-1)!.html;
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { hash?: string }; } throw new Error("expected a rejection"); };
function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }
async function atTime<T>(t: number, f: () => Promise<T>): Promise<T> { const real = Date.now; Date.now = () => t; try { return await f(); } finally { Date.now = real; } }

/** A fake venue.close on the harness positions: closes `fraction`, records the account it traded. */
function fakeClose(h: H, closes: string[] = [], hold?: Promise<void>) {
  h.bot.venue.close = async (tk: { owner: string }, base: string, fraction: number, _l: unknown, guard?: (a: number, s: string) => void) => {
    const list = h.state.positions.get(tk.owner.toLowerCase()) ?? [];
    const p = list.find((x) => x.base === base);
    if (!p) throw new venueMod.UserError(`No open ${base}-PERP position.`);
    guard?.(p.size, p.side);
    if (hold) await hold;
    const prev = p.size, qty = p.size * fraction;
    p.size -= qty;
    if (p.size <= 1e-12) list.splice(list.indexOf(p), 1);
    closes.push(`${tk.owner}:${base}`);
    return { hash: HASH, filledBase: qty, avgPrice: h.state.mark, requestedBase: qty, base, side: p.side === "long" ? "short" : "long", realizedPnl: 0, entry: p.entry, prevSize: prev };
  };
  return closes;
}

function realProtector(h: H) {
  const acts: string[] = [], warns: string[] = [];
  const p = new Protector(h.bot.venue, h.bot.store, async (u, base) => { acts.push(`${u.owner}:${base}`); }, async (_u, _b, t) => { warns.push(t); }, () => {});
  (p as any).subscribe = async () => {};
  h.bot.protector = p;
  return { p, acts, warns };
}

// ---------- F1: relink / unlink leave no stale Protector state; Close buttons are bound to their account ----------
test("F1 relink: during attach the guard never acts on the new account with the old account's liquidation price", async () => {
  const h = makeBot();
  const X = addr(0xa1), Y = addr(0xa2);
  h.state.positions.set(X, [{ base: "ETH", side: "long", size: 1, entry: 2000, liq: 1900 }]);
  h.state.positions.set(Y, [{ base: "ETH", side: "long", size: 1, entry: 2000, liq: 500 }]);
  const { p, acts } = realProtector(h);
  const u = h.addUser(1, X);
  u.guardPct = 3;
  await p.refreshUser(u);
  const g = gate();
  const gas = h.bot.venue.gasBalance;
  h.bot.venue.gasBalance = async (a: string) => { await g.p; return gas(a); };
  const linking = h.bot.attach(u, 1, Y);
  await sleep(10);
  assert.equal(u.owner, Y, "attach is waiting on its reads with the new owner set");
  await p.onMark(POOLS.ETH!, 1950); // 2.6% from X's liquidation, 74% from Y's
  g.open(); await linking;
  assert.deepEqual(acts, []);
  await p.onMark(POOLS.ETH!, 510); // control: Y's own position 1.96% from ITS liquidation does trigger the guard
  assert.deepEqual(acts, [`${Y}:ETH`]);
});

test("F1 relink: a sweep read of the old account that lands after the relink is dropped", async () => {
  const h = makeBot();
  const X = addr(0xa1), Y = addr(0xa2);
  h.state.positions.set(X, [{ base: "ETH", side: "long", size: 1, entry: 2000, liq: 1000 }]);
  h.state.positions.set(Y, [{ base: "ETH", side: "long", size: 1, entry: 2000, liq: 500 }]);
  const { p, acts } = realProtector(h);
  const u = h.addUser(1, X);
  u.guardPct = 3;
  const g = gate();
  const account = h.bot.venue.account;
  h.bot.venue.account = async (o: string) => { if (o.toLowerCase() === X) await g.p; return account(o); };
  const sweep = p.refreshUser(u); // a slow read of X
  await h.bot.attach(u, 1, Y);
  g.open(); await sweep;           // X's view arrives after the relink
  await p.onMark(POOLS.ETH!, 1020);
  assert.deepEqual(acts, []);
});

test("F1 unlink: a read in flight during /unlink adds no stale position, so no warnings about the old account", async () => {
  const h = makeBot();
  const X = addr(0xa1);
  h.state.positions.set(X, [{ base: "ETH", side: "long", size: 1, entry: 2000, liq: 1900 }]);
  const { p, warns } = realProtector(h);
  const u = h.addUser(1, X);
  const g = gate();
  const account = h.bot.venue.account;
  h.bot.venue.account = async (o: string) => { await g.p; return account(o); };
  const sweep = p.refreshUser(u);
  await h.bot.cmdUnlink(u, 1);
  g.open(); await sweep;
  await p.onMark(POOLS.ETH!, 1950);
  assert.deepEqual(warns, []);
});

test("F1 Close buttons carry their account: after a relink an old button sends nothing; a fresh one works", async () => {
  const h = makeBot();
  const X = addr(0xa1), Y = addr(0xa2);
  h.state.positions.set(X, [{ base: "ETH", side: "long", size: 1, entry: 100 }]);
  h.state.positions.set(Y, [{ base: "ETH", side: "long", size: 1, entry: 100 }]);
  const closes = fakeClose(h);
  const u = h.addUser(1, X);
  await h.handle(msg(1, "/positions"));
  const old = h.cbData(h.to(1).at(-1)).find((d) => d.startsWith("cl:ETH:100"))!;
  await h.bot.attach(u, 1, Y);
  await h.handle(cb(1, old));
  await h.handle(cb(1, "cl:ETH:100")); // the pre-fix format, not bound to any account
  assert.deepEqual(closes, []);
  assert.match(last(h, 1), /Nothing was sent/);
  await h.handle(msg(1, "/positions"));
  await h.handle(cb(1, h.cbData(h.to(1).at(-1)).find((d) => d.startsWith("cl:ETH:100"))!));
  assert.deepEqual(closes, [`${Y}:ETH`]);
});

test("F1 an auto-close that completes after a relink is logged for the old account and leaves the new one's records alone", async () => {
  const h = makeBot();
  const X = addr(0xa1), Y = addr(0xa2);
  h.state.positions.set(X, [{ base: "ETH", side: "long", size: 1, entry: 100 }]);
  const g = gate();
  fakeClose(h, [], g.p);
  const u = h.addUser(1, X);
  const closing = h.bot.autoClose(u, "ETH", 1, "stop-loss 99.000 reached (mark 98.000)", { kind: "sl", side: "long", owner: X });
  await sleep(10);
  await h.bot.attach(u, 1, Y);
  g.open(); await closing;
  const close = rows().find((r) => r.kind === "close")!;
  assert.equal(close.account.toLowerCase(), X);
  assert.equal(u.lastClosed, undefined, "the new account's card must not show X's trade");
});

// ---------- F2: a card copy never fills further from the mark than the preview promises ----------
test("F2 card copy: the IOC limit stays within 0.5% of the mark (long and short); plain orders keep touch +/- 30 bps", async () => {
  const v: any = new venueMod.Venue();
  const m = { display: "SOL-PERP", symbol: "SOL/USDso:USDso", info: { poolAddress: POOLS.SOL, marginBank: addr(0x99), baseDecimals: 2, tickSize: "1000000000000000", lotSize: "1", minQuantity: "1" } };
  v.markets.set("SOL", m);
  v.mark = async () => 100;
  v.exchange = {
    fetchOrderBook: async () => ({ asks: [[100.49, 5]], bids: [[99.51, 5]] }),
    client: { getMaxPerpOrderSize: async () => ({ priceable: true, placeable: true, maxQuantity: 10n ** 30n }) },
  };
  const prices: number[] = [];
  v.send = async (_tk: unknown, _m: unknown, _s: string, price: bigint) => { prices.push(Number(price) / 1e18); return { hash: HASH, fills: [] }; };
  const tk = { owner: addr(0xb2), operator: addr(0xbb) };
  await v.open(tk, "SOL", "long", 50, { maxTouchPct: LIMITS.cardCopyMaxTouchPct });
  await v.open(tk, "SOL", "short", 50, { maxTouchPct: LIMITS.cardCopyMaxTouchPct });
  await v.open(tk, "SOL", "long", 50);
  assert.ok(prices[0]! <= 100.5, `copy long limit ${prices[0]} must be <= 100.5`);
  assert.ok(prices[1]! >= 99.5, `copy short limit ${prices[1]} must be >= 99.5`);
  assert.equal(prices[2], 100.791, "control: a plain order keeps touch + 30 bps");
});

// ---------- F3: Confirm + SL 3% keeps a tighter stop-loss the user already has ----------
async function soloCard(h: H, lev = 5) {
  const s = h.addUser(7_770_001, addr(0x5a));
  s.lastClosed = { base: "SOL", side: "long", entry: 100, exit: 104, size: 1, pnl: 4, at: Date.now() - 60_000, reason: "take-profit" };
  s.opens.SOL = { margin: 20, leverage: lev, at: 0 };
  await h.handle(msg(7_770_001, "/card"));
  return h.bot.store.cardsBy(7_770_001)[0]!;
}

test("F3 Confirm + SL 3% on a copy that adds to a position keeps a tighter stop-loss, and the preview says so", async () => {
  const h = makeBot();
  const card = await soloCard(h);
  const c = h.addUser(20, addr(0xb2));
  h.state.positions.set(addr(0xb2), [{ base: "SOL", side: "long", size: 1, entry: 100 }]);
  c.rules.SOL = { side: "long", sl: 99.5, setAt: Date.now() };
  await h.handle(cb(20, `cm:${card.id}:10`));
  const pv = h.to(20).at(-1)!;
  assert.match(pv.html, /stop-loss 99\.500/);
  await h.handle(cb(20, h.cbData(pv).find((d) => d.endsWith(":1"))!));
  assert.equal(c.rules.SOL?.sl, 99.5);
  // Control: a looser existing stop is tightened to 3% below the fill.
  const d = h.addUser(21, addr(0xb3));
  h.state.positions.set(addr(0xb3), [{ base: "SOL", side: "long", size: 1, entry: 100 }]);
  d.rules.SOL = { side: "long", sl: 90, setAt: Date.now() };
  await h.handle(cb(21, `cm:${card.id}:10`));
  await h.handle(cb(21, h.cbData(h.to(21).at(-1)).find((x) => x.endsWith(":1"))!));
  assert.equal(d.rules.SOL?.sl, 97);
});

// ---------- F4: watch-only records are keyless, validated first, expire, and get pruned ----------
test("F4 watch-only records have no key and use no key quota; a bad /watch or a stranger's /unwatch makes no record", async () => {
  const h = makeBot();
  await h.handle(msg(1, "/watch garbage"));
  await h.handle(msg(2, `/unwatch ${addr(0xe1)}`));
  await h.handle(msg(4, "/watch 0x0000000000000000000000000000000000000000"));
  assert.equal(h.bot.store.get(1), undefined);
  assert.equal(h.bot.store.get(2), undefined);
  assert.equal(h.bot.store.get(4), undefined);
  await h.handle(msg(3, `/watch ${addr(0xe1)}`));
  await h.handle(cb(5, "wd"));
  for (const id of [3, 5]) {
    const u = h.bot.store.get(id)!;
    assert.ok(u.watches?.length, "watching");
    assert.equal(u.key, undefined);
    assert.equal(u.keyAddress, undefined);
  }
  assert.equal(h.bot.store.keysMadeLastHour(), 0);
  await h.handle(msg(3, "/key"));
  assert.match(last(h, 3), /Send \/start first/);
  await h.handle(msg(3, "/alerts 20"));
  assert.equal(h.bot.store.get(3).liqWarnPct, 20, "/alerts works for watchers");
  await h.handle(msg(3, "/start")); // a watcher who wants to trade gets a key on /start
  const k = h.bot.store.get(3).keyAddress;
  assert.match(k, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(h.to(3).some((s) => s.html.includes(k)));
  assert.equal(h.bot.store.keysMadeLastHour(), 1);
});

test("F4 watches end after 7 days without a message (the watcher is told), the slots free up and the records are pruned", async () => {
  const h = makeBot();
  const t0 = Date.now();
  for (let i = 0; i < 34; i++) for (let j = 0; j < 3; j++) await h.handle(msg(1000 + i, `/watch ${addr(0x100000 + i * 3 + j)}`));
  assert.equal(h.bot.store.watchedAddresses().length, 100);
  h.addUser(5000, addr(0x77));
  await h.handle(msg(5000, `/watch ${addr(0x999999)}`));
  assert.match(last(h, 5000), /Watch mode is full/);
  // One watcher keeps talking to the bot: their watches stay.
  await atTime(t0 + 6 * 86_400_000, () => h.handle(msg(1000, "/watch")));
  await atTime(t0 + 8 * 86_400_000, () => h.bot.housekeeping());
  assert.equal(h.bot.store.get(1000).watches.length, 3, "active watcher kept");
  assert.equal(h.bot.store.get(1001), undefined, "idle watch-only user pruned");
  assert.match(h.to(1001).at(-1)!.html, /stopped watching/i);
  assert.equal(h.bot.store.watchedAddresses().length, 3);
  await h.handle(msg(5000, `/watch ${addr(0x999999)}`));
  assert.match(last(h, 5000), /Watching/);
});

// ---------- F5: one user's previews cannot evict another user's pending Confirm ----------
test("F5 1,000 previews by one user do not evict another user's draft; each user keeps at most 3", async () => {
  const h = makeBot();
  const card = await soloCard(h);
  h.addUser(20, addr(0xb2));
  const a = h.addUser(30, addr(0xb3));
  await h.handle(cb(20, `cm:${card.id}:10`));
  const victim = h.cbData(h.to(20).at(-1)).find((d) => d.endsWith(":0"))!;
  for (let i = 0; i < 1000; i++) await h.bot.copyPreview(a, 30, card.id, 10);
  assert.ok([...h.bot.drafts.values()].filter((d: { uid: number }) => d.uid === 30).length <= 3);
  const before = h.state.opens.length;
  await h.handle(cb(20, victim));
  assert.equal(h.state.opens.length, before + 1);
});

// ---------- F6: shutdown drains in-flight work before releasing the instance lock ----------
test("F6 shutdown: an in-flight order finishes (reply, order row, TP) while the lock is held; a queued trade is refused", async () => {
  const h = makeBot();
  h.addUser(1, addr(0xa1));
  const b = h.bot;
  b.venue.init = async () => {};
  b.tg.getMe = async () => ({ id: 1, username: "SwiftPerpsBot" });
  b.tg.setMyCommands = async () => ({});
  b.tg.setDescription = async () => ({});
  b.protector.start = () => {};
  let served = false;
  b.tg.getUpdates = async () => { if (!served) { served = true; return [msg(1, "/long ETH 20 5x tp 4%"), msg(1, "/long SOL 20 5x")]; } await sleep(20); return []; };
  const lock = `${PATHS.data}/instance.lock`;
  const sending = gate();
  const open = b.venue.open;
  let lockHeld: boolean | undefined;
  b.venue.open = async (...a: any[]) => { if (a[1] === "ETH") { sending.open(); await sleep(300); lockHeld = existsSync(lock); } return open(...a); };
  const before = new Set(process.listeners("SIGTERM"));
  const run = b.start();
  await sending.p;
  const added = process.listeners("SIGTERM").filter((l) => !before.has(l));
  try {
    assert.equal(added.length, 1);
    (added[0] as () => void)();
    await run;
  } finally {
    for (const l of added) process.removeListener("SIGTERM", l);
    for (const l of process.listeners("SIGINT").filter((x) => !before.has(x as never))) process.removeListener("SIGINT", l);
  }
  assert.equal(lockHeld, true, "the lock is still held while the order is in flight");
  assert.ok(rows().some((r) => r.kind === "open" && r.market === "ETH-PERP"), "order row written before exit");
  assert.ok(h.to(1).some((s) => /Filled/.test(s.html)), "the user got the fill reply");
  assert.ok(b.store.get(1).rules.ETH?.tp, "the TP was stored");
  assert.equal(h.state.opens.filter((o) => o.base === "SOL").length, 0, "the queued trade was not sent");
  assert.match(last(h, 1), /restarting/);
  assert.equal(existsSync(lock), false, "released at the end");
});

// ---------- F7: a close with an unknown outcome is not re-sent while its tx may still be pending ----------
async function unknownClose(h: H, state: () => string) {
  const owner = addr(0xa3);
  const u = h.addUser(2, owner);
  let sends = 0;
  h.bot.venue.close = async (_tk: unknown, _b: string, _f: number, _l: unknown, guard?: (a: number, s: string) => void) => {
    guard?.(1.5, "long");
    sends++;
    throw new venueMod.OutcomeUnknown(`The order was sent (tx ${HASH}) but its result is not confirmed yet.`, HASH);
  };
  h.bot.venue.txState = async (op: string, hash?: string) => { assert.equal(hash, HASH); assert.match(op, /^0x/); return state(); };
  await assert.rejects(h.bot.doClose(u, 2, "ETH", 1, "stop-loss", { expectSide: "long", auto: true }), /not confirmed/);
  return { u, sends: () => sends };
}

test("F7 an unknown close is not re-sent 21 s later while its tx is still pending (auto and manual)", async () => {
  const h = makeBot();
  const { u, sends } = await unknownClose(h, () => "pending");
  const later = Date.now() + 21_000;
  await atTime(later, () => assert.rejects(h.bot.doClose(u, 2, "ETH", 1, "stop-loss", { expectSide: "long", auto: true }), /still pending|not confirmed yet/));
  await atTime(later, () => assert.rejects(h.bot.doClose(u, 2, "ETH", 1, "manual close"), /still pending|not confirmed yet/));
  assert.equal(sends(), 1);
});

test("F7 (positive control): once the first tx is mined the next close reads the chain afresh and is sent", async () => {
  const h = makeBot();
  const { u, sends } = await unknownClose(h, () => "mined");
  await atTime(Date.now() + 21_000, () => assert.rejects(h.bot.doClose(u, 2, "ETH", 1, "stop-loss", { expectSide: "long", auto: true }), /not confirmed/));
  assert.equal(sends(), 2);
});

// ---------- F8: the wallet path retries reads, never re-posts, and every post failure carries its hash ----------
const OWNER = "0x00000000000000000000000000000000000000aa";
const MKT = { display: "SOL-PERP", symbol: "SOL/USDso:USDso", info: { poolAddress: "0x1111111111111111111111111111111111111111", baseDecimals: 2, tickSize: "1", minQuantity: "1" } };
async function rpcStub(over: (method: string, n: number) => { status: number } | undefined) {
  const calls: string[] = [];
  const result = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId": return "0xc4cf";
      case "eth_call": return `0x${"0".repeat(63)}1${"0".repeat(64)}`;
      case "eth_getTransactionCount": return "0x0";
      case "eth_blockNumber": return "0x10";
      case "eth_maxPriorityFeePerGas": return "0x1";
      case "eth_gasPrice": return "0x2";
      case "eth_getBlockByNumber": return { number: "0x10", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"22".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] };
      case "eth_sendRawTransaction": return keccak256(params[0]);
      case "eth_getTransactionReceipt": return {
        transactionHash: params[0], transactionIndex: "0x0", blockHash: `0x${"11".repeat(32)}`, blockNumber: "0x10", from: OWNER, to: MKT.info.poolAddress,
        cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
      };
      default: return undefined;
    }
  };
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const j = JSON.parse(body);
      calls.push(j.method);
      const o = over(j.method, calls.filter((m) => m === j.method).length);
      if (o) { res.writeHead(o.status); res.end("busy"); return; }
      const r = result(j.method, j.params ?? []);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(r === undefined ? { jsonrpc: "2.0", id: j.id, error: { code: -32601, message: `the method ${j.method} does not exist/is not available` } } : { jsonrpc: "2.0", id: j.id, result: r }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return { calls, posts: () => calls.filter((m) => m === "eth_sendRawTransaction").length, close: () => srv.close(), key: () => createTradingKey({ owner: OWNER, privateKey: generatePrivateKey(), chain: venueMod.chain, rpcUrl: url }) };
}
const vsend = (tk: unknown) => (new venueMod.Venue() as any).send(tk, MKT, "long", 1n, 1n) as Promise<{ hash: string }>;

test("F8 a transient 503 on the nonce read before signing is retried: the order goes through, posted once", async () => {
  const s = await rpcStub((m, n) => (m === "eth_getTransactionCount" && n === 1 ? { status: 503 } : undefined));
  try {
    const r = await vsend(s.key());
    assert.match(r.hash, /^0x[0-9a-f]{64}$/);
    assert.equal(s.posts(), 1);
  } finally { s.close(); }
});

test("F8 a failure before anything is signed says 'Nothing was sent' (not 'not confirmed'), and nothing is posted", async () => {
  const s = await rpcStub((m) => (m === "eth_getTransactionCount" ? { status: 503 } : undefined));
  try {
    const e = await errOf(vsend(s.key()));
    assert.ok(!(e instanceof venueMod.OutcomeUnknown), e.message);
    assert.match(e.message, /Nothing was sent/);
    assert.equal(s.posts(), 0);
  } finally { s.close(); }
});

test("F8 a failed raw post is never retried and is reported as unknown WITH its tx hash", async () => {
  const s = await rpcStub((m) => (m === "eth_sendRawTransaction" ? { status: 503 } : undefined));
  try {
    const e = await errOf(vsend(s.key()));
    assert.ok(e instanceof venueMod.OutcomeUnknown, e.message);
    assert.match(String(e.hash), /^0x[0-9a-f]{64}$/);
    assert.ok(e.message.includes(String(e.hash)));
    assert.equal(s.posts(), 1);
  } finally { s.close(); }
});

// ---------- F9: the per-key send lock is not held through the receipt wait ----------
test("F9 a second market's order on the same key is posted while the first one waits for its receipt; nonces stay distinct", async () => {
  const op = "0x00000000000000000000000000000000000000c9";
  let node = 0, waits = 0;
  const posts: { at: number; nonce: number }[] = [];
  const t0 = Date.now();
  const tk = {
    owner: OWNER, operator: op, account: { address: op },
    publicClient: {
      simulateContract: async () => ({ request: {} }),
      getTransactionCount: async () => node,
      waitForTransactionReceipt: async () => { if (waits++ === 0) await sleep(500); return { status: "success", logs: [] }; },
    },
    walletClient: {
      chain: venueMod.chain,
      prepareTransactionRequest: async (r: { nonce: number }) => r,
      signTransaction: async (r: { nonce: number }) => `0x${r.nonce.toString(16).padStart(4, "0")}`,
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => { const n = parseInt(serializedTransaction.slice(2), 16); posts.push({ at: Date.now() - t0, nonce: n }); node = Math.max(node, n + 1); return keccak256(serializedTransaction as `0x${string}`); },
      writeContract: async () => { posts.push({ at: Date.now() - t0, nonce: node }); node++; return HASH; }, // the pre-fix path
    },
  };
  const v: any = new venueMod.Venue();
  await Promise.all([v.send(tk, MKT, "long", 1n, 1n), v.send(tk, { ...MKT, info: { ...MKT.info, poolAddress: "0x2222222222222222222222222222222222222222" } }, "long", 1n, 1n)]);
  assert.equal(posts.length, 2);
  assert.ok(posts[1]!.at < 300, `second post at ${posts[1]!.at} ms waited for the first receipt`);
  assert.deepEqual(posts.map((p) => p.nonce).sort(), [0, 1]);
});

// ---------- F10: card leverage and closed state ----------
test("F10 a full close clears the open record (no stale leverage on a later card); a partial close does not mark the card closed", async () => {
  const h = makeBot();
  fakeClose(h);
  h.addUser(1, addr(0xa1));
  await h.handle(msg(1, "/long ETH 20 5x"));
  await h.handle(msg(1, "/close ETH"));
  h.state.positions.set(addr(0xa1), [{ base: "ETH", side: "long", size: 1, entry: 100 }]); // opened later in the app
  await h.handle(msg(1, "/card ETH"));
  assert.equal(h.bot.store.cardsBy(1)[0]!.lev, undefined, "no leverage from the earlier bot trade");
  // The closed trade's card still shows its leverage.
  h.state.positions.set(addr(0xa1), []);
  await atTime(Date.now() + 61_000, () => h.handle(msg(1, "/card ETH")));
  assert.equal(h.bot.store.cardsBy(1)[0]!.lev, 5);
  // Partial close after an open card: the landing must not say it was closed.
  const s = h.addUser(2, addr(0xa2));
  await h.handle(msg(2, "/long SOL 20 5x"));
  await h.handle(msg(2, "/card SOL"));
  const card = h.bot.store.cardsBy(2)[0]!;
  await atTime(Date.now() + 1_000, () => h.handle(msg(2, "/close SOL 50%")));
  assert.ok(s.lastClosed);
  h.addUser(3, addr(0xa3));
  await atTime(Date.now() + 2_000, () => h.handle(msg(3, `/start c_${card.id}`)));
  assert.doesNotMatch(last(h, 3), /has closed it/);
});

// ---------- F11: forwarded card links keep working ----------
test("F11 /card for the same trade reuses its card, so a forwarded link survives 20 more /card presses", async () => {
  const h = makeBot();
  const S = 7_770_001;
  const s = h.addUser(S, addr(0x5a));
  s.lastClosed = { base: "SOL", side: "long", entry: 100, exit: 104, size: 1, pnl: 4, at: Date.now(), reason: "manual close" };
  await h.handle(msg(S, "/card"));
  const first = h.bot.store.cardsBy(S)[0]!.id;
  for (let i = 1; i <= LIMITS.cardsPerUser; i++) await atTime(Date.now() + i * 61_000, () => h.handle(msg(S, "/card")));
  assert.ok(h.bot.store.card(first));
  await h.handle(msg(500, `/start c_${first}`));
  assert.equal(h.bot.store.get(500).refBy, s.ref);
  assert.ok(h.to(500).some((x) => /Shared trade/.test(x.html)));
});

test("F11 tapped cards survive the per-user cap; an expired link says so and still credits the sharer", async () => {
  const h = makeBot();
  const S = 7_770_001;
  const s = h.addUser(S, addr(0x5a));
  const t0 = Date.now();
  const trade = (i: number) => { s.lastClosed = { base: "SOL", side: "long", entry: 100 + i, exit: 104, size: 1, pnl: 4, at: t0 + i, reason: "manual close" }; };
  trade(0);
  await h.handle(msg(S, "/card"));
  const tapped = h.bot.store.cardsBy(S)[0]!.id;
  await h.handle(msg(400, `/start c_${tapped}`)); // one tap
  trade(1);
  await atTime(t0 + 61_000, () => h.handle(msg(S, "/card")));
  const plain = h.bot.store.cardsBy(S)[0]!.id;
  for (let i = 2; i <= LIMITS.cardsPerUser + 2; i++) { trade(i); await atTime(t0 + i * 61_000, () => h.handle(msg(S, "/card"))); }
  assert.ok(h.bot.store.card(tapped), "the tapped card is kept");
  assert.equal(h.bot.store.card(plain), undefined, "an untapped old card is pruned");
  await h.handle(msg(600, `/start c_${plain}`));
  assert.match(h.to(600)[0]!.html, /expired/);
  assert.equal(h.bot.store.get(600).refBy, s.ref, "attribution survives the prune");
});

// ---------- F12: a watched position is announced once, again only when the distance halves ----------
test("F12 a watched position sitting at 7.5% alerts once in 70 minutes; again when the distance halves, or after it recovers", async () => {
  const POOL = POOLS.ETH!;
  const W = "0x000000000000000000000000000000000000beef";
  const store = new Store(mkdtempSync(`${tmpdir()}/ddmvp-f12-`));
  const u = store.add({ id: 10, created: 0 });
  u.watches = [{ addr: W as `0x${string}`, at: 0 }];
  const venue = {
    account: async () => ({ equity: 100, positions: [{ base: "ETH", pool: POOL, side: "long", size: 2, entry: 2000, mark: 2000, upnl: 0, notional: 4000, liq: 1850 }] }),
    marketByPool: () => ({ display: "ETH-PERP", info: { poolAddress: POOL } }),
    baseOf: () => "ETH", mark: async () => 2000,
  };
  const warns: string[] = [];
  const p = new Protector(venue as never, store, async () => {}, async () => {}, () => {});
  (p as any).subscribe = async () => {};
  p.onWatch(async (_u, _a, _b, t) => { warns.push(t); }, async () => {});
  await p.refreshWatched();
  const t0 = Date.now();
  for (let i = 0; i <= 6; i++) await atTime(t0 + i * (LIMITS.liqWarnCooldownMs + 1_000), () => p.onMark(POOL, 2000)); // 7.5%
  assert.equal(warns.length, 1);
  await atTime(t0 + 80 * 60_000, () => p.onMark(POOL, 1920)); // 3.6%: less than half of 7.5%
  assert.equal(warns.length, 2);
  await atTime(t0 + 100 * 60_000, () => p.onMark(POOL, 2400)); // 23%: well out of the zone, re-armed
  await atTime(t0 + 120 * 60_000, () => p.onMark(POOL, 2000));
  assert.equal(warns.length, 3);
});

// ---------- F13-F16: wording ----------
test("F13 the copy preview says it is a one-time order that does not follow the sharer's exits", async () => {
  const h = makeBot();
  const card = await soloCard(h);
  h.addUser(200, addr(0xb2));
  await h.handle(cb(200, `cm:${card.id}:25`));
  assert.match(last(h, 200), /One-time order/);
  assert.match(last(h, 200), /don't follow the sharer's exits/);
});

test("F14 a close retried right after an unknown outcome says it MAY have gone through, not that it did", async () => {
  const h = makeBot();
  const u = h.addUser(2, addr(0xa3));
  h.bot.venue.close = async (_tk: unknown, _b: string, _f: number, _l: unknown, guard?: (a: number, s: string) => void) => {
    guard?.(1.5, "long");
    throw new venueMod.OutcomeUnknown("I could not confirm that the order reached the chain. Check /positions before you try again; I will not resend it.");
  };
  await assert.rejects(h.bot.doClose(u, 2, "ETH", 1, "manual close"), /could not confirm/);
  const e = await errOf(h.bot.doClose(u, 2, "ETH", 1, "manual close"));
  assert.match(e.message, /may have gone through/);
  assert.doesNotMatch(e.message, /just went through/);
});

test("F15 a tap by someone who never trades is counted as a new user, not a new trader", async () => {
  const h = makeBot();
  const card = await soloCard(h);
  await h.handle(msg(300, `/start c_${card.id}`));
  const ping = h.to(7_770_001).find((s) => /card brought/.test(s.html))!;
  assert.match(ping.html, /brought a new user/);
  await h.handle(msg(7_770_001, "/invite"));
  assert.match(last(h, 7_770_001), /new users: 1/);
  assert.doesNotMatch(last(h, 7_770_001), /trader/i);
});

test("F16 the landing does not offer a plain /long or /short as 'Other size' (it would skip the copy limits and counts)", async () => {
  const h = makeBot();
  const card = await soloCard(h);
  h.addUser(200, addr(0xb2));
  await h.handle(msg(200, `/start c_${card.id}`));
  assert.doesNotMatch(last(h, 200), /\/(long|short) SOL/);
  assert.equal(h.cbData(h.to(200).at(-1)).filter((d) => d.startsWith("cm:")).length, 3);
});
