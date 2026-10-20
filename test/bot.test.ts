// Bot-level close safety with a fake venue (no chain, no Telegram): a manual close racing an auto-close,
// lagging RPC reads, and an exit whose position flipped side must never send a second / wrong order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = mkdtempSync(`${tmpdir()}/ddmvp-bot-`);
writeFileSync(`${dir}/bot.env`, "BOT_TOKEN=123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
writeFileSync(`${dir}/master.env`, `DDMVP_MASTER_KEY=${"33".repeat(32)}\n`);
process.env.DDMVP_BOT_ENV = `${dir}/bot.env`;
process.env.DDMVP_MASTER_ENV = `${dir}/master.env`;
process.env.DDMVP_DATA = `${dir}/data`;
const { Bot } = await import("../src/bot.ts");
const { UserError } = await import("../src/venue.ts");

function harness(opts: { side: "long" | "short"; lagReads: boolean }) {
  const bot = new Bot() as any;
  const state = { size: 1, side: opts.side, sent: 0 };
  let stale = false;
  const owner = "0x00000000000000000000000000000000000000aa";
  bot.venue = {
    tradingKey: () => ({ owner, operator: "0x00000000000000000000000000000000000000bb" }),
    gasBalance: async () => 5,
    market: () => ({}),
    account: async () => ({ positions: stale || state.size > 0 ? [{ base: "ETH", side: state.side, size: stale ? 1 : state.size, entry: 2000, mark: 2000, upnl: 0, notional: 2000, pool: "0x1" }] : [] }),
    close: async (_tk: unknown, base: string, _f: number, _l: unknown, guard?: (a: number, s: string) => void) => {
      const seen = stale ? 1 : state.size;
      if (seen === 0) throw new UserError(`No open ${base}-PERP position.`);
      guard?.(seen, state.side);
      await new Promise((r) => setTimeout(r, 30));
      state.sent++; state.size = 0; if (opts.lagReads) stale = true;
      return { hash: "0x" + "1".repeat(64), filledBase: seen, avgPrice: 2000, requestedBase: seen, base, side: state.side === "long" ? "short" : "long", realizedPnl: 0, entry: 2000, prevSize: seen };
    },
  };
  bot.tg = { sendMessage: async () => ({}), answerCallback: async () => ({}) };
  bot.protector = { refreshUser: async () => {} };
  const u = bot.store.add({ id: 1, created: Date.now(), keyAddress: "0x00000000000000000000000000000000000000bb", key: bot.vault.create(1).sealed });
  u.owner = owner;
  return { bot, u, state };
}

test("manual close racing an auto-close sends ONE order", async () => {
  const { bot, u, state } = harness({ side: "long", lagReads: false });
  const results = await Promise.allSettled([
    bot.doClose(u, 1, "ETH", 1, "manual close"),
    bot.doClose(u, 1, "ETH", 1, "stop-loss", { expectSide: "long", auto: true }),
  ]);
  assert.equal(state.sent, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});

test("a lagging read right after a close does not trigger a second close", async () => {
  const { bot, u, state } = harness({ side: "long", lagReads: true });
  await bot.doClose(u, 1, "ETH", 1, "manual close");
  await assert.rejects(bot.doClose(u, 1, "ETH", 1, "take-profit", { expectSide: "long", auto: true }), /just went through/);
  assert.equal(state.sent, 1);
});

test("an exit set for a long never closes a short; its rules are cleared", async () => {
  const { bot, u, state } = harness({ side: "short", lagReads: false });
  u.rules.ETH = { side: "long", sl: 1900, setAt: 0 };
  await assert.rejects(bot.doClose(u, 1, "ETH", 1, "stop-loss", { expectSide: "long", auto: true }), /now a short/);
  assert.equal(state.sent, 0);
  assert.equal(u.rules.ETH, undefined);
});
