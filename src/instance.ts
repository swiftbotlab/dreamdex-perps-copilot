// Single instance: two bots polling one token would split updates between them, and two processes sending
// from one trading key would race for the same nonce. The lock is a file in data/ created with O_EXCL; its
// mtime is the heartbeat (touched every beatMs). A lock whose heartbeat is older than staleMs belongs to a
// process that died and is replaced. Covers every way the bot starts (systemd jail, `tsx src/bot.ts`).
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface InstanceLockOpts { beatMs: number; staleMs: number; onLost?: () => void }

export function acquireInstanceLock(dataDir: string, opts: InstanceLockOpts = { beatMs: 5_000, staleMs: 12_000 }): () => void {
  const file = `${dataDir}/instance.lock`;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const create = () => {
    const fd = openSync(file, "wx", 0o600); // fails with EEXIST if another instance holds it
    try { writeSync(fd, token); } finally { closeSync(fd); }
  };
  const age = (path: string) => Date.now() - statSync(path).mtimeMs;
  try {
    create();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const a = age(file);
    if (a < opts.staleMs) throw new Error(`another instance holds ${file} (heartbeat ${Math.round(a / 1000)} s old)`);
    // Stale: move it aside (only one racer's rename succeeds), check that what we moved really was stale, then create.
    const aside = `${file}.stale-${token.split(":")[1]}`;
    renameSync(file, aside);
    if (age(aside) < opts.staleMs) { renameSync(aside, file); throw new Error(`another instance took ${file} just now`); }
    unlinkSync(aside);
    create();
  }
  const ours = () => { try { return readFileSync(file, "utf8") === token; } catch { return false; } };
  const timer = setInterval(() => {
    if (!ours()) { clearInterval(timer); opts.onLost?.(); return; }
    const now = new Date();
    try { utimesSync(file, now, now); } catch { /* checked again on the next beat */ }
  }, opts.beatMs);
  timer.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    if (ours()) { try { unlinkSync(file); } catch { /* already gone */ } }
  };
}
