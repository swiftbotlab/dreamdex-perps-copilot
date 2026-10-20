// Fixed configuration. Testnet only: the chain id is asserted at startup and nothing else is accepted.
export const CHAIN_ID = 50383; // Somnia Tokyo testnet (Hideki), the app's "tokyo" region
export const CHAIN_NAME = "Somnia Tokyo testnet";
export const RPC_URL = "https://api.hideki2.infra.testnet.somnia.network";
export const WS_URL = "wss://api.hideki2.infra.testnet.somnia.network/ws";
export const INDEXER_URL = "https://hideki-dev.smk.somnia.host/v1/graphql";
export const EXPLORER_TX = "https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/";
export const EXPLORER_ADDR = "https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/address/";
export const APP_URL = "https://app.testnet.dreamdex.io";

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
};
