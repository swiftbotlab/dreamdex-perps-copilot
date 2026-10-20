// Protection loop. Somnia Reactivity pushes each market's new mark price (eth_subscribe "somnia_watch"
// on the perp pool, eth_call tryGetMarkPrice() evaluated at the same block, push_changes_only), and every
// push re-checks the bot-watched take-profit / stop-loss and the liquidation distance of the users who
// hold that market. A trigger closes the position with the user's trading key. If a market's socket is
// silent for more than SILENT_MS, a polling fallback reads the mark over HTTP instead.
import { createPublicClient, decodeAbiParameters, toFunctionSelector, webSocket } from "viem";
import { LIMITS, WS_URL } from "./config.ts";
import { fmtPrice, liqDistancePct, triggered, type Side } from "./parse.ts";
import type { Store, User } from "./store.ts";
import { chain, type Venue } from "./venue.ts";

const MARK_SEL = toFunctionSelector("tryGetMarkPrice()");
const SILENT_MS = 15_000;
const RESUB_MS = 90_000;
const REFRESH_MS = 30_000;

export interface Held { userId: number; base: string; pool: `0x${string}`; side: Side; size: number; entry: number; liq?: number }
export type Act = (u: User, base: string, fraction: number, reason: string, opt: { kind: "tp" | "sl" | "guard"; limit?: number; side: Side }) => Promise<void>;
export type Warn = (u: User, base: string, text: string) => Promise<void>;

interface Sub { unsubscribe?: () => Promise<unknown>; lastPush: number; startedAt: number; mark?: number; pushes: number }

export class Protector {
  private held = new Map<string, Held>();           // `${userId}:${base}`
  private subs = new Map<string, Sub>();            // pool (lowercase)
  private inflight = new Set<string>();
  private lastWarn = new Map<string, number>();
  private coolUntil = new Map<string, number>();     // after a failed close: wait before retrying
  private spark = new Map<string, number[]>();      // base -> recent marks
  private ws = createPublicClient({ chain, transport: webSocket(WS_URL, { keepAlive: { interval: 20_000 }, reconnect: { attempts: 1_000, delay: 2_000 }, timeout: 20_000 }) });
  stats = { pushes: 0, polls: 0, triggers: 0 };
  private timers: NodeJS.Timeout[] = [];

  constructor(private venue: Venue, private store: Store, private act: Act, private warn: Warn, private log = console.log) {}

  start(): void {
    this.timers.push(setInterval(() => void this.refreshAll().catch((e) => this.log("refresh error", String(e).slice(0, 160))), REFRESH_MS));
    this.timers.push(setInterval(() => void this.fallback().catch((e) => this.log("fallback error", String(e).slice(0, 160))), 5_000));
    void this.refreshAll().catch(() => {});
  }
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

  private syncSubs(): void {
    const need = new Set([...this.held.values()].map((h) => h.pool.toLowerCase()));
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
  }
}
