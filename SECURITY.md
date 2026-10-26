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
  orders need the account itself, which a linked key cannot sign for.
- Testnet only; the bot refuses to start on any chain id other than 50383.
- Durability: `users.json` is written to a temp file, fsynced and renamed (atomic), with a second
  copy in `users.json.bak` that is loaded if the main file is unreadable. The order log rotates at 5 MB.

Report a problem: open an issue on this repository.
