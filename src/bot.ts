// Perps Copilot: Telegram front end. Long polling, per-user serial queues, per-user rate limits,
// one global cap on concurrent transactions. User text is parsed by src/parse.ts only; nothing
// user-supplied reaches a shell, an eval, a file path or an SVG without validation.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAddress } from "viem";
import { APP_URL, CHAIN_NAME, DEMO_ACCOUNT, DEMO_HISTORY, DEMO_SCHEDULE, EXPLORER_ADDR, EXPLORER_TX, LIMITS, PATHS } from "./config.ts";
import { renderCard } from "./card.ts";
import { acquireInstanceLock } from "./instance.ts";
import { KeyVault, type SealedKey } from "./keys.ts";
import { KeyedLock, Semaphore } from "./locks.ts";
import { checkVsMark, cleanBase, escapeHtml as h, fmtPrice, fmtUsd, isAddress, liqDistancePct, parseAmount, parseLevel, parseOpen, resolveLevel, splitCommand, type OpenCmd, type Side } from "./parse.ts";
import { Protector } from "./protect.ts";
import { readEnvFile } from "./secrets.ts";
import { autoKind, Store, type CardRec, type OrderRow, type User } from "./store.ts";
import { Telegram, type Button, type TgCallback, type TgMessage, type TgUpdate } from "./tg.ts";
import { findLinkedOwners, OutcomeUnknown, UserError, Venue, type AccountView, type Position, type TradeResult } from "./venue.ts";
import { RpcWatchdog } from "./watchdog.ts";
import { checkMarket, warnKey, type NativeStop, type PositionReport } from "./stops.ts";
import { TRY, TryCaps } from "./trylane.ts";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------- rate limiting ----------
class Bucket {
  private hits = new Map<string, number[]>();
  prune(maxWindowMs: number): void {
    const now = Date.now();
    for (const [k, arr] of this.hits) if (!arr.length || now - arr[arr.length - 1]! > maxWindowMs) this.hits.delete(k);
  }
  allow(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr);
    return true;
  }
}

/** A card-copy preview waiting for its Confirm button. In memory only; each one can be used once. */
interface Draft { uid: number; owner: string; card: string; base: string; side: Side; margin: number; lev: number; exp: number }

/** A user with a bot key (watch-only records have none until /start). */
type KeyedUser = User & { keyAddress: `0x${string}`; key: SealedKey };
const hasKey = (u: User): u is KeyedUser => !!u.key && !!u.keyAddress;
/** 10 hex of a hash of the account: binds a button to the account it was shown for (vanity prefixes do not collide). */
const acctTag = (owner: string) => createHash("sha256").update(owner.toLowerCase()).digest("hex").slice(0, 10);
const closeData = (owner: string, base: string, pct: 50 | 100) => `cl:${base}:${pct}:${acctTag(owner)}`;

const txLink = (hash: string) => `<a href="${EXPLORER_TX}${hash}">${hash.slice(0, 10)}…${hash.slice(-6)}</a>`;
const addrLink = (a: string) => `<a href="${EXPLORER_ADDR}${a}">${a.slice(0, 8)}…${a.slice(-6)}</a>`;
const BLOCKED_RE = /blocked by the user|user is deactivated|chat not found/i;

export class Bot {
  private tg: Telegram;
  private vault: KeyVault;
  private store: Store;
  private venue = new Venue();
  private protector: Protector;
  private me = "";
  private buckets = new Bucket();
  private txs = new Semaphore(LIMITS.maxConcurrentTx, () => new UserError("The bot is busy right now. Try again in a minute."));
  private autoTxs = new Semaphore(2, () => new UserError("The bot is busy right now. Try again in a minute.")); // auto-closes never queue behind other users' opens
  private posLock = new KeyedLock();
  private recentClose = new Map<string, { prevSize: number; at: number; unknown: boolean }>();
  /** `${owner}:${base}` -> an order whose outcome was not confirmed: no new send there until the chain says it is done. */
  private unresolved = new Map<string, { hash?: `0x${string}`; operator: `0x${string}`; at: number }>();
  private pending = new Map<number, number>();
  private queues = new Map<number, Promise<void>>();
  private drafts = new Map<string, Draft>();
  private tapped = new Set<string>();                 // `${card}:${telegramId}`: a tap counts once per process
  private demoAccount: `0x${string}` = DEMO_ACCOUNT;
  private demoHistory: string[] = [...DEMO_HISTORY];
  private demoCache?: { account: string; at: number; view: AccountView; orders: OrderRow[]; totals: ReturnType<Store["orderTotals"]> };
  private releaseLock?: () => void;
  private stopping = false;
  private stopAt = 0;
  /** Process exit code after a clean stop (the watchdog sets 75 when the chain link could not be healed). */
  exitCode = 0;
  readonly watchdog: RpcWatchdog;
  private timers: NodeJS.Timeout[] = [];
  /** Stop-health alerts: the pending native stops last seen per user, and the warnings already sent (key -> time). */
  /** Pending reduce-only stops seen in the last pass, per `${telegramId}:${account}` (a relink starts afresh). */
  private stopSeen = new Map<string, Map<string, { base: string; kind: string; trigger: number }>>();
  private stopCursor = 0;                              // rotates through linked users when there are more than one pass takes
  private stopCache = new Map<string, { at: number; v: Awaited<ReturnType<Bot["stopReportsUncached"]>> }>();
  private stopChecking = false;
  private tryCaps = new TryCaps(`${PATHS.data}/try.json`);
  /** Stop ids found in the registries' own logs (newer than the indexer), per owner (lowercase), kept 15 minutes. */
  private stopLogs = new Map<string, Map<string, { ref: { registry: `0x${string}`; orderId: string }; at: number }>>();

  constructor() {
    const bot = readEnvFile(PATHS.botEnv);
    const master = readEnvFile(PATHS.masterEnv);
    this.tg = new Telegram(bot.BOT_TOKEN ?? "");
    this.vault = new KeyVault(master.DDMVP_MASTER_KEY ?? "");
    this.store = new Store(PATHS.data);
    this.protector = new Protector(this.venue, this.store, (u, b, f, r, o) => this.autoClose(u, b, f, r, o), (u, b, t) => this.liqWarn(u, b, t), log);
    this.protector.onWatch((u, a, b, t) => this.watchWarn(u, a, b, t), (u, a, b, s) => this.watchGone(u, a, b, s));
    this.watchdog = new RpcWatchdog({
      probe: () => this.venue.probe(),
      rebuild: async () => {
        const n = await this.venue.rebuildClient();
        this.protector.resetStreams();
        log(`rpc watchdog: rebuilt the chain client (${n} cached socket${n === 1 ? "" : "s"} closed), push streams re-subscribed`);
      },
      exit: (code) => {
        this.exitCode = code;
        this.requestStop();
        // Backstop: if the drain hangs on a dead link, exit anyway (systemd stops waiting at 90 s).
        setTimeout(() => process.exit(code), LIMITS.shutdownDrainMs + 10_000).unref();
      },
      log,
    });
  }

  /** One watchdog round: probe the chain client, and count a sweep in which every account read failed. */
  watchdogRound() { return this.watchdog.round(this.protector.sweepFailed()); }

  async start(): Promise<void> {
    // First, before any chain or Telegram traffic: one instance only (exit 3 = systemd retries in 15 s).
    try {
      this.releaseLock = acquireInstanceLock(PATHS.data, {
        beatMs: 5_000, staleMs: 12_000,
        onLost: () => { log("instance lock lost (another instance took it): exiting"); process.exit(3); },
      });
    } catch (e) {
      log("instance lock refused:", String(e instanceof Error ? e.message : e).slice(0, 200));
      process.exit(3);
    }
    log("instance lock acquired");
    // The lock is kept until in-flight orders are done (shutdown()), so no second instance sends from the same keys meanwhile.
    const stop = () => this.requestStop();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    await this.venue.init();
    const me = await this.tg.getMe();
    this.me = me.username ?? "";
    log("started as", this.me, "markets", this.venue.list().length, "users", this.store.count());
    await this.tg.setMyCommands([
      { command: "start", description: "Set up: link your bot key" },
      { command: "demo", description: "See a live account, no wallet needed" },
      { command: "watch", description: "Liquidation pings for any account" },
      { command: "long", description: "Open long: /long ETH 20 5x" },
      { command: "short", description: "Open short: /short BTC 20 3x" },
      { command: "close", description: "Close: /close ETH [50%]" },
      { command: "positions", description: "Positions, PnL, liquidation" },
      { command: "stops", description: "Chain-held TP/SL and their health" },
      { command: "tp", description: "Take-profit: /tp ETH 2500 or 4%" },
      { command: "sl", description: "Stop-loss: /sl ETH 2300 or 2%" },
      { command: "card", description: "Share a PnL card" },
      { command: "invite", description: "Your invite link and card stats" },
      { command: "alerts", description: "Liquidation warning distance" },
      { command: "guard", description: "Auto-close near liquidation" },
      { command: "markets", description: "Markets and marks" },
      { command: "status", description: "Account, gas, link" },
      { command: "help", description: "How it works" },
    ]).catch((e) => log("setMyCommands", String(e)));
    await this.tg.setDescription(
      "Trade dreamDEX perps on Somnia Tokyo testnet from Telegram. Market orders with size and leverage, positions with PnL, take-profit / stop-loss that close for you, liquidation alerts, and PnL cards friends can copy. Try /demo first, no wallet needed. Your account stays yours: you link a trading key that can place orders but can never withdraw.",
      "dreamDEX perps from Telegram: orders, TP/SL, liquidation alerts, copyable PnL cards. Testnet.",
    ).catch((e) => log("setDescription", String(e)));
    this.protector.start();
    this.timers.push(setInterval(() => void this.watchdogRound().catch((e) => log("watchdog error", String(e).slice(0, 160))), LIMITS.watchdogMs));
    void this.watchdogRound().catch(() => {}); // first check right away, so /status shows a verified link
    this.timers.push(setInterval(() => void this.stopHealthRound().catch((e) => log("stop check error", String(e).slice(0, 160))), LIMITS.stopCheckMs));
    this.timers.push(setInterval(() => void this.demoScheduleTick().then((r) => { if (r.startsWith("opened") || r.startsWith("skip")) log("demo schedule:", r); }).catch((e) => log("demo schedule error", String(e).slice(0, 160))), DEMO_SCHEDULE.tickMs));
    setInterval(() => void this.housekeeping().catch((e) => log("housekeeping error", String(e).slice(0, 160))), 10 * 60_000).unref();
    await this.poll();
    await this.shutdown();
    log("stopped");
  }

