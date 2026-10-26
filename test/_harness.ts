// Shared test harness (not a test file): a Bot with a fake Telegram, a fake venue and a stub protector.
// No network, no chain: every send is recorded. Env is set before the bot module is loaded.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const root = mkdtempSync(`${tmpdir()}/ddmvp-h-`);
writeFileSync(`${root}/bot.env`, "BOT_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
writeFileSync(`${root}/master.env`, `DDMVP_MASTER_KEY=${"33".repeat(32)}\n`);
process.env.DDMVP_BOT_ENV = `${root}/bot.env`;
process.env.DDMVP_MASTER_ENV = `${root}/master.env`;
process.env.DDMVP_DATA = `${root}/data`;
process.env.DDMVP_WASM = new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url).pathname;

export const { Bot } = await import("../src/bot.ts");
export const { PATHS, LIMITS, EXPLORER_TX } = await import("../src/config.ts");
export const venueMod = await import("../src/venue.ts");
export const { Store } = await import("../src/store.ts");

export const HASH = `0x${"ab".repeat(32)}` as const;
export const OPERATOR = "0x00000000000000000000000000000000000000bb" as const;
export const POOLS: Record<string, `0x${string}`> = {
  ETH: "0xd6cb1dd58580b84d76068ac21594219ce03aeddf",
  SOL: "0x1111111111111111111111111111111111111111",
};
export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

export interface Sent { chat: number; html: string; buttons?: { text: string; callback_data?: string; url?: string }[][]; photo?: boolean }
export interface FakePos { base: string; side: "long" | "short"; size: number; entry: number; liq?: number }

let seq = 0;
export const msg = (id: number, text: string) => ({ update_id: ++seq, message: { message_id: seq, from: { id, first_name: "t" }, chat: { id, type: "private" }, date: 0, text } });
export const cb = (id: number, data: string) => ({ update_id: ++seq, callback_query: { id: `q${seq}`, from: { id }, data, message: { message_id: 1, chat: { id, type: "private" }, date: 0 } } });

export function makeBot(opts: { mark?: number; maxLev?: Record<string, number> } = {}) {
  PATHS.data = mkdtempSync(`${root}/d-`);
  const bot = new Bot() as any;
  bot.me = "SwiftPerpsBot";
  const sent: Sent[] = [];
  const attempts: number[] = [];
  const blocked = new Set<number>();
  bot.tg = {
    sendMessage: async (chat: number, html: string, buttons?: Sent["buttons"]) => {
      attempts.push(chat);
      if (blocked.has(chat)) throw new Error("telegram sendMessage: Forbidden: bot was blocked by the user");
      sent.push({ chat, html, buttons });
      return {};
    },
    sendPhoto: async (chat: number, _png: Uint8Array, html: string, buttons?: Sent["buttons"]) => { sent.push({ chat, html, buttons, photo: true }); return {}; },
    answerCallback: async () => ({}),
  };
  const state = {
    mark: opts.mark ?? 100,
    positions: new Map<string, FakePos[]>(),
    opens: [] as { owner: string; base: string; side: string; notional: number; opts: { maxTouchPct?: number } }[],
    accountCalls: 0,
  };
  const maxLev = opts.maxLev ?? { ETH: 20, SOL: 20, BTC: 20 };
  const market = (b: string) => (POOLS[b] ? { display: `${b}-PERP`, symbol: `${b}/USDso:USDso`, info: { poolAddress: POOLS[b] } } : undefined);
  const view = (owner: string) => ({
    equity: 1000, unlocked: 900, locked: 0, mmReq: 0, imReq: 0, status: "Healthy",
    positions: (state.positions.get(owner.toLowerCase()) ?? []).map((p) => ({ ...p, pool: POOLS[p.base]!, mark: state.mark, upnl: 0, notional: p.size * state.mark })),
  });
  bot.venue = {
    pub: {},
    market,
    marketByPool: (pool: string) => { const b = Object.keys(POOLS).find((k) => POOLS[k] === pool.toLowerCase()); return b ? market(b) : undefined; },
    baseOf: (m: { display: string }) => m.display.replace(/-PERP$/, ""),
    list: () => Object.keys(POOLS).map(market),
    maxLeverage: (b: string) => maxLev[b],
    minNotional: () => 5,
    mark: async () => state.mark,
    account: async (owner: string) => { state.accountCalls++; return view(owner); },
    accountCap: async () => 0,
    gasBalance: async () => 5,
    coverage: async () => ({ linked: ["ETH", "SOL"], missing: [] }),
    tradingKey: (_id: number, owner: string) => ({ owner, operator: OPERATOR }),
    forgetKey: () => {},
    reloadMarkets: async () => {},
    open: async (tk: { owner: string }, base: string, side: "long" | "short", notional: number, o: { maxTouchPct?: number }) => {
      state.opens.push({ owner: tk.owner, base, side, notional, opts: o });
      const size = notional / state.mark;
      const list = state.positions.get(tk.owner.toLowerCase()) ?? [];
      const ex = list.find((p) => p.base === base);
      if (ex) ex.size += size; else list.push({ base, side, size, entry: state.mark });
      state.positions.set(tk.owner.toLowerCase(), list);
      return { hash: HASH, filledBase: size, avgPrice: state.mark, requestedBase: size, base, side };
    },
  };
  const watchRefreshes: (string | undefined)[] = [];
  bot.protector = {
    refreshUser: async () => {},
    sparkFor: () => undefined,
    watching: () => [{ pool: POOLS.ETH, base: "ETH", pushes: 42, ageMs: 100 }],
    refreshWatched: async (a?: string) => { watchRefreshes.push(a); },
    watchView: () => ({ equity: 500, at: Date.now(), positions: [] }),
    stop: () => {},
  };
  const addUser = (id: number, owner?: `0x${string}`) => {
    const { address, sealed } = bot.vault.create(id);
    const u = bot.store.add({ id, created: Date.now(), keyAddress: address, key: sealed });
    if (owner) u.owner = owner;
    bot.store.save();
    return u;
  };
  const handle = (update: unknown) => bot.handle(update) as Promise<void>;
  const dispatch = async (update: { message?: { from: { id: number } }; callback_query?: { from: { id: number } } }) => {
    bot.dispatch(update);
    await bot.queues.get((update.message ?? update.callback_query)!.from.id);
  };
  const to = (chat: number) => sent.filter((s) => s.chat === chat);
  const cbData = (s: Sent | undefined) => (s?.buttons ?? []).flat().map((b) => b.callback_data ?? b.url ?? "");
  return { bot, sent, attempts, blocked, state, addUser, handle, dispatch, to, cbData, watchRefreshes };
}
