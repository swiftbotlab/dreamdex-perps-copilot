// Chain access: one read-only markets client for everyone, one trading key per user for writes.
// Every write is `placeOrderFor(owner, ...)` from the user's linked key: the order, margin and fills
// belong to the user's dreamDEX account; the key only pays gas and cannot move funds.
import { ORDER_TYPE, SOMNIA_TESTNET_ADDRESSES, SomniaMarkets } from "@somnia-chain/markets-sdk";
import { createPublicClient, defineChain, formatUnits, http, parseAbi, type PublicClient } from "viem";
import { CHAIN_ID, INDEXER_URL, LIMITS, RPC_URL, WS_URL } from "./config.ts";
import { alignPrice, alignQuantity, perpMarkets, toRaw, type PerpMarket } from "./vendor/perp-core/markets.ts";
import { createTradingKey, linkStatus, placeFor, SendError, type TradingKey } from "./vendor/perp-core/operator.ts";
import { KeyedLock } from "./locks.ts";
import { sizeOrder } from "./vendor/perp-core/orders.ts";
import type { Side } from "./parse.ts";

export const chain = defineChain({
  id: CHAIN_ID,
  name: "Somnia Tokyo testnet (Hideki)",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL], webSocket: [WS_URL] } },
});

const POOL_ABI = parseAbi(["function tryGetMarkPrice() view returns (bool ok, uint256 price)"]);

export interface Position {
  base: string; pool: `0x${string}`; side: Side; size: number; entry: number; mark: number;
  upnl: number; notional: number; liq?: number;
}
export interface AccountView {
  equity: number; unlocked: number; locked: number; mmReq: number; imReq: number; status: string; positions: Position[];
}
export interface TradeResult {
  hash: `0x${string}`; filledBase: number; avgPrice?: number; requestedBase: number; base: string; side: Side;
  realizedPnl?: number; entry?: number; prevSize?: number;
}

export class UserError extends Error {}

/** The order may have reached the chain: never report it as "nothing was sent", never resend it automatically. */
export class OutcomeUnknown extends UserError {
  constructor(message: string, readonly hash?: `0x${string}`) { super(message); this.name = "OutcomeUnknown"; }
}

/** The lock interface `sendLock` needs (tests swap in a pass-through as the positive control). */
export interface RunLock { run<T>(key: string, f: () => Promise<T>): Promise<T> }

export class Venue {
  readonly pub: PublicClient;
  exchange!: SomniaMarkets;
  private markets = new Map<string, PerpMarket>();
  private byPool = new Map<string, PerpMarket>();
  private loadedAt = 0;
  private keys = new Map<number, TradingKey>();
  /** One send at a time per trading key (innermost lock), so two orders never pick the same nonce. */
  sendLock: RunLock = new KeyedLock();

