Vendored from https://github.com/somnia-chain/dreamdex-bot-kit (packages/perp-core/src),
commit 25798660bbe4674a6f83a960b202852896e2fed4, MIT License (see LICENSE, Copyright DreamDEX S.A.).
Local change: config.ts no longer loads .env files (loadEnv is a no-op, the dotenv import is removed).
Local change (2026-10-26), operator.ts:
- `send()` labels every failure with the step that failed and throws the exported `SendError { phase, hash? }`
  (`simulate` | `prepare` | `send` | `wait` | `reverted` | `decode`), so a caller never reports an order that was
  posted as "nothing was sent". The receipt wait has a 60 s timeout (`waitForTransactionReceipt({ hash, timeout: 60_000 })`).
- `send()` no longer calls `writeContract`: it reads the pending nonce (or the key's locally tracked next nonce,
  `TradingKey.nextNonce`, when higher), prepares and signs the transaction locally, hashes the signed bytes and
  then posts them with `sendRawTransaction` (never retried by viem). Every failure after the post carries the hash;
  a failure before it means nothing was posted.
- `send()` / `placeFor()` take an optional `PostLock` that serialises simulate -> post per key; the receipt wait
  runs outside it. A failed `decodePlaceOrder` is a `SendError("decode", ..., hash)`.
- `createTradingKey()`: both clients use `http(rpcUrl)` with viem's default read retries.
