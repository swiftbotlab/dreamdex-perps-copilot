// Perps Copilot: Telegram front end. Long polling, per-user serial queues, per-user rate limits,
// one global cap on concurrent transactions. User text is parsed by src/parse.ts only; nothing
// user-supplied reaches a shell, an eval, a file path or an SVG without validation.
import { getAddress } from "viem";
import { APP_URL, CHAIN_NAME, EXPLORER_ADDR, EXPLORER_TX, LIMITS, PATHS } from "./config.ts";
import { renderCard } from "./card.ts";
import { KeyVault } from "./keys.ts";
import { checkVsMark, cleanBase, escapeHtml as h, fmtPrice, fmtUsd, isAddress, liqDistancePct, parseAmount, parseLevel, parseOpen, resolveLevel, splitCommand, type Side } from "./parse.ts";
import { Protector } from "./protect.ts";
import { readEnvFile } from "./secrets.ts";
import { Store, type User } from "./store.ts";
import { Telegram, type Button, type TgCallback, type TgMessage, type TgUpdate } from "./tg.ts";
import { findLinkedOwners, UserError, Venue, type Position, type TradeResult } from "./venue.ts";

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

/** One async lock per key: opens and closes of the same account+market never overlap. */
class KeyedLock {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, f: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try { return await f(); } finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}

class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiters.length >= 50) throw new UserError("The bot is busy right now. Try again in a minute.");
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.active++;
    try { return await f(); } finally { this.active--; this.waiters.shift()?.(); }
  }
}

const txLink = (hash: string) => `<a href="${EXPLORER_TX}${hash}">${hash.slice(0, 10)}…${hash.slice(-6)}</a>`;
const addrLink = (a: string) => `<a href="${EXPLORER_ADDR}${a}">${a.slice(0, 8)}…${a.slice(-6)}</a>`;

export class Bot {
  private tg: Telegram;
  private vault: KeyVault;
  private store: Store;
  private venue = new Venue();
  private protector: Protector;
  private me = "";
  private buckets = new Bucket();
  private txs = new Semaphore(LIMITS.maxConcurrentTx);
  private autoTxs = new Semaphore(2);                 // auto-closes never queue behind other users' opens
  private posLock = new KeyedLock();
  private recentClose = new Map<string, { prevSize: number; at: number }>();
  private pending = new Map<number, number>();
  private queues = new Map<number, Promise<void>>();
  private stopping = false;

  constructor() {
    const bot = readEnvFile(PATHS.botEnv);
    const master = readEnvFile(PATHS.masterEnv);
    this.tg = new Telegram(bot.BOT_TOKEN ?? "");
    this.vault = new KeyVault(master.DDMVP_MASTER_KEY ?? "");
    this.store = new Store(PATHS.data);
    this.protector = new Protector(this.venue, this.store, (u, b, f, r, o) => this.autoClose(u, b, f, r, o), (u, b, t) => this.liqWarn(u, b, t), log);
  }

