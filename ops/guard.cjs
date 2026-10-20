// Preloaded with `node --require` before any bot code. Two in-process rules on top of the bwrap jail:
// 1. egress allowlist: only *.somnia.network, *.somnia.host and api.telegram.org may be dialled by name;
//    IP literals, localhost (DevTools on 127.0.0.1:9222!), LAN and unix sockets are refused;
// 2. no subprocesses at all (the bot is one bundled file and needs none).
"use strict";
const net = require("node:net");
const ALLOW = [/\.somnia\.network$/i, /\.somnia\.host$/i, /^api\.telegram\.org$/i];
const ok = (h) => typeof h === "string" && net.isIP(h) === 0 && ALLOW.some((r) => r.test(h));
const orig = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  let host, path;
  if (o && typeof o === "object") { host = o.host; path = o.path; }
  else if (typeof o === "string" && isNaN(Number(o))) { path = o; }
  else { host = typeof args[1] === "string" ? args[1] : "localhost"; }
  if (path !== undefined || !ok(host)) {
    const e = new Error("egress blocked: " + (path !== undefined ? "unix socket" : String(host)));
    process.nextTick(() => this.destroy(e));
    return this;
  }
  return orig.apply(this, args);
};
const cp = require("node:child_process");
for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  cp[k] = (cmd) => { throw new Error("subprocess blocked: " + String(cmd).slice(0, 60)); };
}
require("node:module").syncBuiltinESMExports();