  constructor() {
    this.pub = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 30_000, retryCount: 2 }) }) as PublicClient;
  }

  async init(): Promise<void> {
    const id = await this.pub.getChainId();
    if (id !== CHAIN_ID) throw new Error(`refusing to start: RPC chain id ${id}, expected ${CHAIN_ID} (testnet only)`);
    this.exchange = new SomniaMarkets({ indexerUrl: INDEXER_URL, chain, wsRpcUrl: WS_URL, addresses: SOMNIA_TESTNET_ADDRESSES });
    await this.reloadMarkets(true);
  }

  async reloadMarkets(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < 10 * 60_000) return;
    const list = await perpMarkets(this.exchange, true);
    if (!list.length) throw new Error("no perp markets found");
    const m = new Map<string, PerpMarket>(), p = new Map<string, PerpMarket>();
    const hex40 = /^0x[0-9a-fA-F]{40}$/;
    for (const x of list) {
      // Indexer data is untrusted too: only well-formed symbols and addresses become markets.
      if (!/^[A-Z0-9]{1,12}-PERP$/.test(x.display) || !hex40.test(x.info.poolAddress) || !hex40.test(x.info.marginBank)) continue;
      if (BigInt(x.info.marginBank) === 0n) continue;
      m.set(x.display.replace(/-PERP$/, ""), x);
      p.set(x.info.poolAddress.toLowerCase(), x);
    }
    this.markets = m; this.byPool = p; this.loadedAt = Date.now();
  }

  list(): PerpMarket[] { return [...this.markets.values()]; }
  market(base: string): PerpMarket | undefined { return this.markets.get(base); }
  marketByPool(pool: string): PerpMarket | undefined { return this.byPool.get(pool.toLowerCase()); }
  baseOf(m: PerpMarket): string { return m.display.replace(/-PERP$/, ""); }
  maxLeverage(base: string): number | undefined {
    const m = this.markets.get(base);
    return m ? Math.floor(10_000 / Math.max(1, Number(m.info.initialMarginBps))) : undefined;
  }
  marginBank(): `0x${string}` { return this.list()[0]!.info.marginBank; }
  /** Approximate smallest order notional from the cached mark (pre-check before anything is sent). */
  minNotional(base: string): number | undefined {
    const m = this.markets.get(base);
    if (!m) return undefined;
    const min = Number(formatUnits(BigInt(m.info.minQuantity), m.info.baseDecimals));
    return min * Number(formatUnits(BigInt(m.info.markPrice ?? "0"), 18));
  }

  async mark(m: PerpMarket): Promise<number | undefined> {
    const [ok, px] = await this.pub.readContract({ address: m.info.poolAddress, abi: POOL_ABI, functionName: "tryGetMarkPrice" });
    return ok && px > 0n ? Number(formatUnits(px, 18)) : undefined;
  }

  async gasBalance(addr: `0x${string}`): Promise<number> {
    return Number(formatUnits(await this.pub.getBalance({ address: addr }), 18));
  }

  async account(owner: `0x${string}`): Promise<AccountView> {
    const c = this.exchange.client;
    const a = await c.getMarginAccount(this.marginBank(), owner);
    const q = (v: bigint) => Number(formatUnits(v, 18));
    const positions: Position[] = [];
    for (const pool of a.activePerpPools as readonly `0x${string}`[]) {
      const m = this.marketByPool(pool);
      if (!m) continue;
      const ref = { marginBank: m.info.marginBank, account: owner, pool: m.info.poolAddress };
      const [pos, mark, liqRaw] = await Promise.all([
        c.getPerpPosition(ref),
        this.mark(m),
        c.getLiquidationPrice(ref).catch(() => null),
      ]);
      if (pos.size === 0n) continue;
      const long = pos.size > 0n;
      const size = Number(formatUnits(long ? pos.size : -pos.size, m.info.baseDecimals));
      const entry = Number(formatUnits(pos.avgEntryPrice, 18));
      const mk = mark ?? entry;
      positions.push({
        base: this.baseOf(m), pool: m.info.poolAddress, side: long ? "long" : "short", size, entry, mark: mk,
        upnl: (mk - entry) * (long ? size : -size), notional: size * mk,
        liq: liqRaw != null && liqRaw > 0n ? Number(formatUnits(liqRaw, 18)) : undefined,
      });
    }
    return { equity: q(a.equity), unlocked: q(a.unlockedCollateralBalance), locked: q(a.lockedCollateral), mmReq: q(a.mmReq), imReq: q(a.imReq), status: String(a.marginStatus), positions };
  }

  async accountCap(owner: `0x${string}`, m: PerpMarket): Promise<number> {
    return this.exchange.client.getPerpMaxLeverage({ marginBank: m.info.marginBank, account: owner, pool: m.info.poolAddress });
  }

  tradingKey(userId: number, owner: `0x${string}`, pk: () => `0x${string}`): TradingKey {
    const k = this.keys.get(userId);
    if (k && k.owner.toLowerCase() === owner.toLowerCase()) return k;
    const fresh = createTradingKey({ owner, privateKey: pk(), chain, rpcUrl: RPC_URL });
    this.keys.set(userId, fresh);
    return fresh;
  }
  forgetKey(userId: number): void { this.keys.delete(userId); }

  /** Which markets the key may place+cancel on for `owner` (asks each pool, the check the pool enforces). */
  private covCache = new Map<string, { at: number; v: { linked: string[]; missing: string[] } }>();
  async coverage(owner: `0x${string}`, operator: `0x${string}`): Promise<{ linked: string[]; missing: string[] }> {
    const ck = `${owner.toLowerCase()}:${operator.toLowerCase()}`;
    const hit = this.covCache.get(ck);
    if (hit && Date.now() - hit.at < 60_000) return hit.v;
    const v = await this.coverageUncached(owner, operator);
    this.covCache.set(ck, { at: Date.now(), v });
    if (this.covCache.size > 1_000) this.covCache.clear();
    return v;
  }

  private async coverageUncached(owner: `0x${string}`, operator: `0x${string}`): Promise<{ linked: string[]; missing: string[] }> {
    const linked: string[] = [], missing: string[] = [];
    const probe = { owner, operator } as TradingKey;
    await Promise.all(this.list().map(async (m) => {
      const s = await linkStatus({ ...probe, publicClient: this.pub } as TradingKey, m.info.poolAddress);
      (s.place && s.cancel ? linked : missing).push(this.baseOf(m));
    }));
    return { linked: linked.sort(), missing: missing.sort() };
  }

  private async touch(m: PerpMarket, side: Side, mark: number, maxPct: number = LIMITS.maxTouchVsMarkPct): Promise<number> {
    const book = await this.exchange.fetchOrderBook(m.symbol, 1);
    const t = side === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
    if (t === undefined) throw new UserError(`No ${side === "long" ? "sellers" : "buyers"} on the ${m.display} book right now. Nothing was sent.`);
    if (Math.abs(t - mark) / mark * 100 > maxPct) {
      throw new UserError(`The ${m.display} book is thin: best ${side === "long" ? "ask" : "bid"} ${t} is more than ${maxPct}% from the mark ${mark.toFixed(4)}. Nothing was sent.`);
    }
    return t;
  }

  private slipPrice(m: PerpMarket, side: Side, touch: number): bigint {
    const raw = toRaw(touch, 18);
    const bps = BigInt(LIMITS.slippageBps);
    return alignPrice(side === "long" ? (raw * (10_000n + bps)) / 10_000n : (raw * (10_000n - bps)) / 10_000n, m.info);
  }

  /** The IOC limit: touch +/- slippage, and with `capPct` never further than that from the mark (card copies). */
  private limitPrice(m: PerpMarket, side: Side, touch: number, mark: number, capPct?: number): bigint {
    const p = this.slipPrice(m, side, touch);
    if (capPct === undefined) return p;
    const raw = toRaw(mark * (1 + (side === "long" ? capPct : -capPct) / 100), 18);
    const tick = BigInt(m.info.tickSize);
    // A buy may pay at most the cap (round down to the tick), a sell accepts at least it (round up).
    const cap = side === "long" ? alignPrice(raw, m.info) : tick > 0n ? ((raw + tick - 1n) / tick) * tick : raw;
    return side === "long" ? (p < cap ? p : cap) : (p > cap ? p : cap);
  }

  /** What became of a transaction this key may have posted: mined, still pending, or neither (dropped / never posted). */
  async txState(operator: `0x${string}`, hash?: `0x${string}`): Promise<"mined" | "pending" | "none"> {
    if (hash) {
      const rc = await this.pub.getTransactionReceipt({ hash }).catch(() => undefined);
      if (rc) return "mined";
    }
    const [pending, latest] = await Promise.all([
      this.pub.getTransactionCount({ address: operator, blockTag: "pending" }),
      this.pub.getTransactionCount({ address: operator, blockTag: "latest" }),
    ]);
    return pending > latest ? "pending" : "none";
  }

  private async send(tk: TradingKey, m: PerpMarket, side: Side, price: bigint, quantity: bigint) {
    const op = tk.operator.toLowerCase();
    try {
      // One send at a time per trading key from the nonce read to the post; the receipt wait runs outside the lock.
      return await placeFor(tk, { pool: m.info.poolAddress, isBid: side === "long", price, quantity, orderType: ORDER_TYPE.MARKET },
        (f) => this.sendLock.run(op, f));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const ts = new Date().toISOString();
      const phase = e instanceof SendError ? e.phase : "after-receipt";
      const hash = e instanceof SendError ? e.hash : undefined;
      if (phase === "reverted") throw new UserError(`The order reverted on chain: tx ${hash}`);
      if (phase === "prepare") {
        // The nonce/fee reads or the signing failed: nothing was signed and posted.
        if (/insufficient funds|exceeds the balance/i.test(msg)) throw new UserError("Your bot key has no STT for gas. Send it some STT (see /key). Nothing was sent.");
        console.log(ts, "order not sent (prepare):", msg.split("\n")[0]!.slice(0, 200));
        throw new UserError("I could not reach the chain to prepare the order. Nothing was sent; try again in a moment.");
      }
      if (phase === "send") {
        // The node refused the raw transaction for gas money: it never entered the chain.
        if (/insufficient funds|exceeds the balance/i.test(msg)) throw new UserError("Your bot key has no STT for gas. Send it some STT (see /key). Nothing was sent.");
        console.log(ts, "order outcome unknown (send):", msg.split("\n")[0]!.slice(0, 200));
        throw new OutcomeUnknown(`I could not confirm that the order reached the chain${hash ? ` (tx ${hash})` : ""}. Check /positions before you try again; I will not resend it.`, hash);
      }
      if (phase === "wait" || phase === "decode" || phase === "after-receipt") {
        // Posted (wait) or even mined (decode): the order may have filled.
        console.log(ts, `order outcome unknown (${phase}):`, msg.split("\n")[0]!.slice(0, 200));
        throw new OutcomeUnknown(`The order was sent${hash ? ` (tx ${hash})` : ""} but its result is not confirmed yet. Check /positions; I will not resend it.`, hash);
      }
      // phase === "simulate": the eth_call refused it, nothing reached the chain.
      if (msg.includes("ImmediateOrCancelNoFill")) throw new UserError("The book moved and nothing would fill. Nothing was sent; try again.");
      if (msg.includes("OnlyApprovedContracts") || msg.includes("NotAuthorized") || msg.includes("Unauthorized")) throw new UserError(`Your bot key is not linked for ${m.display}. Open the app, Link a bot, paste your bot address again.`);
      if (/insufficient funds|exceeds the balance/i.test(msg)) throw new UserError("Your bot key has no STT for gas. Send it some STT (see /key).");
      const revHash = /tx (0x[0-9a-fA-F]{64})/.exec(msg)?.[1];
      if (revHash) throw new UserError(`The order reverted on chain: tx ${revHash}`);
      console.log(ts, "order rejected:", msg.split("\n").filter((l) => /Error|reason|revert/i.test(l)).join(" | ").slice(0, 300));
      const named = /reverted with the following reason:\s*([^\n]{1,120})|Error: ([A-Za-z0-9_]+)\(/.exec(msg);
      throw new UserError(`The venue rejected the order${named ? `: ${(named[1] ?? named[2])!.trim()}` : ""}. Nothing was sent.`);
    }
  }

  private summarize(m: PerpMarket, fills: { quantityFilled: bigint; fillPrice?: bigint }[]) {
    let q = 0n, notional = 0n;
    for (const f of fills) { q += f.quantityFilled; notional += f.quantityFilled * (f.fillPrice ?? 0n); }
    const filledBase = Number(formatUnits(q, m.info.baseDecimals));
    const avgPrice = q > 0n ? Number(formatUnits(notional / q, 18)) : undefined;
    return { filledBase, avgPrice };
  }

  /** Market (IOC) order for `notional` USDso. */
  /** `opts.maxTouchPct`: refuse when the best price is further than this from the mark, and never fill further (card copies use 0.5 %). */
  async open(tk: TradingKey, base: string, side: Side, notional: number, opts: { maxTouchPct?: number } = {}): Promise<TradeResult> {
    const m = this.market(base);
    if (!m) throw new UserError(`Unknown market ${base}.`);
    const mark = await this.mark(m);
    if (!mark) throw new UserError(`${m.display} has no fresh mark price right now (oracle stale). Nothing was sent.`);
    const touch = await this.touch(m, side, mark, opts.maxTouchPct);
    const wanted = alignQuantity(toRaw(notional / mark, m.info.baseDecimals), m.info);
    if (wanted === 0n) {
      const min = Number(formatUnits(BigInt(m.info.minQuantity), m.info.baseDecimals));
      throw new UserError(`Too small: the minimum on ${m.display} is ${min} ${base} (about ${(min * mark).toFixed(2)} USDso notional).`);
    }
    const price = this.limitPrice(m, side, touch, mark, opts.maxTouchPct);
    const sized = await sizeOrder(this.exchange, { market: m, account: tk.owner, side, price, wanted, tradingKey: tk });
    if (!sized.ok) throw new UserError(`Cannot open: ${sized.reason ?? "the venue refused the size"}. If your Perps balance is empty, move USDso Spot -> Perps in the app.`);
    if (sized.quantity * 10n < wanted * 9n) {
      const can = Number(formatUnits(sized.quantity, m.info.baseDecimals)) * mark;
      throw new UserError(`Your account can only take about ${can.toFixed(2)} USDso of ${m.display} right now (limited by ${sized.limitedBy ?? "margin"}). Nothing was sent.`);
    }
    const res = await this.send(tk, m, side, price, sized.quantity);
    const { filledBase, avgPrice } = this.summarize(m, res.fills as never);
    return { hash: res.hash, filledBase, avgPrice, requestedBase: Number(formatUnits(sized.quantity, m.info.baseDecimals)), base, side };
  }

  /** Close `fraction` (0-1] of the position in `base` with an opposite IOC sized from the venue's close preview. */
  /** `limit` (optional): never fill worse than this price (take-profit exits); otherwise touch +/- slippage. */
  async close(tk: TradingKey, base: string, fraction = 1, limit?: number, guard?: (absSize: number, side: Side) => void): Promise<TradeResult> {
    const m = this.market(base);
    if (!m) throw new UserError(`Unknown market ${base}.`);
    const c = this.exchange.client;
    const ref = { marginBank: m.info.marginBank, account: tk.owner, pool: m.info.poolAddress };
    const pos = await c.getPerpPosition(ref);
    if (pos.size === 0n) throw new UserError(`No open ${m.display} position.`);
    const posSide: Side = pos.size > 0n ? "long" : "short";
    const side: Side = posSide === "long" ? "short" : "long";
    const abs = pos.size > 0n ? pos.size : -pos.size;
    guard?.(Number(formatUnits(abs, m.info.baseDecimals)), posSide); // caller's last check on the FRESH position, before anything is sent
    const preview = await c.previewPerpClosePnl({ pool: m.info.poolAddress, marginBank: m.info.marginBank, account: tk.owner }).catch(() => undefined);
    const whole = preview && preview.priceable && preview.closedQuantity > 0n ? preview.closedQuantity : abs;
    let qty = fraction >= 1 ? whole : alignQuantity((whole * BigInt(Math.round(fraction * 1000))) / 1000n, m.info);
    if (qty > abs) qty = abs;
    if (qty <= 0n) throw new UserError(`That part of the position is below the ${m.display} minimum order size; close all instead.`);
    const mark = (await this.mark(m)) ?? Number(formatUnits(pos.avgEntryPrice, 18));
    let price: bigint;
    if (limit !== undefined) {
      // Buy-to-close may pay at most the limit, sell-to-close accepts at least it: round toward the safe side of the tick.
      const raw = toRaw(limit, 18), tick = BigInt(m.info.tickSize);
      price = side === "long" ? alignPrice(raw, m.info) : tick > 0n ? ((raw + tick - 1n) / tick) * tick : raw;
    } else {
      price = this.slipPrice(m, side, await this.touch(m, side, mark));
    }
    const res = await this.send(tk, m, side, price, qty);
    const { filledBase, avgPrice } = this.summarize(m, res.fills as never);
    const entry = Number(formatUnits(pos.avgEntryPrice, 18));
    const realizedPnl = avgPrice !== undefined ? (avgPrice - entry) * filledBase * (posSide === "long" ? 1 : -1) : undefined;
    return { hash: res.hash, filledBase, avgPrice, requestedBase: Number(formatUnits(qty, m.info.baseDecimals)), base, side, realizedPnl, entry, prevSize: Number(formatUnits(abs, m.info.baseDecimals)) };
  }
}

