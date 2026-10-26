// Protection loop. Somnia Reactivity pushes each market's new mark price (eth_subscribe "somnia_watch"
// on the perp pool, eth_call tryGetMarkPrice() evaluated at the same block, push_changes_only), and every
// push re-checks the bot-watched take-profit / stop-loss and the liquidation distance of the users who
// hold that market. A trigger closes the position with the user's trading key. If a market's socket is
// silent for more than SILENT_MS, a polling fallback reads the mark over HTTP instead.
// Watched accounts (/watch, read only): the same pushes check their liquidation distance and send warnings to
// the watchers. Nothing is ever sent to the chain for a watched account.
import { createPublicClient, decodeAbiParameters, toFunctionSelector, webSocket } from "viem";
import { LIMITS, WS_URL } from "./config.ts";
import { fmtPrice, liqDistancePct, triggered, type Side } from "./parse.ts";
import type { Store, User } from "./store.ts";
import { chain, type AccountView, type Venue } from "./venue.ts";

const MARK_SEL = toFunctionSelector("tryGetMarkPrice()");
const SILENT_MS = 15_000;
const RESUB_MS = 90_000;
const REFRESH_MS = 30_000;

export interface Held { userId: number; base: string; pool: `0x${string}`; side: Side; size: number; entry: number; liq?: number }
export type Act = (u: User, base: string, fraction: number, reason: string, opt: { kind: "tp" | "sl" | "guard"; limit?: number; side: Side }) => Promise<void>;
export type Warn = (u: User, base: string, text: string) => Promise<void>;
/** A position of a watched account (addr lowercase). */
export interface WHeld { addr: string; base: string; pool: `0x${string}`; side: Side; size: number; entry: number; liq?: number; mark?: number }
export type WatchWarn = (u: User, addr: string, base: string, text: string) => Promise<void>;
export type WatchGone = (u: User, addr: string, base: string, side: Side) => Promise<void>;

interface Sub { unsubscribe?: () => Promise<unknown>; lastPush: number; startedAt: number; mark?: number; pushes: number }

export class Protector {
  private held = new Map<string, Held>();           // `${userId}:${base}`
  private subs = new Map<string, Sub>();            // pool (lowercase)
  private inflight = new Set<string>();
  private lastWarn = new Map<string, number>();
  private coolUntil = new Map<string, number>();     // after a failed close: wait before retrying
  private spark = new Map<string, number[]>();      // base -> recent marks
  private watchHeld = new Map<string, WHeld>();      // `${addr}:${base}`, watched accounts (read only)
  private watchAcct = new Map<string, { equity: number; at: number }>();
  private watchWarned = new Map<string, Set<number>>(); // `${addr}:${base}` -> watcher ids warned about this position
  private watchWarn?: WatchWarn;
  private watchGone?: WatchGone;
  private watchRefreshing = false;
  private ws = createPublicClient({ chain, transport: webSocket(WS_URL, { keepAlive: { interval: 20_000 }, reconnect: { attempts: 1_000, delay: 2_000 }, timeout: 20_000 }) });
  stats = { pushes: 0, polls: 0, triggers: 0 };
  private timers: NodeJS.Timeout[] = [];

  constructor(private venue: Venue, private store: Store, private act: Act, private warn: Warn, private log = console.log) {}

  start(): void {
    this.timers.push(setInterval(() => void this.refreshAll().catch((e) => this.log("refresh error", String(e).slice(0, 160))), REFRESH_MS));
    this.timers.push(setInterval(() => void this.fallback().catch((e) => this.log("fallback error", String(e).slice(0, 160))), 5_000));
    this.timers.push(setInterval(() => void this.refreshWatched().catch((e) => this.log("watch refresh error", String(e).slice(0, 160))), LIMITS.watchRefreshMs));
    void this.refreshAll().catch(() => {});
    void this.refreshWatched().catch(() => {});
  }

  /** Attach the watch-alert handlers (a setter, so the constructor stays as it was). */
  onWatch(warn: WatchWarn, gone: WatchGone): void { this.watchWarn = warn; this.watchGone = gone; }
  stop(): void { for (const t of this.timers) clearInterval(t); for (const s of this.subs.values()) void s.unsubscribe?.().catch(() => {}); }