  /** SIGTERM / SIGINT: stop polling and stop starting new trades or auto-closes; work already running finishes. */
  private requestStop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.stopAt = Date.now();
    for (const t of this.timers) clearInterval(t);
    this.protector.stop();
    log("stopping: finishing in-flight work");
  }

  /** Wait (bounded, under systemd's 90 s stop timeout) for queued handlers and running auto-closes, then release the lock. */
  private async shutdown(): Promise<void> {
    const deadline = (this.stopAt || Date.now()) + LIMITS.shutdownDrainMs;
    // No new work can start (polling and the Protector are stopped), so one pass over what is queued or running drains it.
    const drained = (async () => {
      do { await Promise.allSettled([...this.queues.values(), this.protector.idle()]); } while (this.queues.size);
    })();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now())); });
    const done = await Promise.race([drained.then(() => true), timedOut]);
    clearTimeout(timer);
    if (!done) log("shutdown: work still running at the deadline, exiting anyway");
    this.protector.stop();
    this.releaseLock?.();
  }

  private notStopping(): void {
    if (this.stopping) throw new UserError("The bot is restarting. Nothing was sent; send it again in a minute.");
  }

  /** Every 10 minutes: expire rate-limit buckets, drafts and markers; end idle watches (and say so); prune records and cards. */
  private async housekeeping(): Promise<void> {
    const now = Date.now();
    this.buckets.prune(3_600_000);
    for (const [k, v] of this.recentClose) if (now - v.at > 60_000) this.recentClose.delete(k);
    for (const [k, d] of this.drafts) if (d.exp <= now) this.drafts.delete(k);
    for (const [k, v] of this.unresolved) if (now - v.at > LIMITS.unresolvedTtlMs) this.unresolved.delete(k);
    const ended = this.store.expireWatches(LIMITS.watchIdleMs, now);
    for (const { user, addrs } of ended) {
      if (user.blockedAt) continue;
      await this.say(user.id, `I stopped watching ${addrs.map((a) => addrLink(getAddress(a))).join(", ")}: ${Math.round(LIMITS.watchIdleMs / 86_400_000)} days without a message from you. Send <code>/watch 0x…</code> to watch again.`);
    }
    if (ended.length) { log("ended idle watches", ended.length); await this.protector.refreshWatched().catch(() => {}); }
    const n = this.store.pruneUnlinked(48 * 3_600_000, now);
    if (n) log("pruned unlinked users", n);
    const c = this.store.pruneCards(now);
    if (c) log("pruned old cards", c);
  }

  private async poll(): Promise<void> {
    let offset = 0;
    let backoff = 1_000;
    while (!this.stopping) {
      try {
        const updates = await this.tg.getUpdates(offset);
        backoff = 1_000;
        if (this.stopping) break; // not confirmed: the next instance receives these updates
        for (const u of updates) {
          offset = u.update_id + 1;
          this.dispatch(u);
        }
      } catch (e) {
        log("poll error", String(e).slice(0, 160));
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Each user's updates run one at a time, in order; different users run in parallel. */
  private dispatch(u: TgUpdate): void {
    const from = u.message?.from ?? u.callback_query?.from;
    if (!from || from.is_bot) return;
    if (u.message && u.message.chat.type !== "private") return; // private chats only
    if (u.callback_query && u.callback_query.message && u.callback_query.message.chat.type !== "private") return;
    const known = this.store.get(from.id);
    if (known?.blockedAt) { delete known.blockedAt; this.store.save(); } // they are talking to us again
    // Flood control happens BEFORE anything is queued: over-limit updates are dropped, and each user
    // may have at most 5 updates waiting.
    if (!this.buckets.allow(`cmd:${from.id}`, LIMITS.cmdPerMinute, 60_000)) {
      if (u.callback_query) void this.tg.answerCallback(u.callback_query.id, "Too fast").catch(() => {});
      return;
    }
    const waiting = this.pending.get(from.id) ?? 0;
    if (waiting >= 5) return;
    this.pending.set(from.id, waiting + 1);
    const prev = this.queues.get(from.id) ?? Promise.resolve();
    const next = prev.then(() => this.handle(u)).catch((e) => log("handler error", String(e).slice(0, 200)))
      .finally(() => { const n = (this.pending.get(from.id) ?? 1) - 1; if (n > 0) this.pending.set(from.id, n); else this.pending.delete(from.id); });
    this.queues.set(from.id, next);
    void next.finally(() => { if (this.queues.get(from.id) === next) this.queues.delete(from.id); });
  }

  private async handle(u: TgUpdate): Promise<void> {
    const from = u.message?.from ?? u.callback_query?.from;
    const known = from ? this.store.get(from.id) : undefined;
    if (known) { const prev = known.lastSeen ?? 0; known.lastSeen = Date.now(); if (known.lastSeen - prev > 3_600_000) this.store.save(); }
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message!;
    const chat = m.chat.id;
    const text = m.text ?? "";
    if (text.length > LIMITS.msgMaxLen) { await this.say(chat, "That message is too long. Send /help for the commands."); return; }
    const c = splitCommand(text, this.me);
    if (!c) { await this.say(chat, "Send a command, for example <code>/long ETH 20 5x</code>. /help lists them all."); return; }
    try {
      await this.route(m, c.cmd, c.args);
    } catch (e) {
      if (e instanceof UserError) { await this.say(chat, h(e.message)); return; }
      log("command failed", c.cmd, String(e instanceof Error ? e.message : e).slice(0, 300));
      await this.say(chat, "Something went wrong talking to the chain. If an order was sent, /positions will show it. Please try again.");
    }
  }

  private async route(m: TgMessage, cmd: string, args: string[]): Promise<void> {
    const id = m.from!.id, chat = m.chat.id;
    if (cmd === "start") return this.cmdStart(id, chat, args[0]);
    if (cmd === "help") return this.cmdHelp(chat);
    if (cmd === "markets") return this.cmdMarkets(chat);
    if (cmd === "demo") return this.cmdDemo(id, chat);
    if (cmd === "stops") return this.cmdStops(id, chat, args[0]);
    if (cmd === "try") return this.cmdTry(chat);
    if (cmd === "watch" || cmd === "unwatch") {
      // No link and no key needed: watching only reads public chain state. A keyless record holds the watch
      // list, made only for a valid /watch request.
      const existing = this.store.get(id);
      if (!existing) {
        if (cmd === "unwatch" || !args[0]) { await this.say(chat, cmd === "watch" ? this.watchUsage(LIMITS.defaultLiqWarnPct) : "You watch no accounts."); return; }
        const bad = this.watchAddrProblem(args[0], LIMITS.defaultLiqWarnPct);
        if (bad) { await this.say(chat, bad); return; }
      }
      const r = existing ? { user: existing } : await this.ensureUser(id, chat, { key: false });
      if (!r) return;
      return cmd === "watch" ? this.cmdWatch(r.user, chat, args[0]) : this.cmdUnwatch(r.user, chat, args[0]);
    }
    const user = this.store.get(id);
    if (!user || !hasKey(user)) {
      if (user && cmd === "alerts") return this.cmdAlerts(user, chat, args[0]); // watchers set their warning distance too
      await this.say(chat, "Send /start first to get your personal bot key, or /demo to look around.");
      return;
    }
    switch (cmd) {
      case "key": return this.cmdKey(user, chat);
      case "link": return this.cmdLink(user, chat, args[0]);
      case "unlink": return this.cmdUnlink(user, chat);
      case "status": return this.cmdStatus(user, chat);
      case "long": case "short": return this.cmdOpen(user, chat, cmd, args);
      case "close": return this.cmdClose(user, chat, args);
      case "positions": case "pos": return this.cmdPositions(user, chat);
      case "tp": case "sl": return this.cmdRule(user, chat, cmd, args);
      case "alerts": return this.cmdAlerts(user, chat, args[0]);
      case "guard": return this.cmdGuard(user, chat, args[0]);
      case "card": return this.cmdCard(user, chat, args[0]);
      case "invite": return this.cmdInvite(user, chat);
      default: await this.say(chat, "Unknown command. /help lists them.");
    }
  }

  /** Send a message. If Telegram says the user blocked the bot (or the chat is gone), mark them so pings stop. */
  /** Send a message; resolves true when Telegram accepted it. Chat 0 = no chat (a scheduled demo trade): nothing is sent. */
  private say(chat: number, html: string, buttons?: Button[][]): Promise<boolean> {
    if (chat === 0) return Promise.resolve(true);
    return this.tg.sendMessage(chat, html, buttons).then(() => true, (e) => {
      const msg = String(e instanceof Error ? e.message : e);
      log("send failed", msg.slice(0, 120));
      if (BLOCKED_RE.test(msg)) {
        const u = this.store.get(chat); // private chats only: the chat id is the user id
        if (u && !u.blockedAt) { u.blockedAt = Date.now(); this.store.save(); }
      }
      return false;
    });
  }

  // ---------- onboarding ----------
  /**
   * Create the user record if it does not exist yet, within the sign-up caps. With `key` (the default) the
   * user also gets their bot key (a watch-only record gets one here when it first needs it); `key: false`
   * makes a keyless watch-only record, capped separately and never counted against the key quota.
   */
  private async ensureUser(id: number, chat: number, o: { refBy?: string; via?: string; key?: boolean } = {}): Promise<{ user: User; created: boolean } | undefined> {
    const wantKey = o.key !== false;
    const existing = this.store.get(id);
    if (existing) {
      if (wantKey && !hasKey(existing) && !(await this.giveKey(existing, chat))) return undefined;
      return { user: existing, created: false };
    }
    let user: User;
    if (wantKey) {
      if (!(await this.keyAllowed(chat))) return undefined;
      const { address, sealed } = this.vault.create(id);
      user = this.store.add({ id, created: Date.now(), keyAddress: address, key: sealed, refBy: o.refBy });
    } else {
      if (this.store.count() - this.store.countKeyed() >= LIMITS.watchUsersMax) { await this.say(chat, "Watch mode is full right now. Please try again later."); return undefined; }
      user = this.store.add({ id, created: Date.now(), refBy: o.refBy });
    }
    log(wantKey ? "new user" : "new watcher", o.refBy ? o.via ?? "via link" : "direct", "total", this.store.count());
    return { user, created: true };
  }

  private async keyAllowed(chat: number): Promise<boolean> {
    if (this.store.countKeyed() >= LIMITS.maxUsers) { await this.say(chat, "The testnet beta is full right now. Please try again later."); return false; }
    if (this.store.keysMadeLastHour() >= LIMITS.newKeysPerHour) { await this.say(chat, "Lots of sign-ups this hour. Please try again in a few minutes."); return false; }
    return true;
  }

  /** A watch-only record gets its bot key (within the same caps as a new user). */
  private async giveKey(u: User, chat: number): Promise<boolean> {
    if (hasKey(u)) return true;
    if (!(await this.keyAllowed(chat))) return false;
    const { address, sealed } = this.vault.create(u.id);
    this.store.setKey(u, address, sealed);
    log("watcher got a key", "total keyed", this.store.countKeyed());
    return true;
  }

  private async cmdStart(id: number, chat: number, payload?: string): Promise<void> {
    const cardId = payload && /^c_[0-9a-f]{10}$/.test(payload) ? payload.slice(2) : undefined;
    const card = cardId ? this.store.card(cardId) : undefined;
    let refBy: string | undefined;
    if (card) {
      const sharer = this.store.get(card.by);
      if (sharer && sharer.id !== id) refBy = sharer.ref;
    } else if (cardId) {
      // An expired or pruned card: no trade to show, but the sharer still gets the credit.
      const ref = this.store.cardRef(cardId);
      const sharer = ref ? this.store.byRef(ref) : undefined;
      if (sharer && sharer.id !== id) refBy = ref;
    } else if (payload && /^r_[0-9a-f]{10}$/.test(payload) && this.store.byRef(payload.slice(2))) {
      refBy = payload.slice(2);
    }
    const r = await this.ensureUser(id, chat, { refBy, via: cardId ? "via card" : "via share link" });
    if (!r || !hasKey(r.user)) return;
    const user = r.user;
    if (cardId && !card) await this.say(chat, "That shared trade has expired (shared cards last 30 days). Here is how to start:");
    if (card) {
      if (card.by !== id) { // the sharer's own taps change no counters and send no ping
        const tapKey = `${card.id}:${id}`;
        if (!this.tapped.has(tapKey)) {
          if (this.tapped.size >= LIMITS.tapsTracked) this.tapped.clear();
          this.tapped.add(tapKey);
          card.taps++;
        }
        if (r.created) card.newUsers++;
        this.store.save();
        if (r.created) await this.pingSharer(card, `🎉 Your ${card.base} card brought a new user to Perps Copilot.`);
      }
      if (user.owner) { await this.cardLanding(user, chat, card); return; }
      user.pendingCopy = { card: card.id, at: Date.now() };
      this.store.save();
      await this.cardLanding(user, chat, card);
    }
    const linked = user.owner ? `\n\nLinked account: ${addrLink(user.owner)}. Try <code>/long ETH 20 5x</code> or /positions.` : "";
    await this.say(chat,
      `Look around first, no wallet needed: /demo (a live account run by this bot) · <code>/watch 0xYourAccount</code> (liquidation pings)\n\n` +
      `<b>Perps Copilot</b> trades dreamDEX perps on ${CHAIN_NAME} for you, right here in Telegram.\n\n` +
      `<b>To trade, link your personal bot key</b> (you never share your wallet):\n<code>${user.keyAddress}</code>\n` +
      `1. In <a href="${APP_URL}">app.testnet.dreamdex.io</a> open your wallet, <b>Link a bot</b>.\n` +
      `2. Paste the address, keep <b>Perps</b> ticked, <b>Add bot</b> (let the app send it a little STT for gas).\n` +
      `3. Keep USDso in your <b>Perps</b> balance (Perps Arena paper USDso works).\n` +
      `4. Press <b>I've linked it</b>.\n\n` +
      `The key can place and close orders for your account. It <b>cannot withdraw or move funds</b>; remove it in the app any time.` + linked,
      [[{ text: "Open dreamDEX", url: APP_URL }], [{ text: "I've linked it", callback_data: "chk" }]]);
  }

  private async cmdHelp(chat: number): Promise<void> {
    await this.say(chat,
      `<b>Commands</b>\n` +
      `/demo  a live account run by this bot (no wallet needed)\n` +
      `<code>/watch 0xAccount</code>  liquidation pings for any account, read only (/unwatch)\n` +
      `<code>/long ETH 20 5x</code> market long: 20 USDso margin at 5x = 100 USDso position\n` +
      `<code>/short BTC 15 10x tp 3% sl 1.5%</code> short with take-profit and stop-loss\n` +
      `<code>/close ETH</code> or <code>/close ETH 50%</code>\n` +
      `/positions  PnL, liquidation price and distance, chain-held TP/SL\n` +
      `/stops  the dreamDEX TP/SL the chain holds for you, checked (<code>/stops 0x…</code> for any account)\n` +
      `<code>/tp ETH 2500</code>, <code>/sl ETH 2%</code>, <code>/tp ETH off</code>  bot-watched exits\n` +
      `<code>/alerts 10</code> warn when within 10% of liquidation\n` +
      `<code>/guard 3</code> auto-close when within 3% (<code>/guard off</code>)\n` +
      `/card  PnL card friends can copy · /invite  your link and card stats\n` +
      `/markets   /status   /key\n\n` +
      `<b>How protection works</b>: two layers. (1) Chain-held: TP/SL you arm in the dreamDEX app live on chain and fire with no bot at all; /stops shows them and warns when one would close only part of your position or nothing. (2) Bot-side: /tp, /sl and /guard. The bot follows every market you hold through Somnia Reactivity (the chain pushes the mark price on each pool event that changes the mark) and closes for you when a level is reached. That layer runs while the bot runs.\n\n` +
      `Testnet only (${CHAIN_NAME}). Not financial advice.`);
  }

  private async cmdKey(u: KeyedUser, chat: number): Promise<void> {
    const gas = await this.venue.gasBalance(u.keyAddress);
    await this.say(chat, `Your bot key: <code>${u.keyAddress}</code>\nGas: ${gas.toFixed(4)} STT${gas < LIMITS.lowGasStt ? " (low: each order costs about 0.015 STT; top it up from the app's Link a bot screen or send STT to the address)" : ""}\n${addrLink(u.keyAddress)}`);
  }

  private async cmdLink(u: KeyedUser, chat: number, arg?: string): Promise<void> {
    if (!isAddress(arg)) { await this.say(chat, "Send <code>/link 0xYourDreamdexAccount</code>, or link the bot key in the app and press <b>I've linked it</b> after /start."); return; }
    if (!this.linkCheckAllowed(u.id)) { await this.say(chat, "Please wait a minute before linking again."); return; }
    await this.attach(u, chat, getAddress(arg));
  }

  private linkCheckAllowed(id: number): boolean {
    return this.buckets.allow(`link:${id}`, 3, 60_000) && this.buckets.allow(`linkh:${id}`, 15, 3_600_000);
  }

  private async attach(u: KeyedUser, chat: number, owner: `0x${string}`): Promise<void> {
    if (owner.toLowerCase() === u.keyAddress.toLowerCase()) { await this.say(chat, "That is the bot key itself. Send the dreamDEX account you linked it to."); return; }
    const cov = await this.venue.coverage(owner, u.keyAddress);
    if (!cov.linked.length) {
      await this.say(chat, `The bot key is not linked to ${addrLink(owner)} yet. In the app: wallet, <b>Link a bot</b>, paste <code>${u.keyAddress}</code>, keep Perps ticked, Add bot. Then press the button again.`, [[{ text: "I've linked it", callback_data: "chk" }]]);
      return;
    }
    if (u.owner && u.owner.toLowerCase() !== owner.toLowerCase()) {
      // A TP/SL, an open record or a pending copy set on the old account must never act on the new one.
      u.rules = {}; u.opens = {}; delete u.lastClosed; delete u.pendingCopy;
      this.protector.dropUser(u.id); // synchronously, before the owner changes: no push may see the old positions under the new owner
      log("relink: cleared per-account state");
    }
    u.owner = owner; this.venue.forgetKey(u.id); this.store.save();
    const [acct, gas] = await Promise.all([this.venue.account(owner), this.venue.gasBalance(u.keyAddress)]);
    await this.protector.refreshUser(u).catch(() => {});
    await this.say(chat,
      `Linked to <code>${owner}</code> on ${cov.linked.length} of ${cov.linked.length + cov.missing.length} markets.\n` +
      `Perps balance: ${fmtUsd(acct.unlocked)} USDso free, equity ${fmtUsd(acct.equity)}.\nBot key gas: ${gas.toFixed(3)} STT.\n` +
      (cov.missing.length ? `Not covered: ${cov.missing.join(", ")} (add the same address again with Link a bot to cover them).\n` : "") +
      (acct.equity <= 0 ? "Your Perps balance is empty: move USDso Spot -> Perps in the app first.\n" : "") +
      (gas < LIMITS.lowGasStt ? "Gas is low: the key needs STT to send orders.\n" : "") +
      `\nTry <code>/long ETH 20 5x</code>.`);
    const pc = u.pendingCopy;
    if (pc) {
      delete u.pendingCopy; this.store.save();
      const card = Date.now() - pc.at < LIMITS.pendingCopyTtlMs ? this.store.card(pc.card) : undefined;
      if (card) await this.cardLanding(u, chat, card);
    }
  }

  private async cmdUnlink(u: User, chat: number): Promise<void> {
    this.protector.dropUser(u.id);
    delete u.owner; u.rules = {}; u.opens = {}; delete u.lastClosed; delete u.pendingCopy;
    this.venue.forgetKey(u.id); this.store.save();
    await this.protector.refreshUser(u).catch(() => {});
    await this.say(chat, "Unlinked here: no more orders or protection. To revoke the key on chain too, remove the bot in the app's Link a bot screen.");
  }

  private async cmdMarkets(chat: number): Promise<void> {
    const order = ["BTC", "ETH", "SOL", "HYPE", "XRP"];
    const rank = (b: string) => (order.indexOf(b) + 1 || 99);
    const list = this.venue.list().sort((a, b) => rank(this.venue.baseOf(a)) - rank(this.venue.baseOf(b)) || this.venue.baseOf(a).localeCompare(this.venue.baseOf(b)));
    const rows = await Promise.all(list.map(async (m) => {
      const b = this.venue.baseOf(m);
      const mk = await this.venue.mark(m).catch(() => undefined);
      return `${b.padEnd(9)}${(mk ? fmtPrice(mk) : "stale").padStart(14)}  ${String(this.venue.maxLeverage(b)).padStart(2)}x`;
    }));
    await this.say(chat, `<b>Perp markets</b> (${CHAIN_NAME}, quoted in USDso)\n<pre>${h(rows.join("\n"))}</pre>`);
  }

  private async cmdStatus(u: KeyedUser, chat: number): Promise<void> {
    const gas = await this.venue.gasBalance(u.keyAddress);
    if (!u.owner) { await this.say(chat, `Not linked yet. Bot key <code>${u.keyAddress}</code> (gas ${gas.toFixed(3)} STT). Send /start for the steps.`); return; }
    const acct = await this.venue.account(u.owner);
    const rules = Object.entries(u.rules).map(([b, r]) => `${b}: ${r.tp ? `TP ${fmtPrice(r.tp)} ` : ""}${r.sl ? `SL ${fmtPrice(r.sl)}` : ""}`).join("\n");
    const w = this.protector.watching();
    await this.say(chat,
      `<b>Account</b> ${addrLink(u.owner)}\nEquity ${fmtUsd(acct.equity)} USDso · free ${fmtUsd(acct.unlocked)} · ${h(acct.status)}\n` +
      `Open positions: ${acct.positions.length}\nBot key gas: ${gas.toFixed(3)} STT\n` +
      `Liquidation warning: within ${u.liqWarnPct}% · guard: ${u.guardPct ? `auto-close within ${u.guardPct}%` : "off"}\n` +
      (rules ? `<b>Watched exits</b>\n${h(rules)}\n` : "") +
      `Somnia Reactivity: ${w.length} live mark stream${w.length === 1 ? "" : "s"}${w.length ? ` (${w.map((x) => `${x.base} ${x.pushes} pushes`).join(", ")})` : ""}\n` +
      this.linkLine());
  }

  /** The watchdog's view of the chain link, for /status and /demo. */
  private linkLine(): string {
    const w = this.watchdog;
    if (w.streak) return `Chain link: degraded (${w.streak} failed check${w.streak === 1 ? "" : "s"} in a row; the bot reconnects by itself)`;
    if (w.lastOkAt === undefined) return "Chain link: starting up";
    return `Chain link: OK, last verified ${Math.max(0, Math.round((Date.now() - w.lastOkAt) / 1000))} s ago`;
  }

  // ---------- /demo: a live account, no wallet needed ----------
  /** The demo account first, then earlier demo accounts (their bot orders still count in the history). */
  private demoAccounts(): string[] {
    const cur = this.demoAccount.toLowerCase();
    return [cur, ...this.demoHistory.map((a) => a.toLowerCase()).filter((a) => a !== cur)];
  }

  private async demoData() {
    const account = this.demoAccount;
    const c = this.demoCache;
    if (c && c.account === account && Date.now() - c.at < LIMITS.demoCacheMs) return c;
    const view = await this.venue.account(account);
    const accts = this.demoAccounts();
    const orders = accts.flatMap((a) => this.store.recentOrders(a, 5)).sort((x, y) => (x.t < y.t ? 1 : x.t > y.t ? -1 : 0)).slice(0, 5);
    const totals = accts.map((a) => this.store.orderTotals(a)).reduce((s, t) => ({
      orders: s.orders + t.orders, opens: s.opens + t.opens, closes: s.closes + t.closes, autoExits: s.autoExits + t.autoExits, unknown: s.unknown + t.unknown,
      lastAuto: !s.lastAuto || (t.lastAuto && t.lastAuto.t > s.lastAuto.t) ? t.lastAuto ?? s.lastAuto : s.lastAuto,
    }));
    const fresh = { account, at: Date.now(), view, orders, totals };
    this.demoCache = fresh;
    return fresh;
  }

  private orderLine(r: OrderRow): string {
    const auto = autoKind(r.reason);
    const lat = auto && r.latencyMs !== undefined ? `, closed ${(r.latencyMs / 1000).toFixed(1)} s after the ${r.trigSrc === "poll" ? "polled" : "pushed"} mark crossed` : "";
    const tag = r.kind === "unknown" ? "outcome not confirmed at send" : auto ? `auto: ${auto}${lat}` : r.reason ? h(r.reason.slice(0, 40)) : "";
    const fill = r.filled !== undefined ? ` ${r.filled}${r.avgPrice !== undefined ? ` @ ${fmtPrice(r.avgPrice)}` : ""}` : "";
    const via = r.via === "card" ? " · card copy" : r.via === "schedule" ? " · scheduled demo trade" : r.via === "try" ? " · live trial" : "";
    return `${r.t.slice(5, 16).replace("T", " ")} ${r.kind} ${r.market} ${r.side}${fill}${tag ? ` · ${tag}` : ""}${via} · ${txLink(r.hash)}`;
  }

  private async cmdDemo(id: number, chat: number): Promise<void> {
    if (!this.buckets.allow(`demo:${id}`, LIMITS.demoPerMinute, 60_000)) { await this.say(chat, "One moment: /demo works a few times a minute."); return; }
    const d = await this.demoData();
    const pos = d.view.positions.map((p) => {
      const dist = liqDistancePct(p.side, p.mark, p.liq);
      return `${p.base}-PERP ${p.side} ${p.size} · entry ${fmtPrice(p.entry)} · mark ${fmtPrice(p.mark)} · PnL ${fmtUsd(p.upnl, true)}${dist !== undefined ? ` · ${dist.toFixed(1)}% from liquidation` : ""}`;
    });
    const t = d.totals;
    const hist = this.demoAccounts().slice(1);
    const w = this.protector.watching();
    await this.say(chat,
      `<b>Live demo</b>: a dreamDEX account this bot trades for on ${CHAIN_NAME} (testnet USDso), through a linked bot key.\n` +
      `Account ${addrLink(d.account)} · equity ${fmtUsd(d.view.equity)} USDso\n` +
      (pos.length ? `${pos.join("\n")}\n` : "No open positions right now.\n") +
      (d.orders.length ? `\n<b>Last bot orders</b>\n${d.orders.map((r) => this.orderLine(r)).join("\n")}\n` : "") +
      (t.lastAuto ? `\n<b>Last auto-exit</b>: ${t.lastAuto.t.slice(5, 16).replace("T", " ")} UTC ${t.lastAuto.market} ${autoKind(t.lastAuto.reason)} · ${txLink(t.lastAuto.hash)}\n` : "") +
      `\n<b>Totals</b>: ${t.orders} orders (${t.opens} opens, ${t.closes} closes), ${t.autoExits} closed by the bot itself (take-profit, stop-loss or guard)${t.unknown ? `, ${t.unknown} not confirmed at send` : ""}${hist.length ? `; including the earlier demo account${hist.length === 1 ? "" : "s"} ${hist.map((a) => addrLink(getAddress(a))).join(", ")}` : ""}.\n` +
      `<b>Somnia Reactivity</b>: ${w.length} live mark stream${w.length === 1 ? "" : "s"}${w.length ? ` (${w.map((x) => `${x.base} ${x.pushes} pushes`).join(", ")})` : ""}.\n` +
      `${this.linkLine()}.`,
      [[{ text: "Sample PnL card", callback_data: "dc" }], [{ text: "Watch this account", callback_data: "wd" }], [{ text: "Start trading", callback_data: "st" }]]);
  }

  private async demoCard(viewer: number, chat: number): Promise<void> {
    if (!this.buckets.allow(`card:${viewer}`, LIMITS.cardsPerMinute, 60_000)) { await this.say(chat, "One moment: card limit reached, try again in a minute."); return; }
    const accts = this.demoAccounts();
    const du = accts.map((a) => this.store.all().find((x) => x.owner?.toLowerCase() === a)).find(Boolean);
    let rec = du ? this.store.cardsBy(du.id)[0] : undefined;
    if (!rec && du?.lastClosed) {
      const c = du.lastClosed;
      rec = this.store.upsertCard({ by: du.id, base: c.base, side: c.side, lev: c.lev ?? du.opens[c.base]?.leverage, entry: c.entry, price: c.exit, pnl: c.pnl, open: false, at: Date.now(), tradeAt: c.at });
      this.store.save();
    }
    if (!rec) { await this.say(chat, "No sample card yet."); return; }
    await this.sendCard(chat, rec, "Sample card from the demo account.");
  }

  // ---------- trading ----------
  private requireLinked(u: User): { owner: `0x${string}` } {
    if (!u.owner) throw new UserError("Link your bot key first: send /start and follow the steps.");
    return { owner: u.owner };
  }

  private tk(u: User) {
    const { owner } = this.requireLinked(u);
    if (!hasKey(u)) throw new UserError("Send /start first to get your personal bot key.");
    return this.venue.tradingKey(u.id, owner, () => this.vault.open(u.id, u.key));
  }

  /** An earlier order on this account+market whose outcome is unknown blocks new sends there until the chain settles it. */
  private async checkUnresolved(tk: { owner: string }, base: string): Promise<void> {
    const k = `${tk.owner.toLowerCase()}:${base}`;
    const ur = this.unresolved.get(k);
    if (!ur) return;
    const st = await this.venue.txState(ur.operator, ur.hash).catch(() => "unknown" as const);
    if (st === "mined" || st === "none") { this.unresolved.delete(k); return; } // the next read of the position shows the result
    throw new UserError(`An earlier ${base}-PERP order${ur.hash ? ` (tx ${ur.hash.slice(0, 10)}…)` : ""} is still pending on chain, so its result is not confirmed yet. Nothing was sent; check /positions in a moment.`);
  }

  private markUnresolved(tk: { owner: string; operator: `0x${string}` }, base: string, hash?: `0x${string}`): void {
    this.unresolved.set(`${tk.owner.toLowerCase()}:${base}`, { hash, operator: tk.operator, at: Date.now() });
  }

  private tradeAllowed(u: User): void {
    if (!this.buckets.allow(`trade:${u.id}`, LIMITS.tradesPerMinute, 60_000) || !this.buckets.allow(`tradeh:${u.id}`, LIMITS.tradesPerHour, 3_600_000)) {
      throw new UserError("Slow down a little: too many orders in a short time.");
    }
  }

  private async gasCheck(u: User): Promise<void> {
    if (!u.keyAddress) throw new UserError("Send /start first to get your personal bot key.");
    const gas = await this.venue.gasBalance(u.keyAddress);
    if (gas < 0.02) throw new UserError(`Your bot key has ${gas.toFixed(4)} STT, not enough for gas. Send STT to ${u.keyAddress} (or use Top up on the app's Link a bot screen).`);
  }

  /** Fresh fills can take a moment to show in RPC reads: re-read until `ok` holds (max ~6 s). */
  private async waitPosition(owner: `0x${string}`, base: string, ok: (p: Position | undefined) => boolean): Promise<Position | undefined> {
    let p: Position | undefined;
    for (let i = 0; i < 5; i++) {
      p = (await this.venue.account(owner)).positions.find((x) => x.base === base);
      if (ok(p)) return p;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return p;
  }

  private async cmdOpen(u: User, chat: number, side: Side, args: string[]): Promise<void> {
    await this.venue.reloadMarkets().catch(() => {});
    const p = parseOpen(side, args, (b) => this.venue.maxLeverage(b));
    if (typeof p === "string") { await this.say(chat, h(p)); return; }
    const tk = this.tk(u);
    this.tradeAllowed(u);
    await this.posLock.run(`${tk.owner.toLowerCase()}:${p.base}`, () => this.openLocked(u, chat, side, p, tk));
  }

  private async openLocked(u: User, chat: number, side: Side, p: OpenCmd, tk: ReturnType<Bot["tk"]>, opts: { maxTouchPct?: number; via?: "card" | "schedule" | "try"; card?: string; quiet?: boolean } = {}): Promise<TradeResult | undefined> {
    this.notStopping();
    const m = this.venue.market(p.base)!;
    await this.checkUnresolved(tk, p.base);
    const [cap, acct] = await Promise.all([this.venue.accountCap(tk.owner, m), this.venue.account(tk.owner)]);
    if (cap > 0 && p.leverage > cap) throw new UserError(`Your account caps ${p.base}-PERP at ${cap}x (set in the app). Use ${cap}x or less, or raise it in the app.`);
    const existing = acct.positions.find((x) => x.base === p.base);
    if (existing && existing.side !== side) throw new UserError(`You hold a ${existing.side} on ${p.base}-PERP. Close it first with /close ${p.base} (this bot does not flip positions by accident).`);
    await this.gasCheck(u);
    const notional = p.margin * p.leverage;
    const minN = this.venue.minNotional(p.base);
    if (minN && notional < minN * 1.02) throw new UserError(`Too small: the minimum ${p.base}-PERP order is about ${(minN * 1.02).toFixed(2)} USDso notional (margin x leverage).`);
    const extra = opts.via ? { via: opts.via, card: opts.card } : undefined;
    await this.say(chat, `Sending ${side} ${p.base}-PERP, ${fmtUsd(notional)} USDso (${fmtUsd(p.margin)} x ${p.leverage}x), market order…`);
    let r: TradeResult;
    try {
      r = await this.txs.run(() => this.venue.open(tk, p.base, side, notional, { maxTouchPct: opts.maxTouchPct }));
    } catch (e) {
      // Maybe on chain: log it so evidence/ re-verifies it from the receipt. It is never resent.
      if (e instanceof OutcomeUnknown) {
        this.markUnresolved(tk, p.base, e.hash);
        this.record(u, tk.owner, "unknown", { base: p.base, side, hash: e.hash }, undefined, { intent: "open", ...extra });
      }
      throw e;
    }
    this.record(u, tk.owner, "open", r, undefined, extra);
    if (r.filledBase === 0) { await this.say(chat, `Nothing filled (the book moved). Tx ${txLink(r.hash)}. No position was opened.`); return r; }
    u.opens[p.base] = existing ? { margin: (u.opens[p.base]?.margin ?? 0) + p.margin, leverage: p.leverage, at: Date.now() } : { margin: p.margin, leverage: p.leverage, at: Date.now() };
    const notes: string[] = [];
    const ref = r.avgPrice ?? 0;
    const markNow = p.tp || p.sl ? await this.venue.mark(m).catch(() => undefined) : undefined;
    for (const k of ["tp", "sl"] as const) {
      const lv = p[k];
      if (!lv || !ref) continue;
      const v = resolveLevel(k, side, lv, ref);
      if (typeof v === "string") { notes.push(`${k.toUpperCase()} not set: ${v}`); continue; }
      const bad = markNow ? checkVsMark(k, side, v, markNow) : undefined;
      if (bad) { notes.push(`${k.toUpperCase()} not set: ${bad} Set it again with /${k} ${p.base}.`); continue; }
      const old = u.rules[p.base];
      if (k === "sl" && opts.via === "card" && old?.sl !== undefined && old.side === side && (side === "long" ? old.sl > v : old.sl < v)) {
        notes.push(`SL kept at ${fmtPrice(old.sl)} (tighter than 3% from this fill)`); // a copy's preset stop never loosens the user's own
        continue;
      }
      u.rules[p.base] = { ...(old ?? { side, setAt: Date.now() }), side, [k]: v, ...(opts.quiet ? { quiet: true } : {}) };
      notes.push(`${k.toUpperCase()} ${fmtPrice(v)} watched`);
    }
    this.store.save();
    await this.protector.refreshUser(u).catch(() => {});
    const pos = await this.waitPosition(tk.owner, p.base, (x) => !!x && (!existing || x.size !== existing.size));
    await this.say(chat,
      `<b>Filled</b> ${side} ${r.filledBase} ${p.base} @ ${r.avgPrice ? fmtPrice(r.avgPrice) : "?"}\nTx ${txLink(r.hash)}\n` +
      (pos ? `Position: ${pos.side} ${pos.size} ${p.base}, entry ${fmtPrice(pos.entry)}${pos.liq ? `, liquidation ${fmtPrice(pos.liq)}` : ""}\n` : "") +
      (notes.length ? h(notes.join(" · ")) + "\n" : `Add exits: <code>/tp ${p.base} 4%</code> <code>/sl ${p.base} 2%</code>\n`),
      [[{ text: `Close ${p.base}`, callback_data: closeData(tk.owner, p.base, 100) }, { text: "PnL card", callback_data: `cd:${p.base}` }]]);
    return r;
  }

  private async cmdClose(u: User, chat: number, args: string[]): Promise<void> {
    const base = cleanBase(args[0]);
    if (!base || !this.venue.market(base)) { await this.say(chat, "Usage: <code>/close ETH</code> or <code>/close ETH 50%</code>"); return; }
    let fraction = 1;
    if (args[1]) {
      const pct = parseAmount(args[1].replace(/%$/, ""), 1, 100, 0);
      if (pct === undefined) { await this.say(chat, "Percent must be a whole number from 1 to 100."); return; }
      fraction = pct / 100;
    }
    await this.doClose(u, chat, base, fraction, "manual close");
  }

  private async doClose(u: User, chat: number, base: string, fraction: number, reason: string, opt: { limit?: number; expectSide?: Side; auto?: boolean; owner?: string; trigAt?: number; trigSrc?: "push" | "poll" } = {}): Promise<TradeResult> {
    const tk = this.tk(u);
    if (opt.owner && tk.owner.toLowerCase() !== opt.owner.toLowerCase()) {
      throw new UserError(`Your linked account changed, so the ${base}-PERP exit set on the old account was dropped. Nothing was sent.`);
    }
    const key = `${tk.owner.toLowerCase()}:${base}`;
    return this.posLock.run(key, async () => {
      if (!opt.auto) this.notStopping();
      await this.checkUnresolved(tk, base);
      await this.gasCheck(u);
      let sideChanged = false;
      let read: { abs: number; side: Side } | undefined;
      // Runs inside venue.close right after the fresh position read, before anything is sent.
      const guard = (abs: number, side: Side) => {
        read = { abs, side };
        if (opt.expectSide && side !== opt.expectSide) {
          sideChanged = true;
          throw new UserError(`Your ${base}-PERP position is now a ${side}, not the ${opt.expectSide} this exit was set for. Nothing was sent, and the old ${base} exits were cleared.`);
        }
        const rc = this.recentClose.get(key);
        if (rc && Date.now() - rc.at < 20_000 && abs >= rc.prevSize - 1e-12) {
          throw new UserError(rc.unknown
            ? `A close for ${base}-PERP may have gone through moments ago (not confirmed yet). Nothing was sent; check /positions in a few seconds.`
            : `A close for ${base}-PERP just went through and the chain read has not caught up yet. Nothing was sent; check /positions in a few seconds.`);
        }
      };
      let r: TradeResult;
      try {
        r = await (opt.auto ? this.autoTxs : this.txs).run(() => this.venue.close(tk, base, fraction, opt.limit, guard));
      } catch (e) {
        if (sideChanged) { delete u.rules[base]; this.store.save(); }
        if (e instanceof OutcomeUnknown) {
          // The close may have gone through: block re-tries on the same size for 20 s; the next try reads the chain afresh.
          this.recentClose.set(key, { prevSize: read?.abs ?? 0, at: Date.now(), unknown: true });
          this.markUnresolved(tk, base, e.hash);
          const side: Side = read?.side === "short" ? "long" : "short";
          this.record(u, tk.owner, "unknown", { base, side, hash: e.hash }, reason, { intent: "close" });
        }
        throw e;
      }
      if (r.filledBase > 0) this.recentClose.set(key, { prevSize: r.prevSize ?? Infinity, at: Date.now(), unknown: false });
      const trig = opt.trigAt !== undefined ? { trigAt: new Date(opt.trigAt).toISOString(), trigSrc: opt.trigSrc } : undefined;
      return this.afterClose(u, chat, base, reason, tk.owner, r, trig);
    });
  }

  private async afterClose(u: User, chat: number, base: string, reason: string, owner: `0x${string}`, r: TradeResult, extra?: Record<string, string | undefined>): Promise<TradeResult> {
    this.record(u, owner, "close", r, reason, extra);
    const left = await this.waitPosition(owner, base, (x) => r.filledBase === 0 || !x || x.size < (r.prevSize ?? Infinity) - 1e-12);
    // Relinked while this close was in flight: it was the old account's trade; the new account's records stay as they are.
    const same = u.owner?.toLowerCase() === owner.toLowerCase();
    if (same && r.filledBase > 0 && r.avgPrice && r.entry) {
      u.lastClosed = { base, side: r.side === "short" ? "long" : "short", entry: r.entry, exit: r.avgPrice, size: r.filledBase, pnl: r.realizedPnl ?? 0, at: Date.now(), reason, lev: u.opens[base]?.leverage, full: !left };
    }
    if (same && !left) { delete u.rules[base]; delete u.opens[base]; } // a later position (e.g. opened in the app) starts with no stale leverage
    this.store.save();
    await this.protector.refreshUser(u).catch(() => {});
    await this.say(chat,
      `<b>${h(reason[0]!.toUpperCase() + reason.slice(1))}</b>: ${r.filledBase > 0 ? `closed ${r.filledBase} ${base} @ ${r.avgPrice ? fmtPrice(r.avgPrice) : "?"}` : "nothing filled (book moved)"}\n` +
      `Tx ${txLink(r.hash)}\n` +
      (r.realizedPnl !== undefined && r.filledBase > 0 ? `Realised PnL ≈ ${fmtUsd(r.realizedPnl, true)} USDso (before fees)\n` : "") +
      (left ? `Remaining: ${left.side} ${left.size} ${base}` : "Position closed."),
      same && r.filledBase > 0 ? [[{ text: "PnL card", callback_data: `cd:${base}` }]] : undefined);
    return r;
  }

  private async autoClose(u: User, base: string, fraction: number, reason: string, opt: { kind: "tp" | "sl" | "guard"; limit?: number; side: Side; owner?: string; at?: number; source?: "push" | "poll" }): Promise<void> {
    log("auto-close", base, opt.kind, reason, opt.source ?? "");
    const chat = u.rules[base]?.quiet ? 0 : u.id; // a scheduled demo trade's exit is logged, not messaged
    try {
      await this.doClose(u, chat, base, fraction, reason, { limit: opt.limit, expectSide: opt.side, auto: true, owner: opt.owner, trigAt: opt.at, trigSrc: opt.source });
    } catch (e) {
      const msg = e instanceof UserError ? e.message : "chain error";
      log("auto-close failed", base, opt.kind, String(e instanceof Error ? e.message : e).slice(0, 200));
      const key = `${u.id}:${base}:${opt.kind}`;
      if (e instanceof OutcomeUnknown) {
        if (this.buckets.allow(`autofail:${key}`, 1, 5 * 60_000)) {
          await this.say(u.id, `⚠️ ${h(reason)}: the close order for ${base}-PERP ${e.hash ? `was sent (tx ${txLink(e.hash)})` : "may have reached the chain"} but its result is not confirmed yet. I re-read the position from the chain before any new attempt. Check /positions.`);
        }
        throw e;
      }
      // A take-profit whose limit the book does not reach yet is not an error: retry quietly on the next pushes.
      const quiet = opt.kind === "tp" && /nothing would fill|thin/i.test(msg);
      if (!quiet && this.buckets.allow(`autofail:${key}`, 1, 5 * 60_000)) {
        await this.say(u.id, `⚠️ ${h(reason)}, but closing ${base}-PERP failed: ${h(msg)} I keep retrying while the level holds. You can also /close ${base}.`);
      }
      throw e;
    }
  }

  private async liqWarn(u: User, base: string, text: string): Promise<void> {
    if (!u.owner) return;
    await this.say(u.id, `⚠️ <b>Liquidation risk</b>\n${h(text)}`, [[{ text: "Close 50%", callback_data: closeData(u.owner, base, 50) }, { text: "Close all", callback_data: closeData(u.owner, base, 100) }]]);
  }

  /** Order log row: public on-chain facts plus public extras (`via`, `card`, `intent`). No Telegram ids. `account`: the account the order was sent for. */
  private record(u: User, account: string, kind: string, r: Partial<TradeResult> & { base: string; side: Side }, reason?: string, extra?: Record<string, string | undefined>): void {
    u.stats.orders++;
    this.store.logOrder({ kind, reason, market: `${r.base}-PERP`, side: r.side, hash: r.hash, filled: r.filledBase, requested: r.requestedBase, avgPrice: r.avgPrice === undefined ? undefined : Number(r.avgPrice.toPrecision(10)), key: u.keyAddress, account, ...extra });
  }

  private async cmdPositions(u: User, chat: number): Promise<void> {
    const { owner } = this.requireLinked(u);
    const acct = await this.venue.account(owner);
    if (!acct.positions.length) { await this.say(chat, `No open positions. Equity ${fmtUsd(acct.equity)} USDso. Try <code>/long ETH 20 5x</code>.`); return; }
    const sr = await this.stopReports(owner, { view: acct, withLogs: true }).catch(() => undefined);
    const chainLine = (base: string) => {
      if (!sr) return "chain-held TP/SL: could not be read right now (/stops)";
      const r = sr.reports.find((x) => x.base === base);
      const ls = (r?.lines ?? []).filter((l) => l.kind !== "stop");
      if (!ls.length) return "chain-held TP/SL: none (only the bot-side exits below)";
      return `chain-held: ${ls.map((l) => `${l.kind} ${fmtPrice(l.stop.trigger)} ${this.stopIcon(l.level)}`).join(" · ")}${ls.some((l) => l.level === "warn") ? " (see /stops)" : ""}`;
    };
    const lines = acct.positions.map((p) => {
      const d = liqDistancePct(p.side, p.mark, p.liq);
      const r = u.rules[p.base];
      const roe = u.opens[p.base] ? ((p.mark - p.entry) / p.entry) * (p.side === "long" ? 1 : -1) * u.opens[p.base]!.leverage * 100 : undefined;
      return `<b>${p.base}-PERP ${p.side}</b> ${p.size} (${fmtUsd(p.notional)} USDso)\n` +
        `entry ${fmtPrice(p.entry)} · mark ${fmtPrice(p.mark)}\n` +
        `PnL <b>${fmtUsd(p.upnl, true)}</b> USDso${roe !== undefined ? ` (${roe >= 0 ? "+" : ""}${roe.toFixed(2)}% on margin)` : ""}\n` +
        `liquidation ${p.liq ? `${fmtPrice(p.liq)} (${d!.toFixed(1)}% away)` : p.side === "long" ? "none above 0 (your margin covers this long)" : "n/a"}` +
        `\n${chainLine(p.base)}` +
        (r ? `\nbot-side: ${r.tp ? `TP ${fmtPrice(r.tp)} ` : ""}${r.sl ? `SL ${fmtPrice(r.sl)}` : ""}` : "");
    });
    const buttons = acct.positions.slice(0, 6).map((p) => [{ text: `Close ${p.base}`, callback_data: closeData(owner, p.base, 100) }, { text: `Card ${p.base}`, callback_data: `cd:${p.base}` }]);
    await this.say(chat, `${lines.join("\n\n")}\n\nEquity ${fmtUsd(acct.equity)} USDso · margin status ${h(acct.status)}`, buttons);
  }

  // ---------- scheduled demo trades (fresh on-chain evidence, no chat messages) ----------
  private schedFile(): string { return `${PATHS.data}/demo_schedule.json`; }
  private loadSched(): { lastSlot?: string; runs?: number } {
    try { const j = JSON.parse(readFileSync(this.schedFile(), "utf8")) as { lastSlot?: unknown; runs?: unknown }; return { lastSlot: typeof j.lastSlot === "string" ? j.lastSlot : undefined, runs: Number.isInteger(j.runs) ? (j.runs as number) : 0 }; } catch { return { runs: 0 }; }
  }

  /** Once per slot: one capped order on the demo account with a bot-side TP/SL; flattened after maxHoldMs. Returns what it did. */
  async demoScheduleTick(now = Date.now()): Promise<string> {
    const S = DEMO_SCHEDULE;
    if (this.stopping || now >= S.until || existsSync(`${PATHS.data}/demo_schedule.off`)) return "off";
    const d = new Date(now);
    if (!S.hoursUtc.includes(d.getUTCHours()) || d.getUTCMinutes() < S.minute) return "idle";
    const slot = d.toISOString().slice(0, 13);
    const st = this.loadSched();
    if (st.lastSlot === slot) return "done";
    const runs = (st.runs ?? 0) + 1;
    writeFileSync(this.schedFile(), JSON.stringify({ lastSlot: slot, runs }), { mode: 0o600 }); // first: a crash never repeats a slot
    const demo = this.demoAccount.toLowerCase();
    const u = this.store.all().find((x) => x.owner?.toLowerCase() === demo && hasKey(x));
    if (!u) return "skip: no linked demo user";
    const base = S.markets[runs % S.markets.length]!;
    const side: Side = runs % 2 === 0 ? "long" : "short";
    if (!this.venue.market(base)) return `skip: no ${base} market`;
    const tk = this.tk(u);
    const p: OpenCmd = { kind: "open", side, base, margin: S.margin, leverage: S.leverage, tp: { pct: S.tpPct }, sl: { pct: S.slPct } };
    // The checks run inside the account+market lock, so a live trial opened meanwhile is never added to.
    const r = await this.posLock.run(`${tk.owner.toLowerCase()}:${base}`, async () => {
      const acct = await this.venue.account(u.owner!);
      if (acct.positions.length) return `skip: the demo account holds ${acct.positions.map((x) => x.base).join(", ")}`;
      if (acct.equity < S.minEquity) return `skip: equity ${acct.equity.toFixed(2)} below ${S.minEquity}`;
      return this.openLocked(u, 0, side, p, tk, { via: "schedule", quiet: true });
    });
    if (typeof r === "string") return r;
    if (!r || r.filledBase === 0) return `skip: nothing filled on ${base}`;
    setTimeout(() => void this.scheduledFlatten(u, base, side).catch((e) => log("scheduled flatten failed", base, String(e).slice(0, 160))), S.maxHoldMs).unref();
    return `opened ${side} ${base} ${r.filledBase} (tx ${r.hash})`;
  }

  /** The scheduled position is still open after maxHoldMs (neither TP nor SL fired): close it at market, quietly. */
  async scheduledFlatten(u: User, base: string, side: Side): Promise<void> {
    if (u.owner?.toLowerCase() !== this.demoAccount.toLowerCase()) return;
    const pos = (await this.venue.account(u.owner)).positions.find((x) => x.base === base);
    if (!pos || pos.side !== side) return;
    await this.doClose(u, 0, base, 1, `scheduled flatten after ${Math.round(DEMO_SCHEDULE.maxHoldMs / 60_000)} min`, { expectSide: side, auto: true });
    log("demo schedule: flattened", base);
  }

  // ---------- /try: one real order on the bot's sandbox account, no wallet (off unless data/try.on) ----------
  private tryEnabled(): boolean { return existsSync(`${PATHS.data}/try.on`) && !existsSync(`${PATHS.data}/try.off`); }

  private async cmdTry(chat: number): Promise<void> {
    if (!this.tryEnabled()) { await this.say(chat, "Live trials are off right now. /demo shows the bot's live account and its orders, no wallet needed."); return; }
    await this.say(chat,
      `<b>Try a real order, no wallet</b>\nThe bot opens a small position on its own testnet sandbox account (not yours; nothing to link): ${fmtUsd(TRY.margin * TRY.leverage)} USDso at ${TRY.leverage}x, ` +
      `closed at ±${TRY.tpPct}% or after ${Math.round(TRY.maxHoldMs / 60_000)} minutes. You get the transaction link. ${TRY.perUserPerDay} trials a day per person.`,
      TRY.markets.map((b) => [{ text: `Long ${b}`, callback_data: `ty:${b}:l` }, { text: `Short ${b}`, callback_data: `ty:${b}:s` }]));
  }

  /** One trial order. Every check happens again inside the account+market lock, right before the send. */
  private async tryOrder(id: number, chat: number, base: string, side: Side): Promise<void> {
    if (!this.tryEnabled()) { await this.say(chat, "Live trials are off right now. /demo shows the bot's live account."); return; }
    this.notStopping();
    let refused: string | undefined;
    try { refused = this.tryCaps.refusal(id); } catch (e) {
      log("trial caps unreadable:", String(e).slice(0, 120));
      await this.say(chat, "Live trials are not available right now."); return; // fail closed
    }
    if (refused) { await this.say(chat, h(refused)); return; }
    const demo = this.demoAccount.toLowerCase();
    const u = this.store.all().find((x) => x.owner?.toLowerCase() === demo && hasKey(x));
    if (!u || !this.venue.market(base) || !(TRY.markets as readonly string[]).includes(base)) { await this.say(chat, "Live trials are not available right now."); return; }
    const tk = this.tk(u);
    const r = await this.posLock.run(`${tk.owner.toLowerCase()}:${base}`, async () => {
      const acct = await this.venue.account(tk.owner);
      if (acct.positions.some((p) => p.base === base)) throw new UserError(`The sandbox already holds a ${base}-PERP trial. Pick another market or try again in a few minutes.`);
      if (acct.positions.length >= TRY.maxOpen) throw new UserError("The sandbox is busy with other trials. Try again in a few minutes, or look at /demo.");
      if (acct.equity < TRY.minEquity) throw new UserError("The sandbox account is resting (low balance). /demo shows its orders.");
      if ((await this.venue.gasBalance(u.keyAddress!)) < TRY.minGasStt) throw new UserError("The sandbox is resting (low gas). /demo shows its orders.");
      this.tryCaps.take(id); // counted before the send: a failed send still uses the trial (no retry loops)
      log("trial", base, side);
      const p: OpenCmd = { kind: "open", side, base, margin: TRY.margin, leverage: TRY.leverage, tp: { pct: TRY.tpPct }, sl: { pct: TRY.slPct } };
      return this.openLocked(u, 0, side, p, tk, { via: "try", quiet: true, maxTouchPct: TRY.maxTouchPct });
    });
    if (!r || r.filledBase === 0) { await this.say(chat, `Nothing filled (the book moved)${r ? `: tx ${txLink(r.hash)}` : ""}. No position was opened.`); return; }
    const at = Date.now();
    await this.say(chat,
      `<b>Filled</b> ${side} ${r.filledBase} ${base} @ ${r.avgPrice ? fmtPrice(r.avgPrice) : "?"} on the sandbox account ${addrLink(tk.owner)}\nTx ${txLink(r.hash)}\n` +
      `It closes by itself at ±${TRY.tpPct}% or within ${Math.round(TRY.maxHoldMs / 60_000)} minutes; I tell you how it ended. To trade your own account: /start.`,
      [[{ text: "Start trading", callback_data: "st" }]]);
    setTimeout(() => void this.tryEnded(u, chat, base, side, at).catch((e) => log("trial end failed", base, String(e).slice(0, 160))), TRY.maxHoldMs).unref();
  }

  /** maxHoldMs after a trial: close it if no exit fired, then tell the trier how it ended (from the order log). */
  private async tryEnded(u: User, chat: number, base: string, side: Side, at: number): Promise<void> {
    if (u.owner?.toLowerCase() === this.demoAccount.toLowerCase()) {
      const pos = (await this.venue.account(u.owner)).positions.find((x) => x.base === base);
      if (pos && pos.side === side) await this.doClose(u, 0, base, 1, `trial closed after ${Math.round(TRY.maxHoldMs / 60_000)} min`, { expectSide: side, auto: true }).catch(() => undefined);
    }
    const close = this.store.recentOrders(this.demoAccount, 20).find((x) => x.kind === "close" && x.market === `${base}-PERP` && Date.parse(x.t) >= at);
    await this.say(chat, close
      ? `Your ${base}-PERP trial is closed${close.avgPrice !== undefined ? ` @ ${fmtPrice(close.avgPrice)}` : ""}${autoKind(close.reason) ? ` by its ${autoKind(close.reason)}` : ""}. Tx ${txLink(close.hash)}`
      : `Your ${base}-PERP trial: I could not confirm the close yet. /demo shows the sandbox account.`);
  }

  // ---------- /stops: dreamDEX's chain-held TP/SL, mirrored and checked ----------
  /**
   * stopReportsUncached with a 15 s cache per account. `withLogs`: also use stop ids found in the registries' logs
   * (collected only for linked accounts, and shown only to that account's own user, so /stops 0xOther cannot tell
   * whether an account uses this bot).
   */
  private async stopReports(owner: `0x${string}`, o: { view?: AccountView; fresh?: boolean; withLogs: boolean }): Promise<{ view: AccountView; reports: PositionReport[]; stops: NativeStop[] }> {
    const k = `${owner.toLowerCase()}:${o.withLogs ? 1 : 0}`;
    const c = this.stopCache.get(k);
    if (!o.fresh && !o.view && c && Date.now() - c.at < LIMITS.stopCacheMs) return c.v;
    const v = await this.stopReportsUncached(owner, o.view, o.withLogs ? this.recentRefs(owner) : []);
    if (this.stopCache.size >= 500) this.stopCache.clear();
    this.stopCache.set(k, { at: Date.now(), v });
    return v;
  }

  /** Native stops and the pool's closing capacity for every market with a position or a pending stop. */
  private async stopReportsUncached(owner: `0x${string}`, view: AccountView | undefined, refs: { registry: `0x${string}`; orderId: string }[]): Promise<{ view: AccountView; reports: PositionReport[]; stops: NativeStop[] }> {
    const [v, stops] = await Promise.all([view ? Promise.resolve(view) : this.venue.account(owner), this.venue.nativeStops(owner, refs)]);
    const bases = [...new Set([...v.positions.map((p) => p.base), ...stops.map((x) => x.base)])].filter((b) => this.venue.market(b));
    const reports = await Promise.all(bases.map(async (b) => {
      const m = this.venue.market(b)!;
      const pos = v.positions.find((p) => p.base === b);
      const mine = stops.filter((x) => x.base === b);
      const cap = mine.length ? await this.venue.reducingCapacity(owner, m).catch(() => undefined) : undefined;
      const r = checkMarket(b, pos && { base: b, side: pos.side, size: pos.size, mark: pos.mark }, mine, cap, this.venue.minQty(m));
      if (mine.length && !cap) r.notes.push("The pool's closing capacity could not be read right now, so the resting-order check was skipped");
      return r;
    }));
    return { view: v, reports, stops };
  }

  private recentRefs(owner: string): { registry: `0x${string}`; orderId: string }[] {
    const m = this.stopLogs.get(owner.toLowerCase());
    if (!m) return [];
    for (const [k, v] of m) if (Date.now() - v.at > 15 * 60_000) m.delete(k);
    return [...m.values()].map((v) => v.ref);
  }

  private addRecent(owner: string, refs: { registry: `0x${string}`; orderId: string }[]): void {
    const key = owner.toLowerCase();
    let m = this.stopLogs.get(key);
    if (!m) { if (this.stopLogs.size >= LIMITS.stopCheckUsersMax * 2) this.stopLogs.clear(); this.stopLogs.set(key, (m = new Map())); }
    for (const ref of refs.slice(0, 50)) if (!m.has(`${ref.registry}_${ref.orderId}`)) m.set(`${ref.registry}_${ref.orderId}`, { ref, at: Date.now() });
  }

  private stopIcon(level: string): string { return level === "ok" ? "✅" : level === "warn" ? "⚠️" : "ℹ️"; }

  private async cmdStops(id: number, chat: number, arg?: string): Promise<void> {
    const u = this.store.get(id);
    let target: `0x${string}` | undefined;
    if (arg) {
      if (!isAddress(arg) || BigInt(arg) === 0n) { await this.say(chat, "Send <code>/stops</code> for your linked account or <code>/stops 0xAccount</code> for any dreamDEX account (read only)."); return; }
      target = getAddress(arg);
    } else if (u?.owner) target = u.owner;
    if (!target) { await this.say(chat, "<code>/stops 0xAccount</code> shows the dreamDEX TP/SL the chain holds for an account and checks that each one will close what you expect. Read only. Linked users can send just /stops."); return; }
    const mine = u?.owner?.toLowerCase() === target.toLowerCase() ? u : undefined;
    // Everyone has a per-user limit; checking another account also counts against a global one (your own never waits on others).
    if (!this.buckets.allow(`stops:${id}`, LIMITS.stopsPerMinute, 60_000) || (!mine && !this.buckets.allow("stops:all", LIMITS.stopsGlobalPerMinute, 60_000))) { await this.say(chat, "One moment: /stops works a few times a minute."); return; }
    const [{ reports }, lag] = await Promise.all([this.stopReports(target, { withLogs: !!mine }), this.venue.indexerLagS().catch(() => undefined)]);
    const lagNote = lag !== undefined && lag > 30
      ? `\nℹ️ The dreamDEX indexer is ${Math.round(lag)} s behind the chain right now, so a stop armed in that window may show up only once it catches up${mine ? " (for your linked account the bot also reads the registries' own logs every minute)" : ""}.`
      : "";
    const parts = reports.map((r) => {
      const head = r.pos ? `<b>${r.base}-PERP ${r.pos.side} ${r.pos.size}</b> · mark ${fmtPrice(r.pos.mark)}` : `<b>${r.base}-PERP</b> (no position)`;
      const shown = [...r.lines].sort((a, b) => (a.level === "warn" ? 0 : 1) - (b.level === "warn" ? 0 : 1)).slice(0, LIMITS.stopLinesPerMarket);
      const lines = shown.map((l) => `${this.stopIcon(l.level)} ${h(l.text)}`);
      if (r.lines.length > shown.length) lines.push(`… and ${r.lines.length - shown.length} more stop${r.lines.length - shown.length === 1 ? "" : "s"} on ${r.base}-PERP`);
      const notes = r.notes.map((n) => `ℹ️ ${h(n)}`);
      const rule = mine?.rules[r.base];
      const levels = rule ? [rule.tp ? `TP ${fmtPrice(rule.tp)}` : "", rule.sl ? `SL ${fmtPrice(rule.sl)}` : ""].filter(Boolean).join(" · ") : "";
      const bot = levels ? [`Bot-side layer: ${levels} (this bot closes the position when the pushed mark crosses)`] : [];
      return [head, ...lines, ...notes, ...bot].join("\n");
    });
    const warns = reports.reduce((n, r) => n + r.lines.filter((l) => l.level === "warn").length, 0);
    const count = reports.reduce((n, r) => n + r.lines.length, 0);
    // Stay well under Telegram's 4,096 characters: whole markets only (a cut never lands inside a tag).
    const kept: string[] = [];
    let size = 0;
    for (const p of parts) { if (size + p.length > LIMITS.stopsMsgBudget) break; kept.push(p); size += p.length + 2; }
    if (kept.length < parts.length) kept.push(`… and ${parts.length - kept.length} more market${parts.length - kept.length === 1 ? "" : "s"} (the dreamDEX app lists them all).`);
    await this.say(chat,
      `<b>Chain-held stops</b> for ${addrLink(target)}\n` +
      `dreamDEX TP/SL live in each market's stop registry on chain. The chain checks them and fires them itself, even when no bot is running. This bot reads them and checks that each one will close what you expect.\n\n` +
      (kept.length ? kept.join("\n\n") : "No open positions and no pending chain-held stops.") +
      `\n\n${count} chain-held stop${count === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"} · checked ${new Date().toISOString().slice(11, 19)} UTC. Arm or cancel stops in the <a href="${APP_URL}">dreamDEX app</a>.` + lagNote);
  }

  /** Every minute: warn linked users (once a day per stop and problem) when a chain-held stop will not close what they expect, and tell them when one fired or was dropped. */
  async stopHealthRound(): Promise<void> {
    if (this.stopChecking || this.stopping) return;
    this.stopChecking = true;
    try {
      const now = Date.now();
      const all = this.store.all().filter((x) => x.owner && !x.blockedAt);
      // More linked users than one pass takes: rotate, so everyone is checked every few passes.
      if (this.stopCursor >= all.length) this.stopCursor = 0;
      const users = [...all.slice(this.stopCursor), ...all.slice(0, this.stopCursor)].slice(0, LIMITS.stopCheckUsersMax);
      this.stopCursor += users.length;
      // ONE getLogs for every account in this pass: stops armed while the indexer lags.
      const found = await this.venue.recentStopIds(users.map((x) => x.owner!)).catch(() => undefined);
      for (const [o, refs] of found ?? []) this.addRecent(o, refs);
      for (const u of users) {
        const owner = u.owner!;
        let r: Awaited<ReturnType<Bot["stopReports"]>>;
        try { r = await this.stopReports(owner, { fresh: true, withLogs: true }); } catch { continue; }
        if (u.owner !== owner) continue; // relinked while reading
        const warned = u.stopWarned ?? {};
        const before = JSON.stringify(warned);
        for (const k of Object.keys(warned)) if (now - warned[k]! > LIMITS.stopWarnRepeatMs) delete warned[k];
        for (const rep of r.reports) {
          const fresh = rep.lines.filter((l) => l.level === "warn" && !warned[warnKey(l)]);
          if (!fresh.length) continue;
          // One message per market; marked as sent only once Telegram accepted it (a failed send is retried next pass).
          const shown = fresh.slice(0, LIMITS.stopLinesPerMarket);
          const more = fresh.length - shown.length;
          const ok = await this.say(u.id, `⚠️ <b>Stop health</b> · ${rep.base}-PERP\n${shown.map((l) => `${h(l.text)}.`).join("\n")}${more ? `\n… and ${more} more: /stops` : ""}`, [[{ text: "Show my stops", callback_data: "sk" }]]);
          if (ok) for (const l of fresh) warned[warnKey(l)] = now;
        }
        const keys = Object.keys(warned);
        if (keys.length > LIMITS.stopWarnedMax) for (const k of keys.sort((a, b) => warned[a]! - warned[b]!).slice(0, keys.length - LIMITS.stopWarnedMax)) delete warned[k];
        if (JSON.stringify(warned) !== before || !u.stopWarned) { u.stopWarned = warned; this.store.save(); }
        // Reduce-only stops that left PENDING since the last pass on THIS account: fired, dropped or cancelled.
        const seenKey = `${u.id}:${owner.toLowerCase()}`;
        for (const k of [...this.stopSeen.keys()]) if (k.startsWith(`${u.id}:`) && k !== seenKey) this.stopSeen.delete(k); // relinked: old account's stops are not news
        const prev = this.stopSeen.get(seenKey);
        const cur = new Map(r.stops.filter((x) => x.reduceOnly).map((x) => [x.id, { base: x.base, kind: x.isBid ? (x.op === 1 ? "TP" : "SL") : (x.op === 0 ? "TP" : "SL"), trigger: x.trigger }]));
        this.stopSeen.set(seenKey, cur);
        if (!prev) continue;
        const gone = [...prev].filter(([id]) => !cur.has(id));
        if (gone.length) await this.stopsEnded(u, owner, gone).catch((e) => log("stop end lookup failed", String(e).slice(0, 120)));
      }
      if (this.stopSeen.size > 4 * LIMITS.stopCheckUsersMax) this.stopSeen.clear();
    } finally { this.stopChecking = false; }
  }

  private static DROP_TEXT: Record<string, string> = {
    ReduceOnlyNoPosition: "there was no position left to close",
    ReduceOnlyWrongSide: "the position was on the other side by then",
    ReduceOnlyBelowMinQty: "what it could close was below the minimum order size (resting orders on the closing side can use up the position's closing capacity)",
    PlacementFailed: "the market rejected its order",
    NoFill: "its order found nothing to fill against",
  };

  private async stopsEnded(u: User, owner: `0x${string}`, gone: [string, { base: string; kind: string; trigger: number }][]): Promise<void> {
    const rows = await this.venue.exchange.client.listPerpStopOrders({ account: owner.toLowerCase(), status: ["TRIGGERED", "TRIGGER_FAILED", "CANCELLED"], limit: 30 });
    for (const [id, info] of gone.slice(0, 5)) {
      const r = rows.find((x) => `${String(x.registry).toLowerCase()}_${x.orderIdRaw}` === id);
      const what = `chain-held ${info.kind} ${fmtPrice(info.trigger)} on ${info.base}-PERP`;
      if (!r) continue; // not indexed yet, or cancelled by the owner long ago: nothing to say
      if (r.status === "TRIGGERED") await this.say(u.id, `✅ Your ${what} fired: the chain placed its closing order by itself. /positions shows what is left.`);
      else if (r.status === "TRIGGER_FAILED") {
        const why = Object.hasOwn(Bot.DROP_TEXT, String(r.dropReason)) ? Bot.DROP_TEXT[String(r.dropReason)]! : "it was dropped";
        await this.say(u.id, `⚠️ Your ${what} fired but placed nothing: ${why}. Its fee is spent. Check /stops.`);
      } else if (r.status === "CANCELLED" && r.cancelReason === "LinkedFill") {
        await this.say(u.id, `Your ${what} was cancelled because its linked partner filled. If that fill was only partial, the rest of the position has no chain-held stop now: /stops.`);
      }
    }
  }

  private async cmdRule(u: User, chat: number, kind: "tp" | "sl", args: string[]): Promise<void> {
    const { owner } = this.requireLinked(u);
    const base = cleanBase(args[0]);
    if (!base || !this.venue.market(base)) { await this.say(chat, `Usage: <code>/${kind} ETH 2500</code>, <code>/${kind} ETH ${kind === "tp" ? "4" : "2"}%</code> or <code>/${kind} ETH off</code>`); return; }
    const pos = (await this.venue.account(owner)).positions.find((p) => p.base === base);
    if (!pos) { await this.say(chat, `No open ${base}-PERP position to protect.`); return; }
    const r = u.rules[base] ?? { side: pos.side, setAt: Date.now() };
    if (args[1]?.toLowerCase() === "off") {
      delete r[kind];
    } else {
      const lv = parseLevel(args[1]);
      if (!lv) { await this.say(chat, "Give a price (2500) or a percent from entry (4%)."); return; }
      const v = resolveLevel(kind, pos.side, lv, lv.pct !== undefined ? pos.entry : pos.mark);
      if (typeof v === "string") { await this.say(chat, h(v)); return; }
      const bad = checkVsMark(kind, pos.side, v, pos.mark);
      if (bad) { await this.say(chat, h(bad)); return; }
      r[kind] = v;
    }
    r.side = pos.side; r.setAt = Date.now(); delete r.quiet; // a level the user sets is always reported
    if (r.tp || r.sl) u.rules[base] = r; else delete u.rules[base];
    this.store.save();
    await this.protector.refreshUser(u).catch(() => {});
    await this.say(chat, `${base}-PERP ${pos.side}: ${r.tp ? `take-profit ${fmtPrice(r.tp)}` : "no take-profit"}, ${r.sl ? `stop-loss ${fmtPrice(r.sl)}` : "no stop-loss"}. Mark now ${fmtPrice(pos.mark)}. Watched live through Somnia Reactivity; I close the position when a level is reached.`);
  }

  private async cmdAlerts(u: User, chat: number, arg?: string): Promise<void> {
    const v = parseAmount(arg, 1, 50, 1);
    if (v === undefined) { await this.say(chat, `Liquidation warning is at ${u.liqWarnPct}%. Change it with <code>/alerts 10</code> (1-50).`); return; }
    u.liqWarnPct = v; this.store.save();
    await this.say(chat, `I will warn you when the mark is within ${v}% of the liquidation price (your positions and the accounts you /watch).`);
  }

  private async cmdGuard(u: User, chat: number, arg?: string): Promise<void> {
    if (arg?.toLowerCase() === "off") { delete u.guardPct; this.store.save(); await this.say(chat, "Guard off: I will only warn, not close."); return; }
    const v = parseAmount(arg, 0.5, 20, 1);
    if (v === undefined) { await this.say(chat, `Guard is ${u.guardPct ? `on at ${u.guardPct}%` : "off"}. <code>/guard 3</code> closes a position when the mark gets within 3% of its liquidation price (0.5-20), <code>/guard off</code> stops it.`); return; }
    u.guardPct = v; if (u.liqWarnPct <= v) u.liqWarnPct = Math.min(50, v * 2); this.store.save();
    await this.say(chat, `Guard on: I close a position when the mark gets within ${v}% of its liquidation price (warning at ${u.liqWarnPct}%).`);
  }

  // ---------- cards and the copy loop ----------
  private async cmdCard(u: User, chat: number, arg?: string): Promise<void> {
    if (!this.buckets.allow(`card:${u.id}`, LIMITS.cardsPerMinute, 60_000)) { await this.say(chat, "One moment: card limit reached, try again in a minute."); return; }
    const want = cleanBase(arg);
    const acct = u.owner ? await this.venue.account(u.owner) : undefined;
    const p = acct?.positions.find((x) => !want || x.base === want);
    let rec: CardRec;
    // The same trade keeps its card (refreshed), so a link that was already forwarded keeps working.
    if (p) {
      rec = this.store.upsertCard({ by: u.id, base: p.base, side: p.side, lev: u.opens[p.base]?.leverage, entry: p.entry, price: p.mark, pnl: p.upnl, open: true, at: Date.now() });
    } else if (u.lastClosed && (!want || u.lastClosed.base === want)) {
      const c = u.lastClosed;
      rec = this.store.upsertCard({ by: u.id, base: c.base, side: c.side, lev: c.lev ?? u.opens[c.base]?.leverage, entry: c.entry, price: c.exit, pnl: c.pnl, open: false, at: Date.now(), tradeAt: c.at });
    } else {
      await this.say(chat, "No position or recent close to put on a card yet.");
      return;
    }
    u.stats.cards++; this.store.save();
    await this.sendCard(chat, rec);
  }

  /** The card image with its Copy this trade deep link (also printed on the image and in the caption). */
  private async sendCard(chat: number, rec: CardRec, intro?: string): Promise<void> {
    const png = await renderCard({
      base: rec.base, side: rec.side, leverage: rec.lev, entry: rec.entry, price: rec.price, pnl: rec.pnl, open: rec.open,
      spark: this.protector.sparkFor(rec.base), botUsername: this.me, start: `c_${rec.id}`, when: new Date(rec.tradeAt ?? rec.at),
    });
    const caption = rec.open
      ? `${rec.base}-PERP ${rec.side}${rec.lev ? ` ${rec.lev}x` : ""}: ${fmtUsd(rec.pnl, true)} USDso open PnL on dreamDEX (${CHAIN_NAME}).`
      : `${rec.base}-PERP ${rec.side}${rec.lev ? ` ${rec.lev}x` : ""} closed: ${fmtUsd(rec.pnl, true)} USDso on dreamDEX (${CHAIN_NAME}).`;
    const link = `https://t.me/${this.me}?start=c_${rec.id}`;
    await this.tg.sendPhoto(chat, png,
      `${intro ? `${h(intro)}\n` : ""}${h(caption)}\nCopy this trade: ${link}\nForward this card. Friends tap Copy this trade to open the same trade on their own account.`,
      [[{ text: "Copy this trade", url: link }]]);
  }

  /** Leverage for a copy: the card's (3x when it has none), at most the market maximum and `cardCopyMaxLev`. */
  private copyLeverage(card: CardRec): { lev: number; note?: string } {
    const cap = Math.max(1, Math.min(this.venue.maxLeverage(card.base) ?? 1, LIMITS.cardCopyMaxLev));
    const want = card.lev ?? 3;
    const lev = Math.min(Math.max(want, 1), cap);
    if (card.lev === undefined) return { lev, note: `The card shows no leverage: using ${lev}x.` };
    if (lev < want) return { lev, note: `Leverage capped at ${lev}x (the card used ${want}x; copies use at most ${cap}x on ${card.base}-PERP).` };
    return { lev };
  }

  /** What a tapped card shows. Never the sharer's account or Telegram identity. */
  private async cardLanding(u: User, chat: number, card: CardRec): Promise<void> {
    const own = card.by === u.id;
    const m = this.venue.market(card.base);
    const mark = m ? await this.venue.mark(m).catch(() => undefined) : undefined;
    const sharer = this.store.get(card.by);
    const lc = sharer?.lastClosed;
    const closedSince = card.open && !!lc && lc.full !== false && lc.base === card.base && lc.at > card.at; // a partial close is not "closed"
    const lines = [
      own ? "<b>Your card: open it again</b>" : "<b>Shared trade</b>",
      `${card.base}-PERP ${card.side}${card.lev ? ` ${card.lev}x` : ""} · entry ${fmtPrice(card.entry)} → ${card.open ? "mark" : "exit"} ${fmtPrice(card.price)} · ${fmtUsd(card.pnl, true)} USDso`,
    ];
    if (mark) {
      const mv = ((mark - card.entry) / card.entry) * 100;
      lines.push(`Mark now ${fmtPrice(mark)} (${mv >= 0 ? "+" : ""}${mv.toFixed(2)}% since entry)`);
    }
    if (!card.open || closedSince) lines.push(own ? "You have closed it." : "The sharer has closed it.");
    if (!m) { lines.push(`${card.base}-PERP is not available right now.`); await this.say(chat, lines.join("\n")); return; }
    if (!u.owner) {
      lines.push("", "To copy it, link your bot key first (steps below). I show this trade again as soon as you are linked.");
      await this.say(chat, lines.join("\n"));
      return;
    }
    // Only the margin buttons copy: they carry the copy limits and counts (a plain /long would not).
    lines.push("", "Copy it on your own account (a one-time order): pick a margin.");
    await this.say(chat, lines.join("\n"), [LIMITS.cardMargins.map((v) => ({ text: `${v} USDso`, callback_data: `cm:${card.id}:${v}` }))]);
  }

  /** `cm:` shows a preview and stores a single-use draft. It sends nothing, so replaying an old button is harmless. */
  private async copyPreview(u: User, chat: number, cardId: string, margin: number): Promise<void> {
    const card = this.store.card(cardId);
    if (!card) { await this.say(chat, "That shared trade has expired. Ask for a fresh card."); return; }
    const { owner } = this.requireLinked(u);
    const m = this.venue.market(card.base);
    if (!m) { await this.say(chat, `${card.base}-PERP is not available right now.`); return; }
    const { lev, note } = this.copyLeverage(card);
    const notional = margin * lev;
    const minN = this.venue.minNotional(card.base);
    if (minN && notional < minN * 1.02) throw new UserError(`Too small: the minimum ${card.base}-PERP order is about ${(minN * 1.02).toFixed(2)} USDso notional. Pick a larger size.`);
    const mark = await this.venue.mark(m);
    if (!mark) throw new UserError(`${card.base}-PERP has no fresh mark price right now. Nothing was sent.`);
    const existing = (await this.venue.account(owner)).positions.find((x) => x.base === card.base);
    if (existing && existing.side !== card.side) throw new UserError(`You hold a ${existing.side} on ${card.base}-PERP. Close it first with /close ${card.base} (a copy never flips a position).`);
    const now = Date.now();
    for (const [k, d] of this.drafts) if (d.exp <= now) this.drafts.delete(k);
    // A user's own older previews make way first, so one user can never push out other users' drafts.
    const mine = [...this.drafts].filter(([, d]) => d.uid === u.id).map(([k]) => k);
    for (const k of mine.slice(0, Math.max(0, mine.length - (LIMITS.draftsPerUser - 1)))) this.drafts.delete(k);
    while (this.drafts.size >= LIMITS.draftsMax) this.drafts.delete(this.drafts.keys().next().value!);
    let nonce = randomBytes(6).toString("hex");
    while (this.drafts.has(nonce)) nonce = randomBytes(6).toString("hex");
    this.drafts.set(nonce, { uid: u.id, owner: owner.toLowerCase(), card: card.id, base: card.base, side: card.side, margin, lev, exp: now + LIMITS.draftTtlMs });
    const oldSl = existing && u.rules[card.base]?.side === existing.side ? u.rules[card.base]?.sl : undefined;
    const pct = LIMITS.cardCopyMaxTouchPct;
    await this.say(chat,
      `<b>Copy preview</b>\nOpen ${card.side} ${card.base} ${fmtUsd(margin)} x ${lev}x = ${fmtUsd(notional)} USDso at market (mark ${fmtPrice(mark)})${existing ? `; this adds to your ${card.base} ${existing.side}` : ""}.\n` +
      (note ? `${h(note)}\n` : "") +
      `One-time order on your account: I don't follow the sharer's exits. Set your own (Confirm + SL 3%, /tp, /close).\n` +
      (oldSl !== undefined ? `Confirm + SL 3% keeps your stop-loss ${fmtPrice(oldSl)} if it is tighter than 3% from the fill.\n` : "") +
      `Fills only within ${pct}% of the mark: refused if the book is more than ${pct}% from the mark. Confirm within ${Math.round(LIMITS.draftTtlMs / 60_000)} minutes; the button works once.`,
      [[{ text: "Confirm", callback_data: `cx:${nonce}:0` }], [{ text: "Confirm + SL 3%", callback_data: `cx:${nonce}:1` }]]);
  }

  /** `cx:` takes the draft out before anything else (no await in between), so one preview sends at most one order. */
  private async copyConfirm(u: User, chat: number, nonce: string, withSl: boolean): Promise<void> {
    const d = this.drafts.get(nonce);
    if (d && d.uid === u.id) this.drafts.delete(nonce);
    if (!d || d.uid !== u.id || Date.now() > d.exp) {
      await this.say(chat, "That confirmation has expired or was already used. Open the shared card again to copy it.");
      return;
    }
    this.tradeAllowed(u);
    const tk = this.tk(u);
    if (tk.owner.toLowerCase() !== d.owner) { await this.say(chat, "Your linked account changed since the preview. Open the shared card again."); return; }
    if (!this.venue.market(d.base)) { await this.say(chat, `${d.base}-PERP is not available right now.`); return; }
    const p: OpenCmd = { kind: "open", side: d.side, base: d.base, margin: d.margin, leverage: d.lev, sl: withSl ? { pct: 3 } : undefined };
    const r = await this.posLock.run(`${tk.owner.toLowerCase()}:${d.base}`, () =>
      this.openLocked(u, chat, d.side, p, tk, { maxTouchPct: LIMITS.cardCopyMaxTouchPct, via: "card", card: d.card }));
    if (r && r.filledBase > 0) {
      const card = this.store.card(d.card);
      if (card && card.by !== u.id) {
        card.copies++; this.store.save();
        await this.pingSharer(card, `🔁 Your ${card.base} ${card.side} card was copied (${fmtUsd(d.margin)} USDso x ${d.lev}x).`);
      }
    }
  }

  /** Attribution ping to a card's sharer: skipped when they are gone or blocked the bot; at most `pingsPerHour`. */
  private async pingSharer(card: CardRec, html: string): Promise<void> {
    const s = this.store.get(card.by);
    if (!s || s.blockedAt) return;
    if (!this.buckets.allow(`ping:${s.id}`, LIMITS.pingsPerHour, 3_600_000)) return; // counts still show in /invite
    await this.say(s.id, html);
  }

  private async cmdInvite(u: User, chat: number): Promise<void> {
    const link = `https://t.me/${this.me}?start=r_${u.ref}`;
    const since = Date.now() - LIMITS.cardTtlMs;
    const cards = this.store.cardsBy(u.id).filter((c) => c.at >= since);
    const sum = (k: "taps" | "newUsers" | "copies") => cards.reduce((a, c) => a + c[k], 0);
    await this.say(chat,
      `<b>Your invite link</b>\n${link}\nPeople who joined through your links and cards: ${this.store.refCount(u.ref)}\n\n` +
      `<b>Your cards, last 30 days</b>\nCards made: ${cards.length} · taps: ${sum("taps")} · new users: ${sum("newUsers")} · copies: ${sum("copies")}\n\n` +
      `Make a card with /card and forward it: friends tap <b>Copy this trade</b> to open the same trade on their own account.`);
  }

  // ---------- /watch: read-only liquidation pings for any account ----------
  private watchUsage(pct: number): string {
    return `<code>/watch 0xAccount</code> sends you a warning when a position on that dreamDEX account gets within ${pct}% of liquidation (change it with /alerts). ` +
      `Read only: no link, no key, no trading. Up to ${LIMITS.watchesPerUser} accounts; /unwatch removes one. ` +
      `Watches stay on while you use the bot: after ${Math.round(LIMITS.watchIdleMs / 86_400_000)} days without a message from you they end, and I tell you.`;
  }

  /** Why `arg` cannot be watched, or undefined when it can. */
  private watchAddrProblem(arg: string | undefined, pct: number): string | undefined {
    if (!isAddress(arg)) return `That is not an account address.\n${this.watchUsage(pct)}`;
    if (BigInt(arg) === 0n) return "That is the zero address: nothing to watch.";
    return undefined;
  }

  private watchSummary(addr: string, view: { equity?: number; positions: { base: string; side: Side; size: number; mark?: number; liq?: number }[] }): string {
    const head = `${addrLink(addr)}${view.equity !== undefined ? ` · equity ${fmtUsd(view.equity)} USDso` : ""}`;
    if (!view.positions.length) return `${head}\nno open positions`;
    return `${head}\n` + view.positions.map((p) => {
      const d = p.mark !== undefined ? liqDistancePct(p.side, p.mark, p.liq) : undefined;
      return `${p.base}-PERP ${p.side} ${p.size}${p.mark !== undefined ? ` · mark ${fmtPrice(p.mark)}` : ""} · ${p.liq ? `liquidation ${fmtPrice(p.liq)}${d !== undefined ? ` (${d.toFixed(1)}% away)` : ""}` : "no liquidation price"}`;
    }).join("\n");
  }

  private watchButtons(u: User, addr: string): Button[][] {
    const hex = addr.slice(2).toLowerCase();
    const row: Button[] = [];
    if (u.owner?.toLowerCase() !== addr.toLowerCase()) row.push({ text: "Guard it: link this account", callback_data: `wg:${hex}` });
    row.push({ text: "Unwatch", callback_data: `uw:${hex}` });
    return [row];
  }

  private async cmdWatch(u: User, chat: number, arg?: string): Promise<void> {
    const mine = u.watches ?? [];
    if (!arg) {
      if (!mine.length) { await this.say(chat, `You watch no accounts.\n${this.watchUsage(u.liqWarnPct)}`); return; }
      // From the Protector's cache only: no new chain reads.
      const parts = mine.map((w) => {
        const v = this.protector.watchView(w.addr);
        if (v.at === undefined && u.owner?.toLowerCase() === w.addr.toLowerCase()) return `${addrLink(w.addr)}\nyour linked account: your own alerts cover it (/positions)`;
        return this.watchSummary(w.addr, v);
      });
      await this.say(chat, `<b>Watched accounts</b> (warning within ${u.liqWarnPct}% of liquidation)\n\n${parts.join("\n\n")}`,
        mine.map((w) => [{ text: `Unwatch ${w.addr.slice(0, 6)}…${w.addr.slice(-4)}`, callback_data: `uw:${w.addr.slice(2).toLowerCase()}` }]));
      return;
    }
    const bad = this.watchAddrProblem(arg, u.liqWarnPct);
    if (bad) { await this.say(chat, bad); return; }
    const addr = getAddress(arg!);
    if (!this.buckets.allow(`watch:${u.id}`, LIMITS.watchAddsPer10Min, 10 * 60_000)) { await this.say(chat, "Too many /watch requests: please wait a few minutes."); return; }
    const lower = addr.toLowerCase();
    if (mine.some((w) => w.addr.toLowerCase() === lower)) { await this.say(chat, `You already watch ${addrLink(addr)}. /watch lists your accounts.`, this.watchButtons(u, addr)); return; }
    if (mine.length >= LIMITS.watchesPerUser) { await this.say(chat, `You can watch up to ${LIMITS.watchesPerUser} accounts. /unwatch one first.`); return; }
    const all = this.store.watchedAddresses();
    if (!all.includes(lower) && all.length >= LIMITS.watchedMax) { await this.say(chat, "Watch mode is full right now. Please try again later."); return; }
    u.watches = [...mine, { addr, at: Date.now() }];
    this.store.save();
    await this.protector.refreshWatched(addr).catch(() => {});
    let view: { equity?: number; positions: { base: string; side: Side; size: number; mark?: number; liq?: number }[] } = this.protector.watchView(addr);
    if (this.protector.watchView(addr).at === undefined) view = await this.venue.account(addr).catch(() => ({ positions: [] })); // e.g. your own linked account
    await this.say(chat,
      `👀 <b>Watching</b> ${this.watchSummary(addr, view)}\n\n` +
      `I warn you when a position gets within ${u.liqWarnPct}% of liquidation (/alerts changes it; again only if it gets twice as close) and tell you when a warned position is gone. Read only: nothing is ever sent for this account. ` +
      `Watches end after ${Math.round(LIMITS.watchIdleMs / 86_400_000)} days without a message from you.`,
      this.watchButtons(u, addr));
  }

  private async cmdUnwatch(u: User, chat: number, arg?: string): Promise<void> {
    const mine = u.watches ?? [];
    if (!mine.length) { await this.say(chat, "You watch no accounts."); return; }
    let target: string;
    if (arg) {
      if (!isAddress(arg)) { await this.say(chat, "Send <code>/unwatch 0xAccount</code>."); return; }
      target = arg.toLowerCase();
    } else if (mine.length === 1) {
      target = mine[0]!.addr.toLowerCase();
    } else {
      await this.say(chat, "Which one?", mine.map((w) => [{ text: `Unwatch ${w.addr.slice(0, 6)}…${w.addr.slice(-4)}`, callback_data: `uw:${w.addr.slice(2).toLowerCase()}` }]));
      return;
    }
    const left = mine.filter((w) => w.addr.toLowerCase() !== target);
    if (left.length === mine.length) { await this.say(chat, "You are not watching that account. /watch lists yours."); return; }
    if (left.length) u.watches = left; else delete u.watches;
    this.store.save();
    await this.protector.refreshWatched(target).catch(() => {}); // drops the entries nobody watches any more
    await this.say(chat, `Stopped watching ${addrLink(getAddress(target))}.`);
  }

  private async watchWarn(u: User, addr: string, _base: string, text: string): Promise<void> {
    await this.say(u.id, `⚠️ <b>Watched account</b> ${addrLink(getAddress(addr))}: ${h(text)}`, this.watchButtons(u, addr));
  }

  private async watchGone(u: User, addr: string, base: string, side: Side): Promise<void> {
    await this.say(u.id, `The ${base}-PERP ${side} on ${addrLink(getAddress(addr))} is gone (closed or liquidated).`, [[{ text: "Unwatch", callback_data: `uw:${addr.slice(2).toLowerCase()}` }]]);
  }

  private async guardIt(u: User, chat: number, addr: `0x${string}`): Promise<void> {
    if (u.owner?.toLowerCase() === addr.toLowerCase()) { await this.say(chat, "This account is already linked here: /tp, /sl, /alerts and /guard work on it."); return; }
    if (u.owner) { await this.say(chat, `One account per Telegram user: you are linked to ${addrLink(u.owner)}. Send /unlink first, then link this one.`); return; }
    if (!(await this.giveKey(u, chat)) || !hasKey(u)) return; // a watcher gets their bot key now
    await this.say(chat,
      `<b>Guard ${addr.slice(0, 6)}…${addr.slice(-4)}</b> (if it is your account)\n` +
      `1. In <a href="${APP_URL}">app.testnet.dreamdex.io</a> connect the wallet of that account, open it, <b>Link a bot</b>.\n` +
      `2. Paste your bot key <code>${u.keyAddress}</code>, keep <b>Perps</b> ticked, <b>Add bot</b>.\n` +
      `3. Send <code>/link ${addr}</code>.\n\n` +
      `Then <code>/guard 3</code> closes a position for you when it gets within 3% of liquidation, and /tp, /sl work on it. The key can never withdraw.`);
  }

  // ---------- buttons ----------
  private async onCallback(q: TgCallback): Promise<void> {
    const data = q.data ?? "";
    const chat = q.from.id; // private chats only: the user's own chat
    await this.tg.answerCallback(q.id).catch(() => {});
    try {
      // Buttons from /demo work before /start.
      if (data === "dc") { await this.demoCard(q.from.id, chat); return; }
      if (data === "st") { await this.cmdStart(q.from.id, chat); return; }
      if (data === "wd") { const r = await this.ensureUser(q.from.id, chat, { key: false }); if (r) await this.cmdWatch(r.user, chat, this.demoAccount); return; }
      if (data === "sk") { await this.cmdStops(q.from.id, chat); return; }
      const ty = /^ty:(ETH|SOL|XRP):([ls])$/.exec(data);
      if (ty) { await this.tryOrder(q.from.id, chat, ty[1]!, ty[2] === "l" ? "long" : "short"); return; }
      const wu = this.store.get(q.from.id);
      if (!wu) { await this.say(chat, "Send /start first."); return; }
      // Watch buttons work for watch-only records (no key).
      const wm = /^(uw|wg):([0-9a-f]{40})$/.exec(data);
      if (wm) {
        const addr = getAddress(`0x${wm[2]!}`);
        if (wm[1] === "uw") await this.cmdUnwatch(wu, chat, addr); else await this.guardIt(wu, chat, addr);
        return;
      }
      if (!hasKey(wu)) { await this.say(chat, "Send /start first to get your personal bot key."); return; }
      const u = wu;
      if (data === "chk") {
        if (!this.linkCheckAllowed(u.id)) { await this.say(chat, "Please wait a minute before checking again."); return; }
        const owners = await findLinkedOwners(this.venue.pub, u.keyAddress, 30);
        if (!owners.length) {
          await this.say(chat, `I can't see a Link a bot grant for <code>${u.keyAddress}</code> in the last 30 minutes. Link it in the app first, or send <code>/link 0xYourAccount</code>.`, [[{ text: "Check again", callback_data: "chk" }]]);
          return;
        }
        if (owners.length > 1) {
          // Grants are public: anyone can link someone else's bot address. Never guess between accounts.
          await this.say(chat, `More than one account linked this bot key recently:\n${owners.slice(0, 5).map((o) => `<code>${getAddress(o)}</code>`).join("\n")}\nSend <code>/link 0xYourFullAccountAddress</code> to pick yours.`);
          return;
        }
        await this.attach(u, chat, getAddress(owners[0]!));
        return;
      }
      const cl = /^cl:([A-Z0-9]{1,12}):(50|100)(?::([0-9a-f]{10}))?$/.exec(data);
      if (cl) {
        if (!this.venue.market(cl[1]!)) return;
        // A button acts only on the account it was shown for (older buttons carry no account: refused).
        if (!cl[3] || !u.owner || acctTag(u.owner) !== cl[3]) {
          await this.say(chat, "That button is from an earlier message for an account you are no longer linked to (or from an older version). Nothing was sent. /positions shows fresh buttons.");
          return;
        }
        this.tradeAllowed(u);
        await this.doClose(u, chat, cl[1]!, Number(cl[2]) / 100, Number(cl[2]) === 100 ? "manual close" : "manual close 50%");
        return;
      }
      const cd = /^cd:([A-Z0-9]{1,12})$/.exec(data);
      if (cd) { await this.cmdCard(u, chat, cd[1]); return; }
      const cm = /^cm:([0-9a-f]{10}):(10|25|50)$/.exec(data);
      if (cm) { await this.copyPreview(u, chat, cm[1]!, Number(cm[2])); return; }
      const cx = /^cx:([0-9a-f]{12}):([01])$/.exec(data);
      if (cx) { await this.copyConfirm(u, chat, cx[1]!, cx[2] === "1"); return; }
    } catch (e) {
      if (e instanceof UserError) { await this.say(chat, h(e.message)); return; }
      log("callback failed", String(e instanceof Error ? e.message : e).slice(0, 300));
      await this.say(chat, "Something went wrong talking to the chain. If an order was sent, /positions will show it.");
    }
  }
}

if (process.argv[1]?.endsWith("bot.mjs") || process.argv[1]?.endsWith("bot.ts")) {
  const bot = new Bot();
  bot.start().then(() => process.exit(bot.exitCode), (e) => { console.error("fatal:", String(e instanceof Error ? e.message : e).slice(0, 300)); process.exit(1); });
}
