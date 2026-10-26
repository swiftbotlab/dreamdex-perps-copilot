// Async locks shared by the bot and the venue.
// Lock order (never reversed, so no deadlock): posLock (account+market) -> txs/autoTxs semaphore -> sendLock
// (per trading key, innermost; it never waits on another lock).

/** One async lock per key: work under the same key runs one at a time, in arrival order. */
export class KeyedLock {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, f: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try { return await f(); } finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }
}

/** At most `max` tasks at once; at most 50 waiting, beyond that `busy()` is thrown. */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: number, private busy: () => Error = () => new Error("busy")) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiters.length >= 50) throw this.busy();
      await new Promise<void>((r) => this.waiters.push(r));
    }
    this.active++;
    try { return await f(); } finally { this.active--; this.waiters.shift()?.(); }
  }
}
