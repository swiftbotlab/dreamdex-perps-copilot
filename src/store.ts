// Small JSON store (one file, atomic rename, mode 0600) plus an append-only order log.
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { SealedKey } from "./keys.ts";
import type { Side } from "./parse.ts";

export interface Rule { tp?: number; sl?: number; side: Side; setAt: number }
export interface OpenInfo { margin: number; leverage: number; at: number }
export interface ClosedTrade { base: string; side: Side; entry: number; exit: number; size: number; pnl: number; roePct?: number; at: number; reason: string }

export interface User {
  id: number;
  created: number;
  keyAddress: `0x${string}`;
  key: SealedKey;
  owner?: `0x${string}`;
  ref: string;               // this user's share code (deep link payload)
  refBy?: string;            // the code that brought them in, if any
  liqWarnPct: number;        // warn when mark is within this % of the liquidation price
  guardPct?: number;         // auto-close when within this % (off when undefined)
  rules: Record<string, Rule>;    // per market base: bot-watched TP / SL
  opens: Record<string, OpenInfo>; // margin/leverage the user asked for, for ROE on cards
  lastClosed?: ClosedTrade;
  stats: { orders: number; cards: number };
}

interface Db { users: Record<string, User>; keysMadeAt: number[] }

export class Store {
  private db: Db = { users: {}, keysMadeAt: [] };
  private readonly file: string;
  private readonly orderLog: string;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = `${dir}/users.json`;
    this.orderLog = `${dir}/orders.jsonl`;
    if (existsSync(this.file)) {
      try {
        this.db = JSON.parse(readFileSync(this.file, "utf8")) as Db;
      } catch {
        // A torn write must never cost users their keys: fall back to the last good copy, or refuse to start.
        this.db = JSON.parse(readFileSync(`${this.file}.bak`, "utf8")) as Db;
        console.log(new Date().toISOString(), "users.json unreadable, loaded users.json.bak");
      }
    }
  }

  get(id: number): User | undefined { return this.db.users[String(id)]; }
  all(): User[] { return Object.values(this.db.users); }
  count(): number { return Object.keys(this.db.users).length; }
  byRef(code: string): User | undefined { return this.all().find((u) => u.ref === code); }

  keysMadeLastHour(now = Date.now()): number {
    this.db.keysMadeAt = this.db.keysMadeAt.filter((t) => now - t < 3_600_000);
    return this.db.keysMadeAt.length;
  }

  add(u: Omit<User, "ref" | "rules" | "opens" | "stats" | "liqWarnPct">): User {
    let ref = randomBytes(5).toString("hex");
    while (this.byRef(ref)) ref = randomBytes(5).toString("hex");
    const user: User = { ...u, ref, rules: {}, opens: {}, stats: { orders: 0, cards: 0 }, liqWarnPct: 10 };
    this.db.users[String(u.id)] = user;
    this.db.keysMadeAt.push(Date.now());
    this.save();
    return user;
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify(this.db)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);              // atomic: users.json is always a complete version
    copyFileSync(this.file, `${this.file}.bak`); // second copy of the latest good state
  }

  /** Forget users who never linked their key within `maxAgeMs` (their key has no power on chain). */
  pruneUnlinked(maxAgeMs: number, now = Date.now()): number {
    let n = 0;
    for (const [k, u] of Object.entries(this.db.users)) if (!u.owner && now - u.created > maxAgeMs) { delete this.db.users[k]; n++; }
    if (n) this.save();
    return n;
  }

  /** Public on-chain facts only (hash, market, side, size, price): this file feeds evidence/. */
  logOrder(rec: Record<string, unknown>): void {
    try { if (statSync(this.orderLog).size > 5_000_000) renameSync(this.orderLog, `${this.orderLog}.1`); } catch { /* first write */ }
    appendFileSync(this.orderLog, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 });
  }
}
