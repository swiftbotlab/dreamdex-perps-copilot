// Small JSON store (one file, atomic rename, mode 0600) plus an append-only order log.
import { appendFileSync, closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LIMITS } from "./config.ts";
import type { SealedKey } from "./keys.ts";
import type { Side } from "./parse.ts";

export interface Rule { tp?: number; sl?: number; side: Side; setAt: number }
export interface OpenInfo { margin: number; leverage: number; at: number }
/** `lev`: leverage of the bot order that opened it, if any; `full`: the close left no position (undefined in old records = full). */
export interface ClosedTrade { base: string; side: Side; entry: number; exit: number; size: number; pnl: number; roePct?: number; at: number; reason: string; lev?: number; full?: boolean }

export interface User {
  id: number;
  created: number;
  keyAddress?: `0x${string}`;  // absent for watch-only records: a key is made on /start
  key?: SealedKey;
  owner?: `0x${string}`;
  ref: string;               // this user's share code (deep link payload)
  refBy?: string;            // the code that brought them in, if any
  liqWarnPct: number;        // warn when mark is within this % of the liquidation price
  guardPct?: number;         // auto-close when within this % (off when undefined)
  rules: Record<string, Rule>;    // per market base: bot-watched TP / SL
  opens: Record<string, OpenInfo>; // margin/leverage the user asked for, for ROE on cards
  lastClosed?: ClosedTrade;
  stats: { orders: number; cards: number };
  pendingCopy?: { card: string; at: number };            // a card tapped before linking: shown again after /link
  watches?: { addr: `0x${string}`; at: number }[];       // read-only liquidation watches (/watch)
  blockedAt?: number;                                     // Telegram said the user blocked the bot
  lastSeen?: number;                                      // last message or button press (watches expire without one)
}

/** A shared PnL card. `by` (the sharer's Telegram id) never leaves the bot; landings show only the trade. */
export interface CardRec {
  id: string; by: number; base: string; side: Side; lev?: number; entry: number; price: number;
  pnl: number; open: boolean; at: number; tradeAt?: number; taps: number; newUsers: number; copies: number;
}

/** One validated row of the order log (public on-chain facts only). */
export interface OrderRow {
  t: string; kind: "open" | "close" | "unknown"; reason?: string; market: string; side: Side;
  hash: `0x${string}`; filled?: number; avgPrice?: number; via?: string;
}

interface Db { users: Record<string, User>; keysMadeAt: number[]; cards: Record<string, CardRec>; cardRefs: Record<string, { ref: string; at: number }> }

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const MARKET_RE = /^[A-Z0-9]{1,12}-PERP$/;
const finiteOrAbsent = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));

