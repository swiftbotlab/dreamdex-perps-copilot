# Phase 0 research: dreamDEX perps copilot (2026-10-20, ~13:20-14:10 UTC)

All facts below were checked against the live Hideki chain (id 50383) with read-only scripts in
`scripts/probe.ts` and `scripts/probe_watch.ts`, or read from the official bot kit
(github.com/somnia-chain/dreamdex-bot-kit @ 2579866, `docs/perps.md`, `packages/perp-core`) and the
`@somnia-chain/markets-sdk` 0.31.0 / `@somnia-chain/reactivity` 0.2.1 packages.

## Network
- "Somnia Tokyo testnet" in the app = the `tokyo` region = chain **Hideki, id 50383**
  (RPC https://api.hideki2.infra.testnet.somnia.network, WS wss://.../ws, indexer
  https://hideki-dev.smk.somnia.host/v1/graphql). Gas token STT. Perps exist only here and on
  Shannon (50312); mainnet has no perp pools yet. The bot refuses any other chain id at startup.
- 21 live perp markets (BTC, ETH, SOL, HYPE, XRP, DOGE, BNB, ADA, SUI, LINK, AVAX, XLM, NEAR, WLD,
  TAO, ZEC, PUMP, 1000PEPE, VVV, LIT, ZRO), all against USDso, one shared cross-margin MarginBank
  `0x4787…1394`. Initial margin 5 % (BTC/ETH/SOL/HYPE/XRP = 20x max), 10 % (10x) or 20 % (5x).
  Minimum order is about 10 USDso notional on every market (e.g. ETH 0.004, BTC 0.00013).

## How a bot trades for a user: "Link a bot" (decision: use it)
- In the app the user opens the wallet, chooses **Link a bot**, pastes a bot address, keeps
  **Perps** ticked and presses **Add bot**. That writes an operator grant in the
  OperatorPermissionsRegistry for `placeOrderFor` / `cancelOrderFor` / `reduceOrderFor` on every
  perp pool. The bot key then sends `placeOrderFor(owner, …)`: the order, its margin and every fill
  belong to the user's account. **The key pays gas and nothing else; it cannot withdraw or move
  funds.** The app offers to send the bot some STT for gas on the same screen.
- Checked live: our key `0x2A11…bF08`, linked on Oct 19, returns `isOperatorAuthorized = true`
  for account `0x0e7E…3817` on the ETH pool.
- Limits of a linked key (from the kit docs, consistent with the chain): it cannot change the
  account's leverage cap (owner-only `setMaxLeverage`; `getPerpMaxLeverage` returns 0 = unset), it
  cannot arm on-chain stop orders (stop registry needs the account itself), and it cannot pull
  margin from the spot wallet (the user moves USDso Spot -> Perps in the app).
- **Chosen route:** every Telegram user gets their OWN freshly generated trading key (encrypted at
  rest, never shown). The user links that address with Link a bot. One key per user = one nonce
  queue per user, gas paid from that user's own top-up, and a leaked key can only trade, never
  withdraw. Rejected: a single shared operator key (one nonce queue and one gas tank for everyone)
  and asking users for their account key (custody risk, and unnecessary).

## Funds and gas
- Margin: the user's own Perps balance (Perps Arena paper USDso works; the voucher allows all 21
  markets on chain, see our feedback report 03). Our demo account `0x0e7E…3817` holds ~1,000
  paper USDso from the Week-2 Arena airdrop.
- Gas: ~0.014 STT per order at the public RPC's 6 gwei floor (feedback report 09). The app's Link
  a bot screen sends STT to the bot key; the SomniaHacks faucet bot pays Shannon STT which the app
  bridges. The copilot shows the key's STT balance and warns below 0.1 STT.

## Orders, positions, liquidation price (reads)
- Sizing: `client.getMaxPerpOrderSize` (pool's own rule; autoPull=false for trading keys), then
  align to lot/min. Market orders = IOC (`ORDER_TYPE.MARKET`) at the touch +/- 20 bps slippage.
- Close: `client.previewPerpClosePnl` gives the closable size; send the opposite IOC.
- Positions: `client.getPerpPosition({marginBank, account, pool})` (size, avgEntryPrice),
  mark from pool `tryGetMarkPrice()`, liquidation price from `client.getLiquidationPrice(...)`,
  margin/health from `client.getMarginAccount(marginBank, account)`. All take the account
  explicitly, so ONE read-only client serves every user.
- Reuse: the kit's `perp-core` (MIT) already wraps these with the trading-key path
  (`placeFor`/`cancelFor`, `sizeOrder`, `placePerp`, `closePosition`); vendored with one change
  (no .env loading).

## Somnia Reactivity: usable from Node, used for the protection loop
- Off-chain Reactivity = JSON-RPC `eth_subscribe("somnia_watch", {address, topics, eth_calls,
  context, push_changes_only})` over the WS endpoint; each push carries the matched log plus the
  `eth_call` results at the same block. Works on Hideki (no on-chain subscription, no 32 STT
  deposit needed; that is only for Solidity handlers).
- Measured 2026-10-20: subscribing to the ETH-PERP pool with `eth_calls=[pool.tryGetMarkPrice()]`
  and `push_changes_only=true` pushed ~1 mark update per second per market (30 in 30 s), each
  with the new mark already decoded from `simulationResults`. Unfiltered, the pool emits ~45
  events/s (market makers), so `push_changes_only` matters.
- Plan: one `somnia_watch` per market that has a protected position; every push re-checks TP / SL
  / liquidation distance for those users and closes positions when a trigger fires. Fallback: a
  20 s polling loop that runs only when a market's socket has been silent > 15 s.

## Product decisions
- Telegram bot (Node 22 + TypeScript bundled with esbuild, viem 2.54.1, markets-sdk 0.31.0 pinned;
  Bot API spoken directly over fetch, no bot framework). PnL card rendered from SVG with
  `@resvg/resvg-wasm` (WASM, no native code) and Noto Sans from the system.
- `/long ETH 20 5x` = 20 USDso margin at 5x = 100 USDso notional, market (IOC) order. Leverage is
  checked against the market maximum (1 / initial margin) and the account's own cap when set.
- Runs as a systemd user service inside bwrap (filesystem allowlist) with an in-process egress
  allowlist (Somnia hosts + api.telegram.org only).