  sparkFor(base: string): number[] | undefined { return this.spark.get(base); }
  markFor(pool: string): number | undefined { return this.subs.get(pool.toLowerCase())?.mark; }
  watching(): { pool: string; base: string; pushes: number; ageMs: number }[] {
    return [...this.subs.entries()].map(([pool, s]) => ({ pool, base: this.venue.marketByPool(pool) ? this.venue.baseOf(this.venue.marketByPool(pool)!) : "?", pushes: s.pushes, ageMs: Date.now() - s.lastPush }));
  }

  /** Re-read one user's positions (after a trade, or on the periodic sweep). */
  async refreshUser(u: User): Promise<void> {
    if (!u.owner) { this.dropUser(u.id); return; }
    const view = await this.venue.account(u.owner);
    const seen = new Set<string>();
    for (const p of view.positions) {
      seen.add(p.base);
      this.held.set(`${u.id}:${p.base}`, { userId: u.id, base: p.base, pool: p.pool, side: p.side, size: p.size, entry: p.entry, liq: p.liq });
      const r = u.rules[p.base];
      if (r && r.side !== p.side) { delete u.rules[p.base]; this.store.save(); } // flipped elsewhere: old rule is meaningless
    }
    for (const k of [...this.held.keys()]) {
      const [id, base] = k.split(":");
      if (Number(id) === u.id && !seen.has(base!)) { this.held.delete(k); this.lastWarn.delete(k); } // a new position gets fresh warnings
    }
    // A rule whose position is gone (closed here, in the app, or liquidated) must not fire on a later position.
    const stale = Object.keys(u.rules).filter((b) => !seen.has(b) && Date.now() - u.rules[b]!.setAt > 90_000); // grace: RPC reads can lag a fresh fill
    if (stale.length) { for (const b of stale) delete u.rules[b]; this.store.save(); }
    this.syncSubs();
  }

  private dropUser(id: number): void {
    for (const k of [...this.held.keys()]) if (k.startsWith(`${id}:`)) this.held.delete(k);
    this.syncSubs();
  }

  private refreshing = false;
  private async refreshAll(): Promise<void> {
    if (this.refreshing) return; // never overlap sweeps when the RPC is slow
    this.refreshing = true;
    try { await this.sweep(); } finally { this.refreshing = false; }
  }

  private async sweep(): Promise<void> {
    for (const u of this.store.all()) {
      if (!u.owner) continue;
      try { await this.refreshUser(u); } catch (e) { this.log("refresh failed", String(e).slice(0, 120)); }
    }
  }

  // ---------- watched accounts ----------
  /** Cached view of a watched account (no RPC): equity, positions with the last pushed mark. */
  watchView(addr: string): { equity?: number; at?: number; positions: WHeld[] } {
    const a = addr.toLowerCase();
    const acct = this.watchAcct.get(a);
    return { equity: acct?.equity, at: acct?.at, positions: [...this.watchHeld.values()].filter((w) => w.addr === a) };
  }

  /** Every watcher of `addr` is the account's own linked user: their regular warnings cover it, skip the reads. */
  private ownerCovered(addr: string): boolean {
    const ws = this.store.watchersOf(addr);
    return ws.length > 0 && ws.every((u) => u.owner?.toLowerCase() === addr);
  }

  /** Re-read one watched address, or (no argument) all of them in sequence, never two full sweeps at once. */
  async refreshWatched(addr?: string): Promise<void> {
    if (addr) return this.refreshWatchedList([addr.toLowerCase()]);
    if (this.watchRefreshing) return;
    this.watchRefreshing = true;
    try { await this.refreshWatchedList(); } finally { this.watchRefreshing = false; }
  }

  private async refreshWatchedList(only?: string[]): Promise<void> {
    const watched = new Set(this.store.watchedAddresses());
    for (const [k, w] of [...this.watchHeld]) if (!watched.has(w.addr) || this.ownerCovered(w.addr)) this.forgetWatched(k);
    for (const a of [...this.watchAcct.keys()]) if (!watched.has(a)) this.watchAcct.delete(a);
    for (const a of (only ?? [...watched]).filter((x) => watched.has(x))) {
      if (this.ownerCovered(a)) continue;
      try { await this.applyWatched(a, await this.venue.account(a as `0x${string}`)); } catch (e) { this.log("watch refresh failed", String(e).slice(0, 120)); }
    }
    this.syncSubs();
  }

