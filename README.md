# Perps Copilot for dreamDEX

**Trade dreamDEX perpetuals from Telegram: one-line orders, exits that close for you, a check of the TP/SL the chain holds for you, and cards your friends can copy.**
Live on Somnia Tokyo testnet: [@SwiftPerpsBot](https://t.me/SwiftPerpsBot). Built by Swift Bot Labs for the dreamDEX Perps Builder Bounty (MVP track). Category: consumer perps, and a trader tool.

## Judges start here

**What it is.** A Telegram bot that trades your own dreamDEX perps account through a key you link with the app's Link a bot (it can place and close orders, it can never withdraw). It watches every market you hold through Somnia Reactivity, closes at your take-profit, stop-loss or liquidation guard, reads the TP/SL that dreamDEX's chain holds for you and warns when one would close only part of your position or nothing, and turns trades into cards a friend opens on their own account with one tap.

**Who it is for.** Perps traders who live in Telegram and want to act from their phone in seconds (consumer perps), and anyone who wants a second pair of eyes on an account: `/stops` and `/watch` work on any address, read only (trader tool).

**Try it in three taps, no wallet:**
1. `/demo`: the bot's own live account, its last orders with tx links, the last bot-fired exit and the live Reactivity streams.
2. `/stops 0xAnyAccount`: the dreamDEX TP/SL the chain holds for that account, each one checked against the position and the pool's closing capacity.
3. `/watch 0xAnyAccount`: liquidation pings for any account.

Then `/start`, Link a bot in the app, and `/long ETH 20 5x tp 4% sl 2%`.

<!-- evidence:headline -->
**Evidence.** 32 real orders sent by the bot, 32 verified `success` on chain, 8 of them exits the bot fired by itself, on 3 days (newest 2026-10-29 01:16 UTC); scheduled demo trades keep adding three a day until Nov 1. Latest measured time from the pushed mark crossing a TP/SL level to the confirmed close: 3.4 s.
<!-- /evidence:headline -->
- Evidence page (every order re-read from its receipt, the chain-held stop check run step by step): **https://swiftbotlab.github.io/dreamdex-perps-copilot/**
- Order table: [evidence/orders.md](evidence/orders.md) · [CSV](evidence/orders.csv) · [JSON](evidence/orders.json)
- Demo video (112 s, YouTube): https://youtu.be/rWLEHY_x_j4 (recorded 2026-10-20: orders, a bot-fired stop-loss, a liquidation alert, `/card`; also as [demo.mp4 on the v1.0.0 release](https://github.com/swiftbotlab/dreamdex-perps-copilot/releases/download/v1.0.0/demo.mp4))

| Judging criterion | Where to look |
|---|---|
| MVP potential: user value, scope, repeat-use loop, execution | [Two layers of protection](#two-layers-of-protection), [Loops](#loops), [Reliability](#reliability), [Architecture](#architecture), 130 tests |
| Evidence of building: live orders, tx hashes, repo, demo | [Evidence page](https://swiftbotlab.github.io/dreamdex-perps-copilot/), [Evidence](#evidence-real-orders-on-somnia-tokyo-testnet), the video |
| Communication: X posts | [X posts](#x-posts) |

## Two layers of protection

A stop is only as alive as whatever holds it. dreamDEX already holds TP/SL on chain: each market's stop registry wakes every pending stop and fires it with no bot at all. Perps Copilot builds on that instead of replacing it.

1. **Chain-held (dreamDEX's own TP/SL).** `/stops` reads every pending stop from its registry and checks it: resting orders on the closing side that cut a stop to part of the position or to nothing (the registry sizes a fired stop to the pool's reducing capacity, and a stop below the minimum size is dropped), a size fixed at arming that no longer covers a grown position, a stop on the wrong side or with no position left, a linked pair whose partial fill cancels the other leg. Linked users get the warning unprompted within a minute, and a note when a chain-held stop fired, was dropped or was cancelled by its partner. `/positions` shows both layers side by side.
2. **Bot-side (fast second layer).** `/tp`, `/sl` and `/guard`: the bot follows every market you hold through Somnia Reactivity (`somnia_watch` with `tryGetMarkPrice()` evaluated at the pushed block) and closes the position when a level is reached. A take-profit exits with an order capped at the TP price, so it never fills worse than the level. This layer runs while the bot runs; the chain-held layer does not need it.

Live run on 2026-10-29 (account `0x2A11…bF08`, every step on the [evidence page](https://swiftbotlab.github.io/dreamdex-perps-copilot/)): a linked TP/SL bracket was armed on an XRP-PERP long, `/stops` showed both legs OK; then a post-only sell of 7 XRP was rested 20 % above the market, and 5 s later `/stops` said *"will close NOTHING when it fires. Your resting sell orders on XRP-PERP (7 XRP) use up the position's closing capacity, so the stop is dropped (ReduceOnlyBelowMinQty)"*. The same warning arrived unprompted 56 s after the order. Cancelling the order restored both legs.

## What it does

- **Market orders in one line.** `/long ETH 20 5x` opens a 100 USDso ETH-PERP long (20 USDso margin at 5x) as a real order on dreamDEX. `/short`, `/close ETH`, `/close ETH 50%` work the same way. Every reply carries the transaction hash.
- **Positions with PnL and both stop layers.** `/positions` shows size, entry, mark, unrealised PnL, return on margin, the liquidation price and distance, the chain-held TP/SL with their health, and the bot-side exits.
- **Chain-held stops, checked.** `/stops` (or `/stops 0x…` for any account) mirrors dreamDEX's own TP/SL and says, per stop, how much it will really close when it fires. Unprompted warnings once a day per stop and problem.
- **Exits that act.** `/tp ETH 4%`, `/sl ETH 2300`, or inline: `/short BTC 15 10x tp 3% sl 1.5%`. Closed through Somnia Reactivity pushes; a take-profit never fills worse than its level.
- **Liquidation alerts, and a guard.** A warning with *Close 50%* / *Close all* buttons when the mark comes within your distance of the liquidation price (`/alerts 10`). `/guard 3` closes the position for you when it gets within 3 %.
- **Cards friends can copy.** `/card` renders an image of the trade (with a mark-price sparkline). Forward it anywhere: **Copy this trade** opens a landing with the trade, the mark now and the move since entry, then a 10 / 25 / 50 USDso preview and a single-use Confirm (optionally with a 3 % stop-loss). The copy is a one-time order on the copier's own account, never filled more than 0.5 % from the mark.
- **Watch any account.** `/watch 0x…` warns once when a position on that account nears liquidation (again only if it gets twice as close) and says when a warned position is gone. Every alert offers **Guard it: link this account**.
- **A demo for anyone.** `/demo` shows the bot's own live account and its recent orders before you link anything.

## Loops

- **Copy loop.** Trade, `/card`, forward. A friend taps **Copy this trade**: a new user's tapped card waits through onboarding and comes back right after they link. The sharer gets a short attribution ping (at most 6 an hour) and `/invite` counts the taps, new users and copies of their cards. The landing never shows the sharer's account or Telegram identity.
- **Watch loop.** `/watch` and `/stops` work for any account with no link. Each liquidation alert offers to link the account so that `/guard` can act, not only warn.
- **Repeat use.** Exits, liquidation alerts and stop-health warnings bring the trader back on every move, and on every change to their orders that silently breaks a stop.

### Share-link flow, step by step (what is on-chain and what is bot-side)

1. `/card` (bot-side): the bot renders the PNG and stores a card record (market, side, leverage, entry, exit or mark). The link `t.me/SwiftPerpsBot?start=c_<id>` is on the **Copy this trade** button, in the caption and printed on the image.
2. Forward (Telegram): the card can go to any chat or group; the bot does not need to be in it. Checked live on 2026-10-26: a card forwarded to Saved Messages kept its **Copy this trade** URL button with the same link.
3. Tap (bot-side): the landing shows the trade, the mark now and the move since entry. A user who has not linked yet goes through `/start` first, and the card comes back right after the link.
4. Margin button, then preview (bot-side, nothing sent): 10 / 25 / 50 USDso, leverage capped at 10x and at the market maximum, and a single-use draft that expires after 10 minutes.
5. Confirm (on-chain): one `placeOrderFor(copierAccount, ...)` immediate-or-cancel order on the perp pool, sent by the copier's own linked bot key, with the limit price at most 0.5 % from the mark. This is the only step that touches the chain.
6. After the fill (bot-side): an optional 3 % stop-loss watched through Somnia Reactivity, the sharer's attribution ping, and the counts in `/invite`.


## How the bot gets permission to trade (no custody)

You never give the bot your wallet. On `/start` the bot generates a **personal bot key** for you and shows only its address. You link that address in the dreamDEX app:

1. app.testnet.dreamdex.io, open the wallet, **Link a bot**.
2. Paste the bot address, keep **Perps** ticked, press **Add bot** (the app offers to send it 5 STT for gas).
3. Press **I've linked it** in Telegram. The bot finds your account from the on-chain grant and checks which markets it covers.

"Link a bot" writes an operator grant for `placeOrderFor`, `cancelOrderFor` and `reduceOrderFor` on each perp pool. From then on every order the bot sends is `placeOrderFor(yourAccount, ...)`: the order, its margin and its fills are yours. **The key pays gas and nothing else. It cannot withdraw or move funds**, and you can remove it in the app at any time.

![Link a bot in the dreamDEX app](evidence/link_a_bot_form.png)

## Commands

| Command | What it does |
|---|---|
| `/demo` | A live account run by this bot: equity, positions, last orders with tx links, live streams, chain link. No wallet needed |
| `/stops` / `/stops 0x…` | The dreamDEX TP/SL the chain holds for your account (or any account, read only), each checked against the position and the pool's closing capacity |
| `/watch 0x…` / `/unwatch` | Liquidation pings for any account, read only (up to 3; they end after 7 days without a message from you) |
| `/start` | Onboarding, your bot key, the Link a bot steps |
| `/long ETH 20 5x` / `/short BTC 15 10x` | Market order: margin in USDso x leverage; optional `tp 4% sl 2%` or absolute prices |
| `/close ETH` / `/close ETH 50%` | Close all or part of a position |
| `/positions` | Positions, PnL, liquidation price and distance, chain-held and bot-side exits |
| `/tp ETH 2500`, `/sl ETH 2%`, `/tp ETH off` | Bot-side take-profit / stop-loss |
| `/alerts 10`, `/guard 3`, `/guard off` | Liquidation warning distance; auto-close distance |
| `/card [ETH]` | PnL card image with a **Copy this trade** link |
| `/invite` | Your invite link, who joined through it, and your cards' taps / new users / copies (30 days) |
| `/markets`, `/status`, `/key` | Marks and max leverage, account + gas + live streams + chain link, your bot key |

Leverage: the venue sets margin per market (5 %, 10 % or 20 % initial margin, i.e. 20x / 10x / 5x max), and the account's own cap is owner-only. The bot treats `5x` as sizing (notional = margin x leverage), checks it against the market maximum and the account cap, and asks the pool (`getMaxPerpOrderSize`) whether the account can take the size before anything is sent.

## Somnia Reactivity (how the bot-side exits are watched)

For every market that a user holds, the bot opens one `eth_subscribe("somnia_watch", ...)` subscription on the perp pool with `eth_calls = [pool.tryGetMarkPrice()]` and `push_changes_only = true`. The chain pushes the new mark, already evaluated at the same block, on each pool event that changes the mark, and each push re-checks the take-profit, stop-loss and liquidation distance of the users in that market. Since 2026-10-29 every bot exit logs the time of the push that triggered it, and `/demo` and the evidence page show the time from that push to the confirmed close (first measured: 3.4 s, an XRP-PERP stop-loss).

Fallback: if a market's stream is silent for 15 s the bot reads the mark over HTTP every 5 s, and re-subscribes after 90 s of silence. Watched accounts (`/watch`) ride on the same streams.

## Reliability

- **Self-healing chain link.** On 2026-10-27 the WebSocket client the SDK reads with stopped reconnecting (viem gives up after 5 tries and keeps the dead socket cached by URL), and every account read failed for about 28 hours while the process looked healthy. Now a watchdog probes the chain every 30 s: 6 failed checks in a row close the cached sockets, rebuild the client and re-subscribe the push streams; 6 more stop the bot so systemd restarts it (`Restart=always`, growing delays up to 5 min, no start limit). `/status` and `/demo` show when the link was last verified. `test/watchdog.test.ts` reproduces the failure with the real SDK and a local WebSocket server (still dead after the server returns) and shows the rebuild heals it.
- **Scheduled demo trades.** Three times a day (03:20, 11:20, 19:20 UTC, until 2026-11-01) the bot opens one 12 USDso position on its demo account with a bot-side TP/SL 0.3 % away and flattens it after 45 minutes if neither fired. One position at a time, an equity floor, an off switch, tagged "scheduled demo trade". They go through the same open, Reactivity exit and close paths as a user's order and keep the evidence fresh.
- **Sends you can trust.** Each order is signed in the bot and its hash is known before it is posted; failures are labelled by the step that failed, an order that may have reached the chain is never reported as "nothing was sent" and never resent automatically.
- **One instance, clean restarts.** A heartbeat lock refuses a second copy; on a restart the bot finishes orders in flight (at most 70 s) before releasing it.

## Evidence (real orders on Somnia Tokyo testnet)

All orders were placed **by the bot**, through a bot key linked to the account with dreamDEX's operator grant (the one the app's Link a bot writes), each a `placeOrderFor(account, ...)` immediate-or-cancel order on a perp pool. `scripts/evidence.ts` re-reads every one from its receipt (status, sender = the linked bot key, the `placeOrderFor` account) and writes [evidence/orders.md](evidence/orders.md), [CSV](evidence/orders.csv) and [JSON](evidence/orders.json); `scripts/evidence_page.ts` builds the [evidence page](https://swiftbotlab.github.io/dreamdex-perps-copilot/) from them.

Accounts: from 2026-10-29 the demo account is `0x2A11e7388D1D2F9690f2636846d44b478f61bF08`, an account outside the Perps Arena holding testnet USDso bought with faucet STT. The orders of 2026-10-20 and 2026-10-26 went to the earlier demo account `0x0e7E8DF6Eac2E14165b4fA4CB2BD4e445d0E3817` (paper USDso from its own airdrop); `/demo` counts both.

<!-- evidence:summary -->
32 orders (16 opens, 16 closes), 32/32 verified `success`: 24 on 2026-10-20, 4 on 2026-10-26, 4 on 2026-10-29. 8 closes were fired by the bot itself (take-profit, stop-loss or guard). All of them are on our own demo accounts; the bot has had no outside users yet. Generated 2026-10-29 01:25 UTC.
<!-- /evidence:summary -->

<!-- evidence:latest -->
Newest 10 (all 32 in [evidence/orders.md](evidence/orders.md)):

| UTC | action | market | filled | avg price | tx | status | trigger to close |
|---|---|---|---|---|---|---|---|
| 10-29 01:16 | close | XRP-PERP short | 9.1 | 1.3173 | [`0x2e6d136d…`](https://explorer.testnet.somnia.network/tokyo/tx/0x2e6d136d76c96a6ee7e79d711d0fb7cfab8c8cea9b8dc3c764c1a3ffae275c79) | success |  |
| 10-29 01:05 | open | XRP-PERP long | 9.1 | 1.3183 | [`0x4f70e96e…`](https://explorer.testnet.somnia.network/tokyo/tx/0x4f70e96e3db40293c1f44a96c516ab1ef9f72b07c396047766da437416fb424a) | success |  |
| 10-29 01:03 | close, stop-loss (bot) | XRP-PERP short | 9 | 1.3168 | [`0x4c443a40…`](https://explorer.testnet.somnia.network/tokyo/tx/0x4c443a40c1bf3cecb975e6a2bc6c29ee57238f36f7a1af87da46d3ef586f91b8) | success | 3.4 s |
| 10-29 00:53 | open | XRP-PERP long | 9 | 1.3209 | [`0x94302cd2…`](https://explorer.testnet.somnia.network/tokyo/tx/0x94302cd24d488b972634c6e3a98fc84f5da6c6fab4be4c3b22a93cc53a7bb775) | success |  |
| 10-26 02:18 | close, stop-loss (bot) | SOL-PERP short | 0.49 | 101.08 | [`0xae8c3ae7…`](https://explorer.testnet.somnia.network/tokyo/tx/0xae8c3ae7369b11bf307cc046a882f4071efae94fc0763fa987e454e0c31e0867) | success |  |
| 10-26 02:18 | open | SOL-PERP long | 0.49 | 101.14 | [`0xd08da31b…`](https://explorer.testnet.somnia.network/tokyo/tx/0xd08da31b0a328b6e9eb84817a99ef74b1e8431471737e3835d91b5dac403dee5) | success |  |
| 10-26 02:18 | close | ETH-PERP short | 0.0432 | 2311.33 | [`0x74ff2f03…`](https://explorer.testnet.somnia.network/tokyo/tx/0x74ff2f03338caa120fddfc49cf11425ea589d7ff5d1f08dd28cf565d7d012969) | success |  |
| 10-26 02:14 | open, card copy | ETH-PERP long | 0.0432 | 2309.53 | [`0x887ca266…`](https://explorer.testnet.somnia.network/tokyo/tx/0x887ca26690b163b68f7b9066c41a015152c05aab9646c91acd28cc5b97b0dbd7) | success |  |
| 10-20 14:19 | close | ETH-PERP short | 1.6271 | 2460.91 | [`0x53f1f7f7…`](https://explorer.testnet.somnia.network/tokyo/tx/0x53f1f7f7f5efbe2fecfab50c4cfc9e24cff200bc7eb7c92dc1d818824897b9b5) | success |  |
| 10-20 14:19 | open | ETH-PERP long | 1.6271 | 2458.218 | [`0x426548fd…`](https://explorer.testnet.somnia.network/tokyo/tx/0x426548fd875ff6c74f82b5c18bc1835170d0bc35d1af94d92295e0abb42d15dc) | success |  |
<!-- /evidence:latest -->

### Card copy evidence (live, 2026-10-26)

The first orders of this build, sent right after the restart that put the card-copy loop and `/watch` live. Same demo account and bot key as above, testnet only. The card copy is **our own card run back** on our own account (no second user yet); it went through the same landing, preview and single-use Confirm that any copier gets.

| UTC | step | tx | block | result |
|---|---|---|---|---|
| 02:14:00 | `/card` on the last closed trade (ETH-PERP long 10x, closed 10-20 at +4.38 USDso) | - (bot-side) | - | card `c_dd6869a3a6` with **Copy this trade** |
| 02:14:13 | `/start c_dd6869a3a6`, then **10 USDso** | - (bot-side) | - | preview: 10 x 10x = 100 USDso, fills only within 0.5 % of the mark |
| 02:14:47 | **Confirm + SL 3%**: copy open, ETH-PERP long 0.0432 @ 2,309.53 | [`0x887ca26690b163b68f7b9066c41a015152c05aab9646c91acd28cc5b97b0dbd7`](https://explorer.testnet.somnia.network/tokyo/tx/0x887ca26690b163b68f7b9066c41a015152c05aab9646c91acd28cc5b97b0dbd7) | 33287448 | success, `via card`; stop-loss 2,240.24 watched |
| 02:15:06 | the same Confirm button pressed again | - | - | refused: "expired or was already used", nothing sent |
| 02:16:48 | `/watch` a public third-party account (read only) | - | - | real alert: "BTC-PERP long, mark 79,685.59 is 2.6% from liquidation 77,588.70" at the default 10 % warning |
| 02:17:27 | the card forwarded to Saved Messages | - | - | the **Copy this trade** URL button survived the forward |
| 02:18:07 | `/close ETH` | [`0x74ff2f03338caa120fddfc49cf11425ea589d7ff5d1f08dd28cf565d7d012969`](https://explorer.testnet.somnia.network/tokyo/tx/0x74ff2f03338caa120fddfc49cf11425ea589d7ff5d1f08dd28cf565d7d012969) | 33289448 | success, closed 0.0432 @ 2,311.33 |
| 02:18:36 | `/long SOL 10 5x tp 0.15% sl 0.15%` (tight levels chosen so an exit fires quickly) | [`0xd08da31b0a328b6e9eb84817a99ef74b1e8431471737e3835d91b5dac403dee5`](https://explorer.testnet.somnia.network/tokyo/tx/0xd08da31b0a328b6e9eb84817a99ef74b1e8431471737e3835d91b5dac403dee5) | 33289744 | success, long 0.49 @ 101.14 |
| 02:18:41 | stop-loss 100.988 reached (mark 100.982), closed by the bot | [`0xae8c3ae7369b11bf307cc046a882f4071efae94fc0763fa987e454e0c31e0867`](https://explorer.testnet.somnia.network/tokyo/tx/0xae8c3ae7369b11bf307cc046a882f4071efae94fc0763fa987e454e0c31e0867) | 33289789 | success, closed 0.49 @ 101.08 |

These four orders are also the first live run of the hardened send path (signed in the bot, hash known before posting, one post per key at a time).


## What other builders can take from this

- **Marks without polling:** `eth_subscribe("somnia_watch", { address: [pool], eth_calls: [{ to: pool, data: tryGetMarkPrice() }], push_changes_only: true })` delivers the mark evaluated at the pushed block. Keep an HTTP fallback for silent streams.
- **A stop is worth what the pool lets it close:** read `PerpPool.getReducingCapacity(owner)` before trusting a TP/SL; resting orders on the closing side shrink it, and a fired stop below the pool minimum places nothing.
- **viem WebSockets can die quietly:** after 5 failed reconnects the dead socket stays cached by URL, so a new client for the same URL gets it back. Probe it and close the cached socket (or restart) instead.
- **Know how far the indexer is behind:** `getIndexerFreshness` gives the lag (we saw 151 s); for state you act on, read the registry or pool, or the contract's own logs.
- **Never resend blind:** sign locally, know the hash before posting, label failures by the step that failed, and block new orders on that account and market until the chain says the old one is mined or gone.

## Mainnet plan

- The bot is testnet-only by design: it asserts chain id 50383 at startup. Mainnet becomes one reviewed config (chain id, RPC/WebSocket, indexer, registry addresses from dreamDEX's published list) behind an explicit switch that refuses to start otherwise.
- Day one on mainnet: the read-only features (`/stops`, `/watch`, `/demo`), which need no keys and carry no risk to users' funds.
- Orders: the same Link a bot permission (place and close, never withdraw), with lower caps at launch (margin and leverage) and scheduled canary trades on our own funded account for 48 hours before orders open to everyone, within the 30 days after dreamDEX perps go live on mainnet.
- Revenue later, without custody: the builder fee that `placeOrderFor` already carries (`builder`, `builderFeeBpsTimes1k`).

## X posts

Posts about Perps Copilot that tag @DreamDEXSomnia:

1. Proof clip: a stop-loss closed by the bot through Somnia Reactivity, then `/card` (2026-10-21): https://x.com/swiftbotlab/status/2112695927035371609
2. Launch, with a real PnL card from a closed testnet trade (2026-10-20): https://x.com/swiftbotlab/status/2112551079061889196
3. `/watch`: read-only liquidation pings for any dreamDEX account, first live alert on Tokyo testnet (2026-10-26): https://x.com/swiftbotlab/status/2114544266550911233

## Run it yourself

Requirements: Node 22, a Telegram bot token, Linux with `bwrap` for the jail (optional for local runs).

```bash
git clone https://github.com/swiftbotlab/dreamdex-perps-copilot && cd dreamdex-perps-copilot
npm ci --ignore-scripts
npm test                      # 130 tests: parsing, key vault, card, protection, close races, send outcomes, card copies, /watch, /demo, /stops, watchdog, schedule, /try
npm run build                 # bundles dist/bot.mjs + dist/resvg.wasm

# secrets live outside the repo, one KEY=VALUE per line, chmod 600
printf 'BOT_TOKEN=123:abc\n' > ~/secrets/ddmvp_bot.env
printf 'DDMVP_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" > ~/secrets/ddmvp_master.env
chmod 600 ~/secrets/*.env

DDMVP_ROOT=$PWD DDMVP_BOT_ENV=~/secrets/ddmvp_bot.env DDMVP_MASTER_ENV=~/secrets/ddmvp_master.env \
  node --require ./ops/guard.cjs dist/bot.mjs
```

Production runs it as a systemd user service inside a bubblewrap jail: `ops/ddmvp.service` -> `ops/run_sandboxed.sh bot`. See [SECURITY.md](SECURITY.md).

## Architecture

```
Telegram  <-- long polling (Bot API over fetch) -->  src/bot.ts   commands, buttons, per-user queues + rate limits
                                                        |
           src/parse.ts  every user token validated     |  src/keys.ts   per-user bot keys, AES-256-GCM at rest
                                                        v
                                                   src/venue.ts   one read client for everyone (markets-sdk 0.31.0)
                                                        |          + per-user trading key: placeOrderFor(owner, ...)
                                                        v
 Somnia Tokyo testnet (Hideki, chain 50383): perp pools, MarginBank, PerpStopOrderRegistry, OperatorPermissionsRegistry
                                                        ^
                                                   src/protect.ts  somnia_watch mark pushes -> TP / SL / guard / warnings
                                                   src/stops.ts    chain-held TP/SL health (reducing capacity, size, side, pairs)
                                                   src/watchdog.ts chain-link probe -> rebuild -> exit for systemd
                                                   src/card.ts     SVG -> PNG with resvg (WebAssembly)
                                                   src/locks.ts    per account+market and per bot key locks
                                                   src/instance.ts single-instance heartbeat lock
```

- Testnet only: the bot asserts chain id 50383 at startup and refuses anything else.
- Reads (positions, mark, liquidation price, margin, max order size, close preview, stops, reducing capacity) take the account explicitly, so one client serves all users. Stop rows from the indexer are untrusted: only rows of a known market's own registry and of that owner are kept, and each is confirmed by a registry read.
- Writes use the trading-key helpers from the official dreamDEX bot kit (`src/vendor/perp-core`, MIT; local changes listed in [its README](src/vendor/perp-core/README.vendored.md)).
- Market orders are immediate-or-cancel at the touch +/- 30 bps, refused when the book is more than 1.5 % from the mark. Card copies are refused beyond 0.5 % and never fill further than 0.5 % from the mark.
- Security notes, the jail (bubblewrap + an egress allowlist) and the probes that prove it: [SECURITY.md](SECURITY.md).

## Roadmap

- `/follow` copy mode: designed, not shipped. Each copied position must first be tracked from chain events.
- Arm and cancel chain-held TP/SL from the chat for accounts whose own key the user controls (a linked bot key cannot arm them; the account must).
- Resting limit orders, group mode for trading clubs, and mainnet (plan above).

## Disclaimer

Testnet software for testnet USDso. Not financial advice. Swift Bot Labs is not affiliated with dreamDEX or Somnia.
