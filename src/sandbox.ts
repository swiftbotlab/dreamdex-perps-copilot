// Positions the bot opens on its own sandbox (demo) account by itself: scheduled demo trades and /try trials.
// Each one is written to data/ BEFORE its order is sent, with the time by which it must be closed, so a restart
// (or the watchdog's exit) never leaves one open without a plan: a sweep every minute and at startup closes
// overdue ones and retries failed closes. A job only ever closes the position it opened: same market and side,
// and (once the fill is known) the same size and entry; anything else on that market is left alone.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Side } from "./parse.ts";

export interface SandboxJob {
  id: string;                 // random, per job
  kind: "schedule" | "try";
  base: string; side: Side;
  at: number;                 // when the job was created (just before the send)
  deadline: number;           // close it after this time if it is still open
  hash?: string; size?: number; entry?: number; // the fill, once known (provisional until then)
  filledAt?: number;          // when the send returned (fill known, or outcome unknown)
  chat?: number;              // the trier's chat, for "try" (private file, never logged or published)
  attempts?: number;          // failed closes so far
}

/** Write a file atomically (temp + rename), mode 600. */
export function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

export class SandboxJobs {
  constructor(private file: string) {}

  all(): SandboxJob[] {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(j) ? (j as SandboxJob[]).filter((x) => x && typeof x.base === "string" && (x.side === "long" || x.side === "short") && Number.isFinite(x.deadline)) : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e; // unreadable: callers fail closed (no new sandbox orders)
    }
  }
  private save(list: SandboxJob[]): void { writeAtomic(this.file, JSON.stringify(list.slice(-50))); }
  add(job: SandboxJob): void { this.save([...this.all().filter((x) => x.id !== job.id), job]); }
  update(id: string, patch: Partial<SandboxJob>): void { this.save(this.all().map((x) => (x.id === id ? { ...x, ...patch } : x))); }
  remove(id: string): void { this.save(this.all().filter((x) => x.id !== id)); }
  on(base: string): SandboxJob | undefined { return this.all().find((x) => x.base === base); }
}

const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * rel);

/** Is this position the one the job opened? Provisional jobs (fill unknown) match any position of their side. */
export function isJobPosition(job: SandboxJob, pos: { side: Side; size: number; entry: number } | undefined): boolean {
  if (!pos || pos.side !== job.side) return false;
  if (job.size === undefined) return true;
  return near(pos.size, job.size, 1e-6) && (job.entry === undefined || near(pos.entry, job.entry, 5e-4));
}