  async start(): Promise<void> {
    await this.venue.init();
    const me = await this.tg.getMe();
    this.me = me.username ?? "";
    log("started as", this.me, "markets", this.venue.list().length, "users", this.store.count());
    await this.tg.setMyCommands([
      { command: "start", description: "Set up: link your bot key" },
      { command: "long", description: "Open long: /long ETH 20 5x" },
      { command: "short", description: "Open short: /short BTC 20 3x" },
      { command: "close", description: "Close: /close ETH [50%]" },
      { command: "positions", description: "Positions, PnL, liquidation" },
      { command: "tp", description: "Take-profit: /tp ETH 2500 or 4%" },
      { command: "sl", description: "Stop-loss: /sl ETH 2300 or 2%" },
      { command: "card", description: "Share a PnL card" },
      { command: "alerts", description: "Liquidation warning distance" },
      { command: "guard", description: "Auto-close near liquidation" },
      { command: "markets", description: "Markets and marks" },
      { command: "status", description: "Account, gas, link" },
      { command: "help", description: "How it works" },
    ]).catch((e) => log("setMyCommands", String(e)));
    await this.tg.setDescription(
      "Trade dreamDEX perps on Somnia Tokyo testnet from Telegram. Market orders with size and leverage, positions with PnL, take-profit / stop-loss that close for you, liquidation alerts, and PnL cards to share. Your account stays yours: you link a trading key that can place orders but can never withdraw.",
      "dreamDEX perps from Telegram: orders, TP/SL, liquidation alerts, PnL cards. Testnet.",
    ).catch((e) => log("setDescription", String(e)));
    this.protector.start();
    setInterval(() => {
      this.buckets.prune(3_600_000);
      for (const [k, v] of this.recentClose) if (Date.now() - v.at > 60_000) this.recentClose.delete(k);
      const n = this.store.pruneUnlinked(48 * 3_600_000);
      if (n) log("pruned unlinked users", n);
    }, 10 * 60_000).unref();
    process.on("SIGTERM", () => { this.stopping = true; });
    process.on("SIGINT", () => { this.stopping = true; });
    await this.poll();
    this.protector.stop();
    log("stopped");
  }