/** Parse one order-log line; undefined unless every field is well formed and the account matches. */
export function parseOrderLine(line: string, accountLower: string): OrderRow | undefined {
  let r: Record<string, unknown>;
  try { r = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  if (!r || typeof r !== "object") return undefined;
  if (typeof r.account !== "string" || r.account.toLowerCase() !== accountLower) return undefined;
  if (typeof r.hash !== "string" || !HASH_RE.test(r.hash)) return undefined;
  if (typeof r.market !== "string" || !MARKET_RE.test(r.market)) return undefined;
  if (r.kind !== "open" && r.kind !== "close" && r.kind !== "unknown") return undefined;
  if (r.side !== "long" && r.side !== "short") return undefined;
  if (typeof r.t !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(r.t)) return undefined;
  if (!finiteOrAbsent(r.filled) || !finiteOrAbsent(r.avgPrice) || !finiteOrAbsent(r.requested)) return undefined;
  if (r.kind !== "unknown" && typeof r.filled !== "number") return undefined;
  return {
    t: r.t, kind: r.kind, side: r.side, market: r.market, hash: r.hash as `0x${string}`,
    reason: typeof r.reason === "string" ? r.reason.slice(0, 120) : undefined,
    filled: typeof r.filled === "number" ? r.filled : undefined,
    avgPrice: typeof r.avgPrice === "number" ? r.avgPrice : undefined,
    via: typeof r.via === "string" ? r.via.slice(0, 12) : undefined,
  };
}

/** An exit the bot fired by itself, from the order's reason text. */
export function autoKind(reason: string | undefined): "take-profit" | "stop-loss" | "guard" | undefined {
  if (!reason) return undefined;
  if (reason.startsWith("take-profit")) return "take-profit";
  if (reason.startsWith("stop-loss")) return "stop-loss";
  if (reason.startsWith("liquidation guard")) return "guard";
  return undefined;
}

export class Store {
  private db: Db = { users: {}, keysMadeAt: [], cards: {}, cardRefs: {} };
  private readonly file: string;
  private readonly orderLog: string;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = `${dir}/users.json`;
    this.orderLog = `${dir}/orders.jsonl`;
    if (existsSync(this.file)) {
      try {
        this.db = JSON.parse(readFileSync(this.file, "utf8")) as Db;
      } catch {
        // A torn write must never cost users their keys: fall back to the last good copy, or refuse to start.
        this.db = JSON.parse(readFileSync(`${this.file}.bak`, "utf8")) as Db;
        console.log(new Date().toISOString(), "users.json unreadable, loaded users.json.bak");
      }
    }
    this.db.cards ??= {};
    this.db.cardRefs ??= {};
  }

  get(id: number): User | undefined { return this.db.users[String(id)]; }
  all(): User[] { return Object.values(this.db.users); }
  count(): number { return Object.keys(this.db.users).length; }
  /** Users with a bot key (the ones `maxUsers` caps). */
  countKeyed(): number { return this.all().filter((u) => u.key).length; }
  byRef(code: string): User | undefined { return this.all().find((u) => u.ref === code); }

  keysMadeLastHour(now = Date.now()): number {
    this.db.keysMadeAt = this.db.keysMadeAt.filter((t) => now - t < 3_600_000);
    return this.db.keysMadeAt.length;
  }

  add(u: Omit<User, "ref" | "rules" | "opens" | "stats" | "liqWarnPct">): User {
    let ref = randomBytes(5).toString("hex");
    while (this.byRef(ref)) ref = randomBytes(5).toString("hex");
    const user: User = { ...u, ref, rules: {}, opens: {}, stats: { orders: 0, cards: 0 }, liqWarnPct: 10 };
    this.db.users[String(u.id)] = user;
    if (u.key) this.db.keysMadeAt.push(Date.now());
    this.save();
    return user;
  }

  /** Give an existing (watch-only) record its bot key. */
  setKey(u: User, keyAddress: `0x${string}`, key: SealedKey): void {
    u.keyAddress = keyAddress; u.key = key;
    this.db.keysMadeAt.push(Date.now());
    this.save();
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(this.db)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);              // atomic: users.json is always a complete version
    copyFileSync(this.file, `${this.file}.bak`); // second copy of the latest good state
  }

  /**
   * End the watches of users who sent nothing for `maxIdleMs` (no message, no button). Returns what was
   * removed so the caller can tell them; their records are then pruned like any unlinked user.
   */
  expireWatches(maxIdleMs: number, now = Date.now()): { user: User; addrs: string[] }[] {
    const out: { user: User; addrs: string[] }[] = [];
    for (const u of this.all()) {
      if (!u.watches?.length) continue;
      if (now - Math.max(u.lastSeen ?? 0, u.created) <= maxIdleMs) continue;
      out.push({ user: u, addrs: u.watches.map((w) => w.addr) });
      delete u.watches;
    }
    if (out.length) this.save();
    return out;
  }

  /** Forget users who never linked their key within `maxAgeMs` (their key has no power on chain). Watchers stay. */
  pruneUnlinked(maxAgeMs: number, now = Date.now()): number {
    let n = 0;
    for (const [k, u] of Object.entries(this.db.users)) if (!u.owner && !u.watches?.length && now - u.created > maxAgeMs) { delete this.db.users[k]; n++; }
    if (n) this.save();
    return n;
  }

  // ---------- shared cards ----------
  /**
   * The card for this trade: the sharer's existing card when it is the same trade (market, side, entry and
   * open/closed; for a closed trade the same close), refreshed with the latest price and PnL, so a link that
   * was already forwarded keeps working. Otherwise a new card (caller saves).
   */
  upsertCard(rec: Omit<CardRec, "id" | "taps" | "newUsers" | "copies">): CardRec {
    const same = this.cardsBy(rec.by).find((c) => c.base === rec.base && c.side === rec.side && c.open === rec.open && c.entry === rec.entry && (rec.open || c.tradeAt === rec.tradeAt));
    if (!same) return this.addCard(rec);
    Object.assign(same, { lev: rec.lev, price: rec.price, pnl: rec.pnl, at: rec.at });
    return same;
  }

  /**
   * Store a new card (caller saves). Per user, the oldest cards nobody tapped or copied go first once there
   * are more than `cardsPerUser`; in total at most `cardsMax` (untouched ones first). A pruned card's id keeps
   * pointing to its sharer (`cardRef`), so a late tap still credits them.
   */
  addCard(rec: Omit<CardRec, "id" | "taps" | "newUsers" | "copies">): CardRec {
    let id = randomBytes(5).toString("hex");
    while (this.db.cards[id] || this.db.cardRefs[id]) id = randomBytes(5).toString("hex");
    const card: CardRec = { ...rec, id, taps: 0, newUsers: 0, copies: 0 };
    this.db.cards[id] = card;
    const engaged = (c: CardRec) => c.taps + c.newUsers + c.copies > 0;
    const mine = this.cardsBy(rec.by); // newest first
    let extra = mine.length - LIMITS.cardsPerUser;
    for (const old of [...mine].reverse()) {
      if (extra <= 0) break;
      if (old.id === id || engaged(old)) continue;
      this.dropCard(old); extra--;
    }
    const all = Object.values(this.db.cards);
    if (all.length > LIMITS.cardsMax) {
      all.sort((a, b) => Number(engaged(a)) - Number(engaged(b)) || a.at - b.at);
      for (const old of all.slice(0, all.length - LIMITS.cardsMax)) this.dropCard(old);
    }
    return card;
  }

  private dropCard(c: CardRec): void {
    delete this.db.cards[c.id];
    const ref = this.get(c.by)?.ref;
    if (!ref) return;
    this.db.cardRefs[c.id] = { ref, at: Date.now() };
    const ids = Object.keys(this.db.cardRefs);
    if (ids.length > LIMITS.cardRefsMax) {
      ids.sort((a, b) => this.db.cardRefs[a]!.at - this.db.cardRefs[b]!.at);
      for (const k of ids.slice(0, ids.length - LIMITS.cardRefsMax)) delete this.db.cardRefs[k];
    }
  }

  card(id: string): CardRec | undefined { return Object.hasOwn(this.db.cards, id) ? this.db.cards[id] : undefined; }
  /** The share code of a pruned card's sharer, if still known. */
  cardRef(id: string): string | undefined { return Object.hasOwn(this.db.cardRefs, id) ? this.db.cardRefs[id]!.ref : undefined; }
  /** A user's cards, newest first. */
  cardsBy(userId: number): CardRec[] { return Object.values(this.db.cards).filter((c) => c.by === userId).sort((a, b) => b.at - a.at); }
  /** How many users joined through this share code. */
  refCount(ref: string): number { return this.all().filter((u) => u.refBy === ref).length; }
  /** Drop cards older than the TTL (caller logs; saves when something was dropped). */
  pruneCards(now = Date.now()): number {
    let n = 0;
    for (const c of Object.values(this.db.cards)) if (now - c.at > LIMITS.cardTtlMs) { this.dropCard(c); n++; }
    if (n) this.save();
    return n;
  }

  // ---------- watches ----------
  /** Distinct watched addresses, lowercase. */
  watchedAddresses(): string[] {
    const s = new Set<string>();
    for (const u of this.all()) for (const w of u.watches ?? []) s.add(w.addr.toLowerCase());
    return [...s];
  }
  watchersOf(addr: string): User[] {
    const a = addr.toLowerCase();
    return this.all().filter((u) => u.watches?.some((w) => w.addr.toLowerCase() === a));
  }

  // ---------- order log ----------
  /** The last `n` valid rows for `account` from the newest 64 KB of the order log, newest first. */
  recentOrders(account: string, n: number): OrderRow[] {
    const acct = account.toLowerCase();
    let text = "";
    try {
      const fd = openSync(this.orderLog, "r");
      try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - 65_536);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        text = buf.toString("utf8");
        if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
      } finally { closeSync(fd); }
    } catch { return []; }
    const rows: OrderRow[] = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && rows.length < n; i--) {
      const r = lines[i] ? parseOrderLine(lines[i]!, acct) : undefined;
      if (r) rows.push(r);
    }
    return rows;
  }

  /** Totals over the whole current order log (at most 5 MB, it rotates) for `account`. */
  orderTotals(account: string): { orders: number; opens: number; closes: number; autoExits: number; unknown: number; lastAuto?: OrderRow } {
    const acct = account.toLowerCase();
    const out: { orders: number; opens: number; closes: number; autoExits: number; unknown: number; lastAuto?: OrderRow } = { orders: 0, opens: 0, closes: 0, autoExits: 0, unknown: 0 };
    let text = "";
    try { text = readFileSync(this.orderLog, "utf8"); } catch { return out; }
    for (const line of text.split("\n")) {
      const r = line ? parseOrderLine(line, acct) : undefined;
      if (!r) continue;
      out.orders++;
      if (r.kind === "open") out.opens++;
      else if (r.kind === "close") out.closes++;
      else out.unknown++;
      if (r.kind === "close" && autoKind(r.reason)) { out.autoExits++; out.lastAuto = r; }
    }
    return out;
  }

  /** Public on-chain facts only (hash, market, side, size, price): this file feeds evidence/. */
  logOrder(rec: Record<string, unknown>): void {
    try { if (statSync(this.orderLog).size > 5_000_000) renameSync(this.orderLog, `${this.orderLog}.1`); } catch { /* first write */ }
    appendFileSync(this.orderLog, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 });
  }
}