const REGISTRY = "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a" as const; // OperatorPermissionsRegistry on Hideki
const GRANT_TOPIC = "0x10f879368ceb20c35c69315bc27ed8488f731570cf213d3e1bc2ad9b7749de28" as const; // (pool, owner, operator) + (selector, approved)

/**
 * Accounts that recently linked `operator` with the app's "Link a bot", by scanning the registry's
 * grant events for the last `minutes` (the public RPC serves at most ~1,000 blocks per getLogs; ~10 blocks/s).
 */
export async function findLinkedOwners(pub: PublicClient, operator: `0x${string}`, minutes = 15): Promise<`0x${string}`[]> {
  const head = await pub.getBlockNumber();
  const opTopic = `0x${operator.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
  const chunks = Math.min(20, Math.ceil((minutes * 600) / 1000));
  const owners: `0x${string}`[] = [];
  for (let i = 0; i < chunks; i++) {
    const to = head - BigInt(i * 1000);
    const from = to - 999n;
    const logs = (await pub.request({
      method: "eth_getLogs",
      params: [{ address: REGISTRY, topics: [GRANT_TOPIC, null, null, opTopic], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    } as never)) as { topics: `0x${string}`[]; data: `0x${string}` }[];
    for (let j = logs.length - 1; j >= 0; j--) {
      const l = logs[j]!;
      const approved = BigInt(`0x${l.data.slice(66, 130) || "0"}`) === 1n;
      const owner = l.topics[2] ? (`0x${l.topics[2].slice(26)}` as `0x${string}`) : undefined;
      if (approved && owner && /^0x[0-9a-f]{40}$/.test(owner) && !owners.includes(owner)) owners.push(owner);
    }
  }
  return owners; // newest first; more than one = ambiguous, the caller must ask
}
