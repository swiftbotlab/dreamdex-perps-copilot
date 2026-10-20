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
  cached 60 s). At most 4 user-initiated transactions in flight, 50 waiting; auto-closes use their own
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

## Runtime isolation (verified on the host, 2026-10-20)
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
