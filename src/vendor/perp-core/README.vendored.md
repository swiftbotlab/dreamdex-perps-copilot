Vendored from https://github.com/somnia-chain/dreamdex-bot-kit (packages/perp-core/src),
commit 25798660bbe4674a6f83a960b202852896e2fed4, MIT License (see LICENSE, Copyright DreamDEX S.A.).
Local change: config.ts no longer loads .env files (loadEnv is a no-op, the dotenv import is removed).
Local change (2026-10-26), operator.ts:
- `send()` labels every failure with the step that failed and throws the exported `SendError { phase, hash? }`
  (`simulate` | `send` | `wait` | `reverted`), so a caller never reports an order that was posted as "nothing was
  sent". The receipt wait has a 60 s timeout (`waitForTransactionReceipt({ hash, timeout: 60_000 })`).
- `createTradingKey()`: the wallet client's transport is `http(rpcUrl, { retryCount: 0 })` (no automatic re-post of a
  signed transaction); the public client keeps viem's default retries for reads.
