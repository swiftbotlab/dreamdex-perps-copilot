// Chain-link watchdog. A WebSocket client can get stuck for good: viem gives up reconnecting after a few
// attempts and keeps the dead socket cached by URL, so every later read fails at once while the process
// still looks healthy (2026-10-27: ~28 h of "getBlockNumber failed: WebSocket request failed" every 30 s).
// Each round probes the chain over the same client the bot reads with. After `failLimit` failed rounds in
// a row the clients are rebuilt (dead sockets closed, fresh ones opened); if the rounds keep failing for
// `exitAfter` more, the process asks to exit non-zero so systemd restarts it. One log line per transition.

export interface WatchdogOpts {
  /** Throws (or rejects) when the chain cannot be read. */
  probe: () => Promise<unknown>;
  /** Close the stuck clients and build fresh ones. */
  rebuild: () => Promise<void>;
  /** Called once when rebuilding did not help: stop and exit with this code. */
  exit: (code: number) => void;
  log: (...a: unknown[]) => void;
  failLimit?: number;      // failed rounds in a row before a rebuild (6 x 30 s = 3 min)
  exitAfter?: number;      // failed rounds in a row after a rebuild before exiting
  probeTimeoutMs?: number;
  exitCode?: number;
  now?: () => number;
}

export type RoundResult = "ok" | "fail" | "rebuilt" | "exit";

export class RpcWatchdog {
  /** Failed rounds in a row toward the next step (reset by a rebuild). */
  failures = 0;
  /** Failed rounds since the last success (not reset by a rebuild). */
  streak = 0;
  rebuilds = 0;
  lastOkAt?: number;
  lastError?: string;
  private rebuiltAt?: number;
  private downSince?: number;
  private exited = false;
  private busy = false;
  private readonly o: Required<Omit<WatchdogOpts, "now">> & { now: () => number };

  constructor(opts: WatchdogOpts) {
    this.o = { failLimit: 6, exitAfter: 6, probeTimeoutMs: 10_000, exitCode: 75, now: Date.now, ...opts };
  }

  /** Healthy: the last round succeeded (for /status and /demo). */
  get healthy(): boolean { return this.streak === 0 && this.lastOkAt !== undefined; }

  private async probeOnce(): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.o.probe(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`probe timed out after ${this.o.probeTimeoutMs} ms`)), this.o.probeTimeoutMs); }),
      ]);
      return undefined;
    } catch (e) {
      return String(e instanceof Error ? e.message : e).split("\n")[0]!.slice(0, 160) || "probe failed";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One check. `extra.failed`: another signal (e.g. every account refresh of the last sweep failed) that
   * counts this round as failed even if the probe answered.
   */
  async round(extra?: { failed: boolean; error?: string }): Promise<RoundResult> {
    if (this.exited || this.busy) return this.exited ? "exit" : "fail";
    this.busy = true;
    try {
      const probeErr = await this.probeOnce();
      const err = probeErr ?? (extra?.failed ? extra.error ?? "account refresh failed" : undefined);
      const now = this.o.now();
      if (!err) {
        if (this.downSince !== undefined) {
          const secs = Math.round((now - this.downSince) / 1000);
          this.o.log(`rpc watchdog: chain reads recovered after ${secs} s${this.rebuiltAt !== undefined ? " (after a client rebuild)" : ""}`);
        }
        this.failures = 0; this.streak = 0; this.downSince = undefined; this.rebuiltAt = undefined; this.lastOkAt = now; this.lastError = undefined;
        return "ok";
      }
      this.failures++;
      this.streak++;
      this.lastError = err;
      this.downSince ??= now;
      if (this.rebuiltAt === undefined && this.failures >= this.o.failLimit) {
        this.o.log(`rpc watchdog: ${this.failures} failed checks in a row (last: ${err}); rebuilding the chain clients`);
        try { await this.o.rebuild(); } catch (e) { this.o.log("rpc watchdog: rebuild failed:", String(e instanceof Error ? e.message : e).slice(0, 160)); }
        this.rebuiltAt = now; this.rebuilds++; this.failures = 0;
        return "rebuilt";
      }
      if (this.rebuiltAt !== undefined && this.failures >= this.o.exitAfter) {
        this.exited = true;
        this.o.log(`rpc watchdog: still failing ${this.failures} checks after the rebuild (last: ${err}); exiting ${this.o.exitCode} so systemd restarts the bot`);
        this.o.exit(this.o.exitCode);
        return "exit";
      }
      return "fail";
    } finally {
      this.busy = false;
    }
  }
}