  private async applyWatched(a: string, view: AccountView): Promise<void> {
    this.watchAcct.set(a, { equity: view.equity, at: Date.now() });
    const seen = new Set<string>();
    for (const p of view.positions) {
      const k = `${a}:${p.base}`;
      const prev = this.watchHeld.get(k);
      if (prev && prev.side !== p.side) await this.watchEnded(k, prev); // flipped: the warned position is gone
      seen.add(p.base);
      this.watchHeld.set(k, { addr: a, base: p.base, pool: p.pool, side: p.side, size: p.size, entry: p.entry, liq: p.liq, mark: p.mark });
    }
    for (const [k, w] of [...this.watchHeld]) {
      if (w.addr === a && !seen.has(w.base)) { this.watchHeld.delete(k); await this.watchEnded(k, w); }
    }
  }

  /** A watched position closed, flipped or was liquidated: tell the watchers who were warned about it, once. */
  private async watchEnded(k: string, w: WHeld): Promise<void> {
    const ids = this.watchWarned.get(k);
    this.watchWarned.delete(k);
    for (const id of ids ?? []) {
      this.lastWarn.delete(`w:${id}:${k}`);
      const u = this.store.get(id);
      if (!u || u.blockedAt || !u.watches?.some((x) => x.addr.toLowerCase() === w.addr)) continue;
      await this.watchGone?.(u, w.addr, w.base, w.side).catch(() => {});
    }
  }

  private forgetWatched(k: string): void {
    this.watchHeld.delete(k);
    for (const id of this.watchWarned.get(k) ?? []) this.lastWarn.delete(`w:${id}:${k}`);
    this.watchWarned.delete(k);
  }

  private syncSubs(): void {
    const need = new Set([...this.held.values(), ...this.watchHeld.values()].map((h) => h.pool.toLowerCase()));
    for (const pool of need) if (!this.subs.has(pool)) void this.subscribe(pool);
    for (const [pool, s] of this.subs) if (!need.has(pool)) { this.subs.delete(pool); void s.unsubscribe?.().catch(() => {}); }
  }

  private async subscribe(pool: string): Promise<void> {
    const sub: Sub = { lastPush: 0, startedAt: Date.now(), pushes: 0 };
    this.subs.set(pool, sub);
    try {
      const { unsubscribe } = await (this.ws.transport as unknown as { subscribe: (a: unknown) => Promise<{ unsubscribe: () => Promise<unknown> }> }).subscribe({
        params: ["somnia_watch", { address: [pool], eth_calls: [{ to: pool, data: MARK_SEL }], push_changes_only: true }],
        onData: (n: { result?: { simulationResults?: `0x${string}`[] }; params?: { result?: { simulationResults?: `0x${string}`[] } } }) => {
          const r = n?.result ?? n?.params?.result;
          const raw = r?.simulationResults?.[0];
          if (!raw || raw.length < 130) return;
          const [ok, px] = decodeAbiParameters([{ type: "bool" }, { type: "uint256" }], raw);
          if (!ok || px === 0n) return;
          sub.lastPush = Date.now(); sub.pushes++; this.stats.pushes++;
          void this.onMark(pool, Number(px) / 1e18);
        },
        onError: (e: unknown) => this.log("watch error", pool.slice(0, 10), String(e).slice(0, 120)),
      });
      if (this.subs.get(pool) !== sub) { await unsubscribe().catch(() => {}); return; }
      sub.unsubscribe = unsubscribe;
    } catch (e) {
      this.log("subscribe failed", pool.slice(0, 10), String(e).slice(0, 120));
    }
  }

  /** Poll any market whose push stream went quiet; re-subscribe streams that stay quiet. */
  private async fallback(): Promise<void> {
    const now = Date.now();
    for (const [pool, s] of this.subs) {
      const quiet = now - Math.max(s.lastPush, s.startedAt);
      if (quiet < SILENT_MS) continue;
      const m = this.venue.marketByPool(pool);
      if (!m) continue;
      const mark = await this.venue.mark(m).catch(() => undefined);
      if (mark) { this.stats.polls++; await this.onMark(pool, mark, "poll"); }
      if (quiet > RESUB_MS) {
        this.log("re-subscribing", pool.slice(0, 10), "quiet", Math.round(quiet / 1000), "s");
        void s.unsubscribe?.().catch(() => {});
        this.subs.delete(pool);
        void this.subscribe(pool);
      }
    }
  }

