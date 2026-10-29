# Security notes: Perps Copilot

## What the bot can and cannot do with your account
- It holds one **bot key per Telegram user**, generated on `/start`. The key only gets power when the
  user links it in the dreamDEX app (Link a bot), which grants `placeOrderFor`, `cancelOrderFor` and
  `reduceOrderFor` on the perp pools. It cannot withdraw, transfer, change leverage caps or arm stop
  orders. Revoking: remove the bot in the app.
- The key pays its own gas (STT the user or the app sends it). A stolen key cannot withdraw, but it
  is not harmless: it can place any order for the account, including resting limit orders at bad
  prices that a thief fills from their own account, which moves margin to the thief. So the keys are
  encrypted at rest (below), the bot itself only ever sends immediate-or-cancel orders near the touch,
  and on testnet the funds are paper USDso. Remove the bot in the app to revoke a key.

## Keys and secrets
- Private keys are generated in-process (viem `generatePrivateKey`) and stored only encrypted:
  AES-256-GCM, key derived with HKDF-SHA256 from a 32-byte master secret, the Telegram user id bound
  in as AAD (a ciphertext moved to another user's record does not decrypt). They are never shown,
  logged or sent anywhere; users only ever see the address.
- The bot token and the master secret live outside the repo in two `chmod 600` files read at startup.
  The data file (`data/users.json`) is `0600` in a `0700` directory and holds no plaintext keys.

## Untrusted input
- Untrusted input: Telegram text and button data, plus what the indexer and RPC return. Every
  Telegram token goes through `src/parse.ts`: symbols must match
  `[A-Z0-9]{1,12}` and a live market, numbers are plain decimals with bounded size and decimals
  (no exponent, hex, sign, NaN/Infinity), addresses must be 40-hex, messages over 300 chars are
  refused, private chats only (messages and buttons; replies go to the user's own chat). Button
  payloads are re-validated with strict regexes. Market rows from the indexer are kept only when the
  symbol matches `[A-Z0-9]{1,12}-PERP` and the pool / margin-bank are 40-hex addresses.
- Linking: the bot finds the account from the on-chain Link a bot grant. Grants are public, so if more
  than one account granted the same bot key it never guesses and asks for `/link <full address>`;
  the linked account is shown in full.
- Nothing user-supplied reaches a shell, `eval`, a file path, a SQL/GraphQL query or the PnL card
  SVG unvalidated; the card refuses any text that is not a validated symbol, bot name or hex code.
- Rate limits per user, checked before anything is queued: 20 commands/min, at most 5 updates
  waiting per user, 6 orders/min, 60 orders/hour, 4 cards/min, 3 link checks/min (15/hour, results
  cached 60 s), 3 `/demo` per minute (its data cached 15 s), 5 `/watch` adds per 10 minutes, at most 6
  card attribution pings per sharer per hour. At most 4 user-initiated transactions in flight, 50 waiting; auto-closes use their own
  2 slots so they never queue behind other users' opens. New keys: at most 40 per hour and 500 users;
  users who never link are forgotten after 48 h.
- Orders are bounded: margin 1-5,000 USDso, leverage within the market maximum and the account cap,
  size accepted only if the pool says the account can take it, IOC price limited to the touch +/- 30 bps,
  refused when the book is more than 1.5 % away from the mark.
- No accidental flips: opens and closes of the same account + market run under one lock. A close
  re-reads the position inside that lock, sizes from the fresh read (capped at the position), and is
  refused if the side differs from the side an exit was set for (that exit is then cleared) or if a
  close of the same position landed in the last 20 s and the chain read has not caught up. An open on
  the opposite side of an existing position is refused. Tested in `test/bot.test.ts`, with a positive
  control (the same tests fail with the lock removed).

## Card copies
- A copy is always confirmed by the copier: **Copy this trade** -> pick 10 / 25 / 50 USDso -> a preview ->
  **Confirm**. The preview button (`cm:`) sends nothing, so replaying it is harmless. The preview stores a
  server-side draft under a random 12-hex nonce, bound to the copier's Telegram id and linked account,
  valid 10 minutes and usable **once**: it is taken out before anything else runs, so a double tap or a
  retry never sends a second order. At most 3 drafts per user (a user's own older ones make way) and
  1,000 in total are held, in memory only.
- The copy reuses the normal open path (same per account+market lock, account leverage cap, gas check,
  no flips, minimum size) with a tighter touch limit: refused when the book is more than **0.5 %** from
  the mark, and the IOC limit itself is capped at the mark +/- 0.5 %, so a sharer who stacks the book
  cannot fill a copier further away than the preview says. Leverage is the card's, capped at 10x and the
  market maximum (3x when the card has none), and the cap is stated in the preview.
- "Confirm + SL 3%" on a copy that adds to a position keeps the user's own stop-loss when it is tighter
  (the preview says so). The preview states that the copy is a one-time order that does not follow
  the sharer's exits.
- A card landing shows the trade only (market, side, leverage, entry, exit or mark, PnL). It never shows
  the sharer's account or Telegram identity. Card ids are 10 random hex characters; cards expire after
  30 days. A new `/card` for the same trade reuses its card. Per user, beyond 20 cards the oldest ones
  nobody tapped or copied go first; 1,000 cards in total. A pruned card's id keeps only its sharer's share
  code (at most 5,000 kept), so a late tap gets "That shared trade has expired" and still credits the
  sharer. Card payloads are validated as `[rc]_[0-9a-f]{10}`.
- Attribution pings to a sharer are rate limited (6/hour) and stop when Telegram reports the user
  blocked the bot; any later message from that user resumes them.

## Watch mode (`/watch`)
- Read only: no key, no link, nothing is ever sent for a watched account. It reads public chain state
  (the account's positions every 60 s, in sequence) and the mark pushes the bot already receives.
- Watch-only users get a record with **no bot key** (a key is made only on `/start`, within the normal
  sign-up caps and the 40-keys-per-hour quota). The address is validated before any record is made, and
  `/unwatch` from a stranger makes none. Watch-only records are capped at 1,000, separately from the 500
  users with keys.
- Caps: 3 accounts per user, 100 distinct watched accounts in total, 5 adds per 10 minutes. Addresses
  must be 40-hex (checksummed by the bot); the zero address is refused. An account watched only by its
  own linked user is not read twice (its regular warnings cover it).
- Watches end after 7 days without a message or button press from the watcher (they are told, and
  can `/watch` again). The slots free up and the record is then pruned like any unlinked user, so the
  100-address cap cannot be filled for good. Alerts for a watched position come once, again only when
  the distance to liquidation has halved, after it left the zone (2x the warning distance) and came
  back, or after the position changed size.

## Chain-held stops (`/stops`) and stop-health alerts
- Read only: `/stops` and the alert pass never send a transaction and hold no key for the accounts they
  read; a linked bot key cannot arm or cancel dreamDEX stops anyway (only the account can).
- Indexer rows are untrusted. A stop is kept only when its registry is the known market's own stop
  registry and its owner is the account asked about, with well-formed numbers; every one is then read
  from its registry (one chain batch), and that read is what the bot shows. Ids found in the registries'
  own `PendingOrderCreated` logs (stops newer than the indexer) are collected only for linked accounts,
  confirmed the same way, and shown only to that account's own user. Drop and cancel reasons map to
  fixed text; raw indexer strings never reach a message.
- Limits: 4 `/stops` per user per minute; lookups of other accounts also share a global 60 per minute;
  one read per account per 15 s is shared by `/stops`, `/positions` and the alert pass; one `getLogs`
  per pass for all linked accounts (at most 50, rotating); a reply keeps whole market sections under
  Telegram's limit; a warning about the same stop and problem is sent at most once a day, and only
  marked as sent once Telegram accepted it.

## Chain-fired stop (ExitGuard: EIP-7702 + Somnia Reactivity)
`chain/src/ExitGuard.sol` (version 3) is a small contract an account points its own code at with one EIP-7702
transaction. The account then arms a stop on itself; Somnia Reactivity wakes the account every `intervalMs` (a
one-shot `Schedule` it renews on every wake) and at every epoch, and when the mark crosses the level the account
closes its own position. Used on the bot's own demo account only; the bot never holds that account's key and only
READS the stop (`/stops`, `/positions`), and only for an account whose code is exactly the designator for our
implementation address (`EXITGUARD_IMPL` in `src/config.ts`).

What the code can do, and nothing else: one order on the opposite side of the account's own position on the armed
pool, sized from the position read in the same transaction (never more than it), immediate-or-cancel, with a limit
at most `slippageBps` (1-500) from the mark it checked; create and remove the account's own subscriptions (the
schedule and the heartbeat). No arbitrary calls, no approvals, no transfers, no withdrawals, no initializer, no
upgrade hook.

| threat | what stops it | test |
|---|---|---|
| A stranger arms, disarms or re-arms the stop | `arm` / `disarm` only run for `msg.sender == address(this)` (the account calling itself) | `test_arm_onlySelf` |
| A stranger calls `onEvent` to fire it | only the precompile `0x0100` may call it | `test_onEvent_auth` |
| Someone creates their own subscription pointing at the account, to burn its check budget or fork its schedule | a wake counts only when `tx.origin` is the account (a reactive call runs with `tx.origin` = the subscription owner) | `test_onEvent_auth` |
| Spam that makes it check (and pay) more often | it wakes only on its own system subscriptions (Schedule, EpochTick); logs from any other emitter are ignored; one check per block; spend caps (`maxChecks` <= 1,000,000, expiry <= 7 days) | `test_only_system_wakeups_count`, `test_one_check_per_block_but_the_schedule_still_renews`, `test_expiry_and_budget_end_the_stop` |
| The schedule forks into several chains (more wakes, more cost) or dies | only a wake at or after the booked time renews it and the used one-shot is removed; an earlier, stray wake only checks; if a renewal fails (e.g. under 32 STT) the epoch heartbeat keeps checking and books it again | `test_each_wake_books_the_next`, `test_stray_wake_checks_but_does_not_fork_the_schedule`, `test_heartbeat_restarts_a_dead_schedule`, `test_used_schedule_is_removed_and_a_failed_removal_does_not_stop_renewal` |
| The close adds to or flips the position | size read in the same transaction, opposite side only, quantity <= the position (rounded down to the lot); a position closed or flipped elsewhere ends the stop with no order | fuzz `testFuzz_close_is_reduce_only_and_bounded`, `test_position_closed_or_flipped_elsewhere_sends_nothing` |
| A bad fill on a thin or stacked book | the limit is at most `slippageBps` from the checked mark, rounded toward the safe side of the tick; arming refuses a slippage below one tick | fuzz test, `test_stopLoss_long_closes_whole_position`, `test_arm_validation` |
| An empty book or a reverting close | caught; up to 3 attempts on later wakes, then the stop ends (`CloseFailed` / `Disarmed` events); a partial fill keeps it armed for the rest | `test_reverting_close_retries_then_gives_up`, `test_partial_fill_keeps_the_rest_armed` |
| A fake pool | only the owner picks the pool; it must have code, report the dreamDEX MarginBank, and hold a position of the account in that MarginBank; even then it could only waste gas (the account grants nothing) | `test_arm_validation` |
| Re-entry from the pool during the close | no privileged entry is reachable from the pool (`onlySelf`, precompile check); the stop is cleared before its subscriptions are removed | `test_reentry_from_the_pool_cannot_arm_disarm_or_fire` |
| Storage clash with another delegate | ERC-7201 namespaced storage in the account | `test_storage_lives_in_the_account_not_the_implementation` |
| Initialisation front-running (a known EIP-7702 pitfall) | there is no initializer; nothing to initialise | - |
| Authorization replay on another chain | the authorization is signed for chain 50383 only | live tx |
| The account can no longer receive STT | `receive()` accepts it (faucet, refunds of dreamDEX stop fees); unknown calls revert | `test_receive_still_works` |
| A failed unsubscribe leaves a subscription calling | the stop is cleared first, the failure is reported in `Disarmed`, and a late call is a no-op; the key can remove a subscription directly at the precompile | `test_unsubscribe_failure_still_clears_the_stop` |

Operational limits and residual risks:
- The account pays every wake: measured on testnet about 0.0026 STT (the check, booking the next wake, removing
  the used one), ~1.8 STT an hour at 5 s. It must hold 32 STT for the precompile to accept each new booking; below
  that the epoch heartbeat still checks about every 5 minutes. If it cannot cover `30,000,000 gas x fee` (about
  0.24 STT) the chain stops calling it. `/stops` shows how many checks ran and the last mark seen.
- It reacts to the pool's own mark (`tryGetMarkPrice`), like dreamDEX's own stops; a manipulated mark can fire it,
  and the fill is bounded only by the slippage limit. A wick shorter than the interval can be missed.
- The account's key keeps full power. Removing the delegation while armed would leave the heartbeat calling a
  code-less account: `scripts/exitguard.ts undelegate` refuses while the account owns subscriptions.
- Running both layers on one position: the chain-fired close can never flip (same-transaction read), but a bot-side
  close that lands after it could open the other side. Keep the bot-side level wider than the chain-fired one (the
  demo used -1.5 % bot-side and -0.06 % chain-fired).
- Earlier versions on chain, retired: v1 (`0x69b986e6…8cfc06`) woke on every new order on the book, which cost up to
  ~36 STT an hour on a busy book (and let anyone placing orders make it spend); v2 (`0x67ea0dda…85fddb5`) never
  renewed its schedule (it compared the wake-up's topic 1, which is the time it fired, to the booked time with `==`).
- Tests: `chain/test/ExitGuard.t.sol` (26, incl. a 1,000-run fuzz) and `chain/test/ExitGuardFork.t.sol` (2, on a
  fork of the live HYPE-PERP pool and MarginBank: the bot key still trades for a delegated account; open, arm,
  cross, close). The fork tests are flaky because Somnia's RPC serves storage at "latest": they passed in 3 of 6
  runs on v1/v2 (same close path) and failed inside dreamDEX's own oracle/book code on every v3 run; v3's path is
  shown live instead (`evidence/chain_fired_stop.json`). Mutation check: removing the `tx.origin` check, the side check, `onlySelf`, the precompile check,
  the safe rounding, the per-block rule, the stray-wake rule, the dead-schedule restart or the removal of used
  one-shots, or closing one lot too much, each makes at least one test fail; the v2 bug fails four tests.
  Self-reviewed; no external audit.

## Chain-link watchdog
- Every 30 s a block-number read over the SDK's WebSocket. 6 failed checks in a row close the cached
  sockets for that URL and build a fresh client (sends use HTTP and are not affected); 6 more stop the
  bot through the normal drain (orders in flight finish, at most 70 s) and exit 75, and systemd restarts
  it (`Restart=always`, delays growing to 5 min, no start limit). A sweep counts as failed only when
  every account read failed on the link itself, so a read that reverts for one account cannot cause
  restarts. A push stream that cannot subscribe reopens only its own socket, at most every 5 minutes.

## Scheduled demo trades
- Only the demo account named in `src/config.ts`, only when its linked user record exists; one 12 USDso
  position at a time (2.4 USDso x 5x) with a bot-side TP/SL 0.3 % away, flattened after 45 minutes;
  three slots a day, never repeated after a restart (the slot is recorded before the order); skipped
  below 2.8 USDso equity; off after 2026-11-02 or while `data/demo_schedule.off` exists.

## Live trials (`/try`)
- Anyone can tap Long/Short on ETH, SOL or XRP and the bot opens one 12 USDso position (2.4 x 5x) on its own
  testnet sandbox account (the demo account), through the normal open path, refused when the book is more than
  0.15 % from the mark, with a quiet bot-side TP/SL 0.3 % away. The trier needs no record, key or wallet and can
  only choose market and side: size, leverage and account are fixed.
- Caps: 2 trials per Telegram id and 12 in total per UTC day, a 30 s cooldown per person, 4 per minute in total,
  one position per market and at most 2 open, a 3.0 USDso equity floor (above the scheduled trades' 2.8) and a
  1 STT gas floor. Busy markets are refused from memory before any chain read; the caps are checked and counted
  under one sandbox-wide lock, and again under the account+market lock right before the send. No trials from
  minute 15 of a scheduled slot hour until that slot ran, nor while a scheduled trade is open.
- Every trial and scheduled trade is a job in `data/sandbox_jobs.json` (0600), written before the send. A sweep
  every minute and after each restart closes it after its hold time, retries failed closes, keeps a partly filled
  close for the rest, and closes nothing but the job's own position (same side and size; the owner's own opens on
  such a market are refused). The trier's chat id is kept there and in `data/try.json` only; never in logs, the
  order log or the evidence. On only while `data/try.on` exists; `data/try.off` turns it off.
- Reviewed twice before it was switched on (2026-10-29); every finding fixed with a test.

## Send outcomes
- Every order send is labelled by the step that failed: the simulation or the preparation (nonce, fee
  and chain-id reads, local signing; nothing was posted), the post of the signed transaction, the
  receipt wait (60 s timeout) or an on-chain revert. Only a failed simulation or preparation, or the
  node refusing the raw transaction for gas money, is reported as "nothing was sent". Anything after
  that is reported as **not confirmed** ("check /positions; I will not resend it") with the tx hash (the
  bot signs locally and hashes the signed bytes before posting), and logged as an `unknown` row that
  `scripts/evidence.ts` re-verifies from the chain.
- The order is never resent automatically. viem posts `eth_sendRawTransaction` without retries (reads
  keep their retries), a copy draft is used up before the send, and while an order's outcome is unknown
  no new order is sent on that account + market (auto or manual) until the chain shows it mined or gone
  (receipt, or pending nonce = latest nonce). An unconfirmed close also blocks a repeat on the same size
  for 20 s.
- Nonce choice and posting run one at a time per bot key (innermost lock; lock order account+market ->
  tx slots -> key), with the key's next nonce tracked locally, so two orders never pick the same nonce.
  The receipt wait runs outside that lock, so a stop-loss on another market is not held up by a slow receipt.

## Single instance
- `data/instance.lock` is created with `O_EXCL` before any chain or Telegram traffic; its mtime is a
  heartbeat refreshed every 5 s. A second instance (for example a dev run next to the service) exits
  with code 3 while the heartbeat is younger than 12 s; systemd retries every 15 s, so the service comes
  back once the other copy stops. A stale lock from a crashed process is replaced. SIGTERM / SIGINT
  stop polling (unconfirmed updates go to the next instance), stop new trades and auto-closes, wait for
  the orders already in flight (at most 70 s, under systemd's 90 s stop timeout), and only then release
  the lock.
- A relink to another account clears that user's TP/SL, open records, last close and pending copy, and
  drops the positions the protection loop holds for them before the account changes. Every held position
  records the account it was read from: a read that lands after a relink is discarded, and no exit,
  guard or warning acts on a position from an account the user left. Close buttons carry a tag of the
  account they were shown for; a button from before a relink (or an older untagged one) sends nothing.
  An exit that was already in flight during a relink is logged for the old account and leaves the new
  account's records alone.

## Runtime isolation (verified on the host, 2026-10-20; probe re-run with the same results on 2026-10-26)
- systemd user service `ops/ddmvp.service` -> `ops/run_sandboxed.sh bot`, a bubblewrap jail:
  `/usr` and `/etc` read-only, the product dir read-only, only `data/` writable, the two secret files
  bound read-only, private `/tmp` and `/run`, everything else in `$HOME` invisible.
- `ops/guard.cjs` is preloaded: TCP connections only to `*.somnia.network`, `*.somnia.host` and
  `api.telegram.org` by name (IP literals, localhost and unix sockets refused), and no subprocesses
  at all. The bot is one bundled file, so nothing needs to be spawned. Limits: the check is on host
  names, not on the address a name resolves to, and DNS over UDP is allowed (the stub resolver is
  bound into the jail). No user input ever chooses a host.
- `ops/sandbox_probe.mjs` proves it, with a positive control (`run_sandboxed.sh probe --no-guard`):

| probe | jailed + guard | jailed, no guard (control) | host |
|---|---|---|---|
| Somnia RPC | reachable | reachable | reachable |
| api.telegram.org | reachable | reachable | reachable |
| example.com | blocked | reachable | reachable |
| 127.0.0.1:9222 (local DevTools) | blocked | **reachable** | reachable |
| list secrets dir | 2 bound files only | 2 bound files only | 55 entries |
| read a file elsewhere in $HOME | ENOENT | ENOENT | readable |
| write outside data/ | EROFS | EROFS | writable |
| spawn /usr/bin/id | blocked | **runs** | runs |

## Dependencies
Pinned exact versions from npm with lockfile integrity hashes: `@somnia-chain/markets-sdk` 0.31.0,
`viem` 2.54.1, `@resvg/resvg-wasm` 2.6.2 (WebAssembly, no native code); build-only: `esbuild`,
`tsx`, `typescript`. Installed with `--ignore-scripts`. Card fonts come from the system (Noto Sans).

## Known limits
- Take-profit / stop-loss / guard are bot-side: they act only while the bot runs. On-chain stop
  orders need the account itself, which a linked key cannot sign for. The chain-fired ExitGuard stop (above) runs
  on the demo account, whose owner key armed it; other users would arm it with their own key.
- Testnet only; the bot refuses to start on any chain id other than 50383.
- Durability: `users.json` is written to a temp file, fsynced and renamed (atomic), with a second
  copy in `users.json.bak` that is loaded if the main file is unreadable. The order log rotates at 5 MB.

Report a problem: open an issue on this repository.