  private async poll(): Promise<void> {
    let offset = 0;
    let backoff = 1_000;
    while (!this.stopping) {
      try {
        const updates = await this.tg.getUpdates(offset);
        backoff = 1_000;
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
    const user = this.store.get(id);
    if (!user) { await this.say(chat, "Send /start first to get your personal bot key."); return; }
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
      default: await this.say(chat, "Unknown command. /help lists them.");
    }
  }

  private say(chat: number, html: string, buttons?: Button[][]) {
    return this.tg.sendMessage(chat, html, buttons).catch((e) => log("send failed", String(e).slice(0, 120)));
  }

  // ---------- onboarding ----------
  private async cmdStart(id: number, chat: number, payload?: string): Promise<void> {
    let user = this.store.get(id);
    if (!user) {
      if (this.store.count() >= LIMITS.maxUsers) { await this.say(chat, "The testnet beta is full right now. Please try again later."); return; }
      if (this.store.keysMadeLastHour() >= LIMITS.newKeysPerHour) { await this.say(chat, "Lots of sign-ups this hour. Please try again in a few minutes."); return; }
      const refBy = payload && /^r_[0-9a-f]{10}$/.test(payload) && this.store.byRef(payload.slice(2)) ? payload.slice(2) : undefined;
      const { address, sealed } = this.vault.create(id);
      user = this.store.add({ id, created: Date.now(), keyAddress: address, key: sealed, refBy });
      log("new user", refBy ? "via share link" : "direct", "total", this.store.count());
    }
    const linked = user.owner ? `\n\nLinked account: ${addrLink(user.owner)}. Try <code>/long ETH 20 5x</code> or /positions.` : "";
    await this.say(chat,
      `<b>Perps Copilot</b> trades dreamDEX perps on ${CHAIN_NAME} for you, right here in Telegram.\n\n` +
      `<b>How the bot gets permission</b>\nYou never share your wallet. I made you a personal <b>bot key</b>:\n<code>${user.keyAddress}</code>\n\n` +
      `1. Open <a href="${APP_URL}">app.testnet.dreamdex.io</a>, open your wallet, choose <b>Link a bot</b>.\n` +
      `2. Paste the address above, keep <b>Perps</b> ticked, press <b>Add bot</b>. Let the app send it a little STT for gas.\n` +
      `3. Make sure your <b>Perps</b> balance has USDso (Perps ⇆ Spot in the app; Perps Arena paper USDso works).\n` +
      `4. Press <b>I've linked it</b> below.\n\n` +
      `A linked key can place, cancel and close orders for your account. It <b>cannot withdraw or move funds</b>, and you can remove it in the app at any time.` + linked,
      [[{ text: "Open dreamDEX", url: APP_URL }], [{ text: "I've linked it", callback_data: "chk" }]]);
  }

  private async cmdHelp(chat: number): Promise<void> {
    await this.say(chat,
      `<b>Commands</b>\n` +
      `<code>/long ETH 20 5x</code> market long: 20 USDso margin at 5x = 100 USDso position\n` +
      `<code>/short BTC 15 10x tp 3% sl 1.5%</code> short with take-profit and stop-loss\n` +
      `<code>/close ETH</code> or <code>/close ETH 50%</code>\n` +
      `/positions  PnL, liquidation price and distance\n` +
      `<code>/tp ETH 2500</code>, <code>/sl ETH 2%</code>, <code>/tp ETH off</code>  bot-watched exits\n` +
      `<code>/alerts 10</code> warn when within 10% of liquidation\n` +
      `<code>/guard 3</code> auto-close when within 3% (<code>/guard off</code>)\n` +
      `/card  PnL card to share   /markets   /status   /key\n\n` +
      `<b>How protection works</b>: the bot follows every market you hold through Somnia Reactivity (mark price pushed by the chain about once a second) and closes for you when your TP, SL or guard level is reached. It runs while the bot runs; it is not an on-chain stop order.\n\n` +
      `Testnet only (${CHAIN_NAME}). Not financial advice.`);
  }

  private async cmdKey(u: User, chat: number): Promise<void> {
    const gas = await this.venue.gasBalance(u.keyAddress);
    await this.say(chat, `Your bot key: <code>${u.keyAddress}</code>\nGas: ${gas.toFixed(4)} STT${gas < LIMITS.lowGasStt ? " (low: each order costs about 0.015 STT; top it up from the app's Link a bot screen or send STT to the address)" : ""}\n${addrLink(u.keyAddress)}`);
  }

  private async cmdLink(u: User, chat: number, arg?: string): Promise<void> {
    if (!isAddress(arg)) { await this.say(chat, "Send <code>/link 0xYourDreamdexAccount</code>, or link the bot key in the app and press <b>I've linked it</b> after /start."); return; }
    if (!this.linkCheckAllowed(u.id)) { await this.say(chat, "Please wait a minute before linking again."); return; }
    await this.attach(u, chat, getAddress(arg));
  }

  private linkCheckAllowed(id: number): boolean {
    return this.buckets.allow(`link:${id}`, 3, 60_000) && this.buckets.allow(`linkh:${id}`, 15, 3_600_000);
  }

  private async attach(u: User, chat: number, owner: `0x${string}`): Promise<void> {
    if (owner.toLowerCase() === u.keyAddress.toLowerCase()) { await this.say(chat, "That is the bot key itself. Send the dreamDEX account you linked it to."); return; }
    const cov = await this.venue.coverage(owner, u.keyAddress);
    if (!cov.linked.length) {
      await this.say(chat, `The bot key is not linked to ${addrLink(owner)} yet. In the app: wallet, <b>Link a bot</b>, paste <code>${u.keyAddress}</code>, keep Perps ticked, Add bot. Then press the button again.`, [[{ text: "I've linked it", callback_data: "chk" }]]);
      return;
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
  }

  private async cmdUnlink(u: User, chat: number): Promise<void> {
    delete u.owner; u.rules = {}; this.venue.forgetKey(u.id); this.store.save();
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

  private async cmdStatus(u: User, chat: number): Promise<void> {
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
      `Somnia Reactivity: ${w.length} live mark stream${w.length === 1 ? "" : "s"}${w.length ? ` (${w.map((x) => `${x.base} ${x.pushes} pushes`).join(", ")})` : ""}`);
  }

  // ---------- trading ----------
  private requireLinked(u: User): { owner: `0x${string}` } {
    if (!u.owner) throw new UserError("Link your bot key first: send /start and follow the steps.");
    return { owner: u.owner };
  }

  private tk(u: User) {
    const { owner } = this.requireLinked(u);
    return this.venue.tradingKey(u.id, owner, () => this.vault.open(u.id, u.key));
  }

  private tradeAllowed(u: User): void {
    if (!this.buckets.allow(`trade:${u.id}`, LIMITS.tradesPerMinute, 60_000) || !this.buckets.allow(`tradeh:${u.id}`, LIMITS.tradesPerHour, 3_600_000)) {
      throw new UserError("Slow down a little: too many orders in a short time.");
    }
  }

  private async gasCheck(u: User): Promise<void> {
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

  private async openLocked(u: User, chat: number, side: Side, p: Exclude<ReturnType<typeof parseOpen>, string>, tk: ReturnType<Bot["tk"]>): Promise<void> {
    const m = this.venue.market(p.base)!;
    const [cap, acct] = await Promise.all([this.venue.accountCap(tk.owner, m), this.venue.account(tk.owner)]);
    if (cap > 0 && p.leverage > cap) throw new UserError(`Your account caps ${p.base}-PERP at ${cap}x (set in the app). Use ${cap}x or less, or raise it in the app.`);
    const existing = acct.positions.find((x) => x.base === p.base);
    if (existing && existing.side !== side) throw new UserError(`You hold a ${existing.side} on ${p.base}-PERP. Close it first with /close ${p.base} (this bot does not flip positions by accident).`);
    await this.gasCheck(u);
    const notional = p.margin * p.leverage;
    const minN = this.venue.minNotional(p.base);
    if (minN && notional < minN * 1.02) throw new UserError(`Too small: the minimum ${p.base}-PERP order is about ${(minN * 1.02).toFixed(2)} USDso notional (margin x leverage).`);
    await this.say(chat, `Sending ${side} ${p.base}-PERP, ${fmtUsd(notional)} USDso (${fmtUsd(p.margin)} x ${p.leverage}x), market order…`);
    const r = await this.txs.run(() => this.venue.open(tk, p.base, side, notional));
    this.record(u, "open", r);
    if (r.filledBase === 0) { await this.say(chat, `Nothing filled (the book moved). Tx ${txLink(r.hash)}. No position was opened.`); return; }
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
      u.rules[p.base] = { ...(u.rules[p.base] ?? { side, setAt: Date.now() }), side, [k]: v };
      notes.push(`${k.toUpperCase()} ${fmtPrice(v)} watched`);
    }
    this.store.save();
    await this.protector.refreshUser(u).catch(() => {});
    const pos = await this.waitPosition(tk.owner, p.base, (x) => !!x && (!existing || x.size !== existing.size));
    await this.say(chat,
      `<b>Filled</b> ${side} ${r.filledBase} ${p.base} @ ${r.avgPrice ? fmtPrice(r.avgPrice) : "?"}\nTx ${txLink(r.hash)}\n` +
      (pos ? `Position: ${pos.side} ${pos.size} ${p.base}, entry ${fmtPrice(pos.entry)}${pos.liq ? `, liquidation ${fmtPrice(pos.liq)}` : ""}\n` : "") +
      (notes.length ? h(notes.join(" · ")) + "\n" : `Add exits: <code>/tp ${p.base} 4%</code> <code>/sl ${p.base} 2%</code>\n`),
      [[{ text: `Close ${p.base}`, callback_data: `cl:${p.base}:100` }, { text: "PnL card", callback_data: `cd:${p.base}` }]]);
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

  private async doClose(u: User, chat: number, base: string, fraction: number, reason: string, opt: { limit?: number; expectSide?: Side; auto?: boolean } = {}): Promise<TradeResult> {
    const tk = this.tk(u);
    const key = `${tk.owner.toLowerCase()}:${base}`;
    return this.posLock.run(key, async () => {
      await this.gasCheck(u);
      let sideChanged = false;
      // Runs inside venue.close right after the fresh position read, before anything is sent.
      const guard = (abs: number, side: Side) => {
        if (opt.expectSide && side !== opt.expectSide) {
          sideChanged = true;
          throw new UserError(`Your ${base}-PERP position is now a ${side}, not the ${opt.expectSide} this exit was set for. Nothing was sent, and the old ${base} exits were cleared.`);
        }
        const rc = this.recentClose.get(key);
        if (rc && Date.now() - rc.at < 20_000 && abs >= rc.prevSize - 1e-12) {
          throw new UserError(`A close for ${base}-PERP just went through and the chain read has not caught up yet. Nothing was sent; check /positions in a few seconds.`);
        }
      };
      let r: TradeResult;
      try {
        r = await (opt.auto ? this.autoTxs : this.txs).run(() => this.venue.close(tk, base, fraction, opt.limit, guard));
      } catch (e) {
        if (sideChanged) { delete u.rules[base]; this.store.save(); }
        throw e;
      }
      if (r.filledBase > 0) this.recentClose.set(key, { prevSize: r.prevSize ?? Infinity, at: Date.now() });
      return this.afterClose(u, chat, base, reason, tk.owner, r);
    });
  }

  private async afterClose(u: User, chat: number, base: string, reason: string, owner: `0x${string}`, r: TradeResult): Promise<TradeResult> {
    this.record(u, "close", r, reason);
    const left = await this.waitPosition(owner, base, (x) => r.filledBase === 0 || !x || x.size < (r.prevSize ?? Infinity) - 1e-12);
    if (r.filledBase > 0 && r.avgPrice && r.entry) {
      u.lastClosed = { base, side: r.side === "short" ? "long" : "short", entry: r.entry, exit: r.avgPrice, size: r.filledBase, pnl: r.realizedPnl ?? 0, at: Date.now(), reason };
    }
    if (!left) { delete u.rules[base]; }
    this.store.save();
    await this.protector.refreshUser(u).catch(() => {});
    await this.say(chat,
      `<b>${h(reason[0]!.toUpperCase() + reason.slice(1))}</b>: ${r.filledBase > 0 ? `closed ${r.filledBase} ${base} @ ${r.avgPrice ? fmtPrice(r.avgPrice) : "?"}` : "nothing filled (book moved)"}\n` +
      `Tx ${txLink(r.hash)}\n` +
      (r.realizedPnl !== undefined && r.filledBase > 0 ? `Realised PnL ≈ ${fmtUsd(r.realizedPnl, true)} USDso (before fees)\n` : "") +
      (left ? `Remaining: ${left.side} ${left.size} ${base}` : "Position closed."),
      r.filledBase > 0 ? [[{ text: "PnL card", callback_data: `cd:${base}` }]] : undefined);
    return r;
  }

  private async autoClose(u: User, base: string, fraction: number, reason: string, opt: { kind: "tp" | "sl" | "guard"; limit?: number; side: Side }): Promise<void> {
    log("auto-close", base, opt.kind, reason);
    try {
      await this.doClose(u, u.id, base, fraction, reason, { limit: opt.limit, expectSide: opt.side, auto: true });
    } catch (e) {
      const msg = e instanceof UserError ? e.message : "chain error";
      log("auto-close failed", base, opt.kind, String(e instanceof Error ? e.message : e).slice(0, 200));
      // A take-profit whose limit the book does not reach yet is not an error: retry quietly on the next pushes.
      const quiet = opt.kind === "tp" && /nothing would fill|thin/i.test(msg);
      const key = `${u.id}:${base}:${opt.kind}`;
      if (!quiet && this.buckets.allow(`autofail:${key}`, 1, 5 * 60_000)) {
        await this.say(u.id, `⚠️ ${h(reason)}, but closing ${base}-PERP failed: ${h(msg)} I keep retrying while the level holds. You can also /close ${base}.`);
      }
      throw e;
    }
  }

  private async liqWarn(u: User, base: string, text: string): Promise<void> {
    await this.say(u.id, `⚠️ <b>Liquidation risk</b>\n${h(text)}`, [[{ text: "Close 50%", callback_data: `cl:${base}:50` }, { text: "Close all", callback_data: `cl:${base}:100` }]]);
  }

  private record(u: User, kind: string, r: TradeResult, reason?: string): void {
    u.stats.orders++;
    this.store.logOrder({ kind, reason, market: `${r.base}-PERP`, side: r.side, hash: r.hash, filled: r.filledBase, requested: r.requestedBase, avgPrice: r.avgPrice === undefined ? undefined : Number(r.avgPrice.toPrecision(10)), key: u.keyAddress, account: u.owner });
  }

  private async cmdPositions(u: User, chat: number): Promise<void> {
    const { owner } = this.requireLinked(u);
    const acct = await this.venue.account(owner);
    if (!acct.positions.length) { await this.say(chat, `No open positions. Equity ${fmtUsd(acct.equity)} USDso. Try <code>/long ETH 20 5x</code>.`); return; }
    const lines = acct.positions.map((p) => {
      const d = liqDistancePct(p.side, p.mark, p.liq);
      const r = u.rules[p.base];
      const roe = u.opens[p.base] ? ((p.mark - p.entry) / p.entry) * (p.side === "long" ? 1 : -1) * u.opens[p.base]!.leverage * 100 : undefined;
      return `<b>${p.base}-PERP ${p.side}</b> ${p.size} (${fmtUsd(p.notional)} USDso)\n` +
        `entry ${fmtPrice(p.entry)} · mark ${fmtPrice(p.mark)}\n` +
        `PnL <b>${fmtUsd(p.upnl, true)}</b> USDso${roe !== undefined ? ` (${roe >= 0 ? "+" : ""}${roe.toFixed(2)}% on margin)` : ""}\n` +
        `liquidation ${p.liq ? `${fmtPrice(p.liq)} (${d!.toFixed(1)}% away)` : p.side === "long" ? "none above 0 (your margin covers this long)" : "n/a"}` +
        (r ? `\nwatched: ${r.tp ? `TP ${fmtPrice(r.tp)} ` : ""}${r.sl ? `SL ${fmtPrice(r.sl)}` : ""}` : "");
    });
    const buttons = acct.positions.slice(0, 6).map((p) => [{ text: `Close ${p.base}`, callback_data: `cl:${p.base}:100` }, { text: `Card ${p.base}`, callback_data: `cd:${p.base}` }]);
    await this.say(chat, `${lines.join("\n\n")}\n\nEquity ${fmtUsd(acct.equity)} USDso · margin status ${h(acct.status)}`, buttons);
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
    r.side = pos.side; r.setAt = Date.now();
    if (r.tp || r.sl) u.rules[base] = r; else delete u.rules[base];
    this.store.save();
    await this.protector.refreshUser(u).catch(() => {});
    await this.say(chat, `${base}-PERP ${pos.side}: ${r.tp ? `take-profit ${fmtPrice(r.tp)}` : "no take-profit"}, ${r.sl ? `stop-loss ${fmtPrice(r.sl)}` : "no stop-loss"}. Mark now ${fmtPrice(pos.mark)}. Watched live through Somnia Reactivity; I close the position when a level is reached.`);
  }

  private async cmdAlerts(u: User, chat: number, arg?: string): Promise<void> {
    const v = parseAmount(arg, 1, 50, 1);
    if (v === undefined) { await this.say(chat, `Liquidation warning is at ${u.liqWarnPct}%. Change it with <code>/alerts 10</code> (1-50).`); return; }
    u.liqWarnPct = v; this.store.save();
    await this.say(chat, `I will warn you when the mark is within ${v}% of your liquidation price.`);
  }

  private async cmdGuard(u: User, chat: number, arg?: string): Promise<void> {
    if (arg?.toLowerCase() === "off") { delete u.guardPct; this.store.save(); await this.say(chat, "Guard off: I will only warn, not close."); return; }
    const v = parseAmount(arg, 0.5, 20, 1);
    if (v === undefined) { await this.say(chat, `Guard is ${u.guardPct ? `on at ${u.guardPct}%` : "off"}. <code>/guard 3</code> closes a position when the mark gets within 3% of its liquidation price (0.5-20), <code>/guard off</code> stops it.`); return; }
    u.guardPct = v; if (u.liqWarnPct <= v) u.liqWarnPct = Math.min(50, v * 2); this.store.save();
    await this.say(chat, `Guard on: I close a position when the mark gets within ${v}% of its liquidation price (warning at ${u.liqWarnPct}%).`);
  }

  private async cmdCard(u: User, chat: number, arg?: string): Promise<void> {
    if (!this.buckets.allow(`card:${u.id}`, LIMITS.cardsPerMinute, 60_000)) { await this.say(chat, "One moment: card limit reached, try again in a minute."); return; }
    const want = cleanBase(arg);
    const acct = u.owner ? await this.venue.account(u.owner) : undefined;
    const p = acct?.positions.find((x) => !want || x.base === want);
    let png: Uint8Array, caption: string;
    if (p) {
      const lev = u.opens[p.base]?.leverage;
      png = await renderCard({ base: p.base, side: p.side, leverage: lev, entry: p.entry, price: p.mark, pnl: p.upnl, open: true, spark: this.protector.sparkFor(p.base), botUsername: this.me, ref: u.ref, when: new Date() });
      caption = `${p.base}-PERP ${p.side}${lev ? ` ${lev}x` : ""}: ${fmtUsd(p.upnl, true)} USDso open PnL on dreamDEX (${CHAIN_NAME}).`;
    } else if (u.lastClosed && (!want || u.lastClosed.base === want)) {
      const c = u.lastClosed;
      png = await renderCard({ base: c.base, side: c.side, leverage: u.opens[c.base]?.leverage, entry: c.entry, price: c.exit, pnl: c.pnl, open: false, spark: this.protector.sparkFor(c.base), botUsername: this.me, ref: u.ref, when: new Date(c.at) });
      caption = `${c.base}-PERP ${c.side} closed: ${fmtUsd(c.pnl, true)} USDso on dreamDEX (${CHAIN_NAME}).`;
    } else {
      await this.say(chat, "No position or recent close to put on a card yet.");
      return;
    }
    u.stats.cards++; this.store.save();
    const link = `https://t.me/${this.me}?start=r_${u.ref}`;
    await this.tg.sendPhoto(chat, png, `${h(caption)}\nTrade perps from Telegram: ${link}\nForward this card to share it.`, [[{ text: "Trade with Perps Copilot", url: link }]]);
  }

  // ---------- buttons ----------
  private async onCallback(q: TgCallback): Promise<void> {
    const data = q.data ?? "";
    const chat = q.from.id; // private chats only: the user's own chat
    const u = this.store.get(q.from.id);
    await this.tg.answerCallback(q.id).catch(() => {});
    if (!u) { await this.say(chat, "Send /start first."); return; }
    try {
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
      const cl = /^cl:([A-Z0-9]{1,12}):(50|100)$/.exec(data);
      if (cl) {
        if (!this.venue.market(cl[1]!)) return;
        this.tradeAllowed(u);
        await this.doClose(u, chat, cl[1]!, Number(cl[2]) / 100, Number(cl[2]) === 100 ? "manual close" : "manual close 50%");
        return;
      }
      const cd = /^cd:([A-Z0-9]{1,12})$/.exec(data);
      if (cd) { await this.cmdCard(u, chat, cd[1]); return; }
    } catch (e) {
      if (e instanceof UserError) { await this.say(chat, h(e.message)); return; }
      log("callback failed", String(e instanceof Error ? e.message : e).slice(0, 300));
      await this.say(chat, "Something went wrong talking to the chain. If an order was sent, /positions will show it.");
    }
  }
}

if (process.argv[1]?.endsWith("bot.mjs") || process.argv[1]?.endsWith("bot.ts")) {
  new Bot().start().then(() => process.exit(0), (e) => { console.error("fatal:", String(e instanceof Error ? e.message : e).slice(0, 300)); process.exit(1); });
}
