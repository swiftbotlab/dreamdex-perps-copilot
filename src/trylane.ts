// "Try it live": any Telegram user can place ONE small real order on the bot's own testnet sandbox account (the demo
// account, outside the Perps Arena), with no wallet and no link. This module holds only the caps and their state;
// bot.ts places the order through the normal open path. Off unless data/try.on exists (and never while
// data/try.off exists). Fails closed: any doubt (state unreadable, caps reached, sandbox low) means no order.
import { readFileSync } from "node:fs";
import { writeAtomic } from "./sandbox.ts";

export const TRY = {
  markets: ["ETH", "SOL", "XRP"] as const,
  margin: 2.4, leverage: 5,            // 12 USDso notional
  tpPct: 0.3, slPct: 0.3,              // bot-side exits, quiet
  maxHoldMs: 10 * 60_000,              // flattened after 10 minutes if no exit fired
  perUserPerDay: 2, globalPerDay: 12,  // UTC days
  maxOpen: 2,                          // sandbox positions at once (one per market)
  minEquity: 3.0, minGasStt: 1,        // above the schedule's 2.8 floor: trials stop first, the evidence trades go on
  userCooldownMs: 30_000,              // one trial tap per person per 30 s
  globalPerMinute: 4,                  // all people together
};

interface State { day: string; global: number; users: Record<string, number> }

export class TryCaps {
  constructor(private file: string, private now = () => Date.now()) {}

  private load(): State {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as Partial<State>;
      if (j.day !== day) return { day, global: 0, users: {} };
      if (!Number.isInteger(j.global) || typeof j.users !== "object" || !j.users) throw new Error("bad state");
      return { day, global: j.global!, users: j.users };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { day, global: 0, users: {} };
      throw e; // unreadable state: the caller refuses (fail closed)
    }
  }

  /** Why this user cannot try now, or undefined. */
  refusal(userId: number): string | undefined {
    const s = this.load();
    if (s.global >= TRY.globalPerDay) return `Today's ${TRY.globalPerDay} live trials are used up. Try again after 00:00 UTC, or look at /demo.`;
    if ((s.users[String(userId)] ?? 0) >= TRY.perUserPerDay) return `You have used your ${TRY.perUserPerDay} live trials for today. /start links your own account for real trading.`;
    return undefined;
  }

  /** Count one trial (call it right before the order is sent). */
  take(userId: number): void {
    const s = this.load();
    s.global++;
    s.users[String(userId)] = (s.users[String(userId)] ?? 0) + 1;
    if (Object.keys(s.users).length > 5_000) throw new Error("too many trial users today");
    writeAtomic(this.file, JSON.stringify(s));
  }
}