  async onMark(pool: string, mark: number, _source: "push" | "poll" = "push"): Promise<void> {
    const s = this.subs.get(pool);
    if (s) s.mark = mark;
    const m = this.venue.marketByPool(pool);
    if (!m) return;
    const base = this.venue.baseOf(m);
    const sp = this.spark.get(base) ?? [];
    if (sp[sp.length - 1] !== mark) { sp.push(mark); if (sp.length > 240) sp.shift(); this.spark.set(base, sp); }
    for (const h of this.held.values()) {
      if (h.pool.toLowerCase() !== pool) continue;
      const u = this.store.get(h.userId);
      if (!u) continue;
      const key = `${h.userId}:${h.base}`;
      if (this.inflight.has(key) || Date.now() < (this.coolUntil.get(key) ?? 0)) continue;
      const rule = u.rules[h.base];
      let reason: string | undefined;
      let opt: { kind: "tp" | "sl" | "guard"; limit?: number; side: Side } = { kind: "sl", side: h.side };
      // Stop-loss and guard fire on the mark and exit at market. Take-profit fires on the mark too, but exits
      // with an IOC limited to the TP price, so a book that lags the mark can never turn a TP into a loss.
      if (rule?.sl && triggered("sl", h.side, rule.sl, mark)) reason = `stop-loss ${fmtPrice(rule.sl)} reached (mark ${fmtPrice(mark)})`;
      else if (rule?.tp && triggered("tp", h.side, rule.tp, mark)) { reason = `take-profit ${fmtPrice(rule.tp)} reached (mark ${fmtPrice(mark)})`; opt = { kind: "tp", limit: rule.tp, side: h.side }; }
      const dist = liqDistancePct(h.side, mark, h.liq);
      if (!reason && dist !== undefined && u.guardPct && dist <= u.guardPct) { reason = `liquidation guard: mark ${fmtPrice(mark)} is ${dist.toFixed(2)}% from liquidation ${fmtPrice(h.liq!)}`; opt = { kind: "guard", side: h.side }; }
      if (reason) {
        this.inflight.add(key); this.stats.triggers++;
        try { await this.act(u, h.base, 1, reason, opt); } catch { this.coolUntil.set(key, Date.now() + (opt.kind === "tp" ? 4_000 : 30_000)); } finally {
          this.inflight.delete(key);
          await this.refreshUser(u).catch(() => {});
        }
        continue;
      }
      if (dist !== undefined && dist <= u.liqWarnPct) {
        const last = this.lastWarn.get(key) ?? 0;
        if (Date.now() - last > LIMITS.liqWarnCooldownMs) {
          this.lastWarn.set(key, Date.now());
          await this.warn(u, h.base, `${h.base}-PERP ${h.side}: mark ${fmtPrice(mark)} is only ${dist.toFixed(2)}% from your liquidation price ${fmtPrice(h.liq!)}.`).catch(() => {});
        }
      }
    }
    // Watched accounts: warnings only. `act` is never called for them.
    for (const [k, w] of this.watchHeld) {
      if (w.pool.toLowerCase() !== pool) continue;
      w.mark = mark;
      const dist = liqDistancePct(w.side, mark, w.liq);
      if (dist === undefined) continue;
      for (const u of this.store.watchersOf(w.addr)) {
        if (u.blockedAt || u.owner?.toLowerCase() === w.addr || dist > u.liqWarnPct) continue;
        const ck = `w:${u.id}:${k}`;
        if (Date.now() - (this.lastWarn.get(ck) ?? 0) <= LIMITS.liqWarnCooldownMs) continue;
        this.lastWarn.set(ck, Date.now());
        let ids = this.watchWarned.get(k);
        if (!ids) this.watchWarned.set(k, (ids = new Set()));
        ids.add(u.id);
        await this.watchWarn?.(u, w.addr, w.base, `${w.base}-PERP ${w.side}, mark ${fmtPrice(mark)} is ${dist.toFixed(1)}% from liquidation ${fmtPrice(w.liq!)}`).catch(() => {});
      }
    }
  }
}
