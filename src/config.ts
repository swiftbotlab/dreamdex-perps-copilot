// Fixed configuration. Testnet only: the chain id is asserted at startup and nothing else is accepted.
export const CHAIN_ID = 50383; // Somnia Tokyo testnet (Hideki), the app's "tokyo" region
export const CHAIN_NAME = "Somnia Tokyo testnet";
export const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
export const WS_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
export const INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql";
// Official Somnia explorer, Tokyo testnet (links in messages only; the bot never fetches them).
export const EXPLORER_TX = "https://explorer.testnet.somnia.network/tokyo/tx/";
export const EXPLORER_ADDR = "https://explorer.testnet.somnia.network/tokyo/address/";
export const APP_URL = "https://app.testnet.dreamdex.io";
/**
 * The live account this bot trades for in public (/demo), since 2026-10-29: an EOA account outside the Perps
 * Arena, holding testnet USDso bought with faucet STT; linked to the bot key with the same per-pool operator
 * grant the app's Link a bot writes.
 */
export const DEMO_ACCOUNT = "0x2A11e7388D1D2F9690f2636846d44b478f61bF08" as const;
/**
 * Scheduled demo trades: the bot opens one small position on its own demo account in each slot (UTC hours below,
 * from minute 20), with a bot-side TP/SL 0.3% away, and flattens it after 45 minutes if neither fired. One
 * position at a time, skipped below the equity floor, off after `until` or while data/demo_schedule.off exists.
 */
export const DEMO_SCHEDULE = {
  hoursUtc: [3, 11, 19], minute: 20, until: Date.parse("2026-11-02T00:00:00Z"),
  margin: 2.4, leverage: 5, tpPct: 0.3, slPct: 0.3, maxHoldMs: 45 * 60_000, minEquity: 2.8,
  markets: ["XRP", "SOL", "ETH"], tickMs: 60_000,
};
/**
 * ExitGuard (chain/src/ExitGuard.sol), deployed 2026-10-29: the implementation an account can point its code at with
 * EIP-7702 so that Somnia Reactivity fires its stop-loss with no bot. The bot only READS it (/stops, /positions), and
 * only for accounts whose code is exactly the designator for this address.
 */
export const EXITGUARD_IMPL = "0xd40f8e482bbc195e383571ddafe0a1bddbc703d9" as const;
/** Earlier demo accounts whose bot orders still count in /demo's history (Oct 20-26: 0x0e7E…3817). */
export const DEMO_HISTORY = ["0x0e7E8DF6Eac2E14165b4fA4CB2BD4e445d0E3817"] as const;

const ROOT = process.env.DDMVP_ROOT ?? "/home/agent/agent/products/dreamdex-mvp";
export const PATHS = {
  root: ROOT,
  data: process.env.DDMVP_DATA ?? `${ROOT}/data`,
  botEnv: process.env.DDMVP_BOT_ENV ?? "/home/agent/agent/secrets/ddmvp_bot.env",
  masterEnv: process.env.DDMVP_MASTER_ENV ?? "/home/agent/agent/secrets/ddmvp_master.env",
  wasm: process.env.DDMVP_WASM ?? `${ROOT}/dist/resvg.wasm`,
  fontRegular: "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  fontBold: "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  fontMono: "/usr/share/fonts/truetype/noto/NotoSansMono-Bold.ttf",
};

export const LIMITS = {
  maxUsers: 500,
  newKeysPerHour: 40,
  msgMaxLen: 300,
  cmdPerMinute: 20,
  tradesPerMinute: 6,
  tradesPerHour: 60,
  cardsPerMinute: 4,
  maxConcurrentTx: 4,
  marginMin: 1,
  marginMax: 5_000,
  defaultLiqWarnPct: 10,
  liqWarnCooldownMs: 10 * 60_000,
  lowGasStt: 0.1,
  slippageBps: 30,
  maxTouchVsMarkPct: 1.5,
  // card-copy loop
  cardCopyMaxTouchPct: 0.5,           // a copy is refused when the book is further than this from the mark
  cardCopyMaxLev: 10,                 // copies never use more leverage than this (or the market maximum)
  cardMargins: [10, 25, 50] as const, // copy sizes offered on a shared card, USDso margin
  cardsPerUser: 20,
  cardsMax: 1_000,
  cardTtlMs: 30 * 24 * 3_600_000,
  pingsPerHour: 6,                    // attribution pings to one sharer
  draftTtlMs: 600_000,                // a copy preview's Confirm button is valid for 10 minutes, once
  draftsMax: 1_000,
  draftsPerUser: 3,                   // a user's own older previews make way first, never other users'
  cardRefsMax: 5_000,                 // pruned card id -> sharer, so an old link still credits the sharer
  pendingCopyTtlMs: 24 * 3_600_000,   // a new user's tapped card waits this long for them to link
  tapsTracked: 5_000,
  // /demo and /watch
  demoPerMinute: 3,
  demoCacheMs: 15_000,
  watchesPerUser: 3,
  watchedMax: 100,                    // distinct watched addresses across all users
  watchAddsPer10Min: 5,
  watchRefreshMs: 60_000,
  watchIdleMs: 7 * 24 * 3_600_000,    // watches end after this long without a message from the watcher (they are told)
  watchUsersMax: 1_000,               // watch-only records (no key), separate from maxUsers
  watchWarnMinGapMs: 60_000,          // watched positions: once per position, again only when the distance halves
  // chain-held stops (/stops) and stop-health alerts
  stopsPerMinute: 4,
  stopsGlobalPerMinute: 60,           // all users together (each /stops = 1 indexer read + chain reads)
  stopCheckMs: 60_000,                // one stop-health pass over linked accounts per minute
  stopCheckUsersMax: 50,              // accounts per pass (each costs 1 indexer read + 1-2 chain reads per market)
  stopWarnRepeatMs: 24 * 3_600_000,   // the same warning about the same stop is sent at most once a day
  stopWarnedMax: 30,
  stopCacheMs: 15_000,                // /stops, /positions and the alert pass share one read per account per 15 s
  stopLinesPerMarket: 8,
  stopsMsgBudget: 3_200,              // characters of market sections in one /stops reply (Telegram's limit is 4,096)
  // chain-link watchdog (src/watchdog.ts): one probe every 30 s; 6 failed in a row = rebuild, 6 more = exit 75
  watchdogMs: 30_000,
  // shutdown
  shutdownDrainMs: 70_000,            // finish in-flight orders before exiting (systemd stops after 90 s)
  unresolvedTtlMs: 30 * 60_000,       // forget an unconfirmed send's marker after this long
};
