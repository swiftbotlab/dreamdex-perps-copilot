#!/bin/bash
# Run the Perps Copilot inside a bwrap ALLOWLIST jail (ExecStart of ddmvp.service).
# systemd's Protect*/PrivateTmp/IPAddressDeny are silently NOT applied on this host (unprivileged user
# namespaces are restricted for the user manager), so bwrap is the filesystem boundary.
# Visible inside: /usr /etc (ro), the stub resolv.conf, the product dir (ro), its data/ (rw), the bot token
# file and the key-vault master file (ro), private /tmp and /run. Hidden: the rest of $HOME (other secrets,
# Chrome profile, other products). Network egress is limited in-process by ops/guard.cjs.
# Usage: run_sandboxed.sh bot | probe [--no-guard]
set -euo pipefail
PROD=/home/agent/agent/products/dreamdex-mvp
BOTENV=/home/agent/agent/secrets/ddmvp_bot.env
MASTER=/home/agent/agent/secrets/ddmvp_master.env
STUB=/run/systemd/resolve/stub-resolv.conf
for f in "$BOTENV" "$MASTER" "$PROD/dist/bot.mjs" "$PROD/dist/resvg.wasm"; do [ -f "$f" ] || { echo "missing $f" >&2; exit 2; }; done
mkdir -p "$PROD/data" && chmod 700 "$PROD/data"
ARGS=(--unshare-user-try --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
      --new-session --clearenv --cap-drop ALL
      --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/sbin /sbin
      --ro-bind /etc /etc --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run --tmpfs /home)
[ -f "$STUB" ] && ARGS+=(--ro-bind "$STUB" "$STUB")
ARGS+=(--ro-bind "$PROD" "$PROD" --bind "$PROD/data" "$PROD/data"
       --ro-bind "$BOTENV" "$BOTENV" --ro-bind "$MASTER" "$MASTER"
       --chdir "$PROD"
       --setenv HOME /tmp --setenv TMPDIR /tmp --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8
       --setenv NODE_ENV production)
case "${1:-bot}" in
  bot)   exec /usr/bin/bwrap "${ARGS[@]}" /usr/bin/node --require "$PROD/ops/guard.cjs" "$PROD/dist/bot.mjs" ;;
  probe) if [ "${2:-}" = "--no-guard" ]; then exec /usr/bin/bwrap "${ARGS[@]}" /usr/bin/node "$PROD/ops/sandbox_probe.mjs"
         else exec /usr/bin/bwrap "${ARGS[@]}" /usr/bin/node --require "$PROD/ops/guard.cjs" "$PROD/ops/sandbox_probe.mjs"; fi ;;
  *) echo "usage: run_sandboxed.sh bot|probe [--no-guard]" >&2; exit 2 ;;
esac
