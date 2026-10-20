import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVsMark, cleanBase, escapeHtml, liqDistancePct, parseAmount, parseLevel, parseLeverage, parseOpen, resolveLevel, splitCommand, triggered } from "../src/parse.ts";

const maxLev = (b: string) => ({ ETH: 20, BTC: 20, DOGE: 10, "1000PEPE": 5 } as Record<string, number>)[b];

test("splitCommand handles @mentions and junk", () => {
  assert.deepEqual(splitCommand("/long@SwiftPerpsBot ETH 20 5x", "SwiftPerpsBot"), { cmd: "long", args: ["ETH", "20", "5x"] });
  assert.equal(splitCommand("/long@OtherBot ETH", "SwiftPerpsBot"), undefined);
  assert.equal(splitCommand("hello", "SwiftPerpsBot"), undefined);
  assert.equal(splitCommand("/$(rm -rf)", "SwiftPerpsBot"), undefined);
  assert.equal(splitCommand("/a b c d e f g h i j k l m n o p", "x")!.args.length, 11);
});

test("cleanBase", () => {
  assert.equal(cleanBase("eth"), "ETH");
  assert.equal(cleanBase("ETH-PERP"), "ETH");
  assert.equal(cleanBase("1000pepe"), "1000PEPE");
  assert.equal(cleanBase("ETH/USDso:USDso"), "ETH");
  assert.equal(cleanBase("../etc"), undefined);
  assert.equal(cleanBase("<b>"), undefined);
  assert.equal(cleanBase("A".repeat(13)), undefined);
});

test("parseAmount rejects exponent, hex, negatives, too many decimals", () => {
  assert.equal(parseAmount("20", 1, 5000, 2), 20);
  assert.equal(parseAmount("20.55", 1, 5000, 2), 20.55);
  assert.equal(parseAmount("20.555", 1, 5000, 2), undefined);
  assert.equal(parseAmount("1e3", 1, 5000), undefined);
  assert.equal(parseAmount("0x10", 1, 5000), undefined);
  assert.equal(parseAmount("-5", 1, 5000), undefined);
  assert.equal(parseAmount("Infinity", 1, 5000), undefined);
  assert.equal(parseAmount("NaN", 1, 5000), undefined);
  assert.equal(parseAmount("9999", 1, 5000), undefined);
  assert.equal(parseAmount("0.5", 1, 5000), undefined);
  assert.equal(parseAmount("50", 1, 100, 0), 50); // whole numbers (close %)
  assert.equal(parseAmount("50.5", 1, 100, 0), undefined);
});

test("parseLeverage", () => {
  assert.equal(parseLeverage("5x", 20), 5);
  assert.equal(parseLeverage("5", 20), 5);
  assert.equal(parseLeverage("2.5x", 20), 2.5);
  assert.equal(parseLeverage("21x", 20), undefined);
  assert.equal(parseLeverage("0x", 20), undefined);
  assert.equal(parseLeverage("x", 20), undefined);
});

test("parseOpen happy path and errors", () => {
  assert.deepEqual(parseOpen("long", ["eth", "20", "5x"], maxLev), { kind: "open", side: "long", base: "ETH", margin: 20, leverage: 5 });
  const withExits = parseOpen("short", ["BTC", "15", "10x", "tp", "3%", "sl", "1.5%"], maxLev);
  assert.deepEqual(withExits, { kind: "open", side: "short", base: "BTC", margin: 15, leverage: 10, tp: { pct: 3 }, sl: { pct: 1.5 } });
  assert.match(parseOpen("long", ["XYZ", "20"], maxLev) as string, /Unknown market/);
  assert.match(parseOpen("long", ["1000PEPE", "20", "10x"], maxLev) as string, /between 1x and 5x/);
  assert.match(parseOpen("long", ["ETH", "abc"], maxLev) as string, /Margin/);
  assert.match(parseOpen("long", ["ETH", "20", "5x", "tp"], maxLev) as string, /Could not read/);
  assert.match(parseOpen("long", [], maxLev) as string, /Usage/);
  assert.equal((parseOpen("long", ["ETH", "20"], maxLev) as { leverage: number }).leverage, 1);
});

test("TP/SL resolution and triggers", () => {
  assert.equal(resolveLevel("tp", "long", { pct: 5 }, 100), 105);
  assert.equal(resolveLevel("sl", "long", { pct: 2 }, 100), 98);
  assert.equal(resolveLevel("tp", "short", { pct: 5 }, 100), 95);
  assert.equal(resolveLevel("sl", "short", { pct: 2 }, 100), 102);
  assert.match(resolveLevel("tp", "long", { price: 90 }, 100) as string, /above/);
  assert.match(resolveLevel("sl", "short", { price: 90 }, 100) as string, /above/);
  assert.equal(triggered("tp", "long", 105, 105.1), true);
  assert.equal(triggered("tp", "long", 105, 104.9), false);
  assert.equal(triggered("sl", "long", 98, 97.9), true);
  assert.equal(triggered("tp", "short", 95, 94), true);
  assert.equal(triggered("sl", "short", 102, 101), false);
  assert.deepEqual(parseLevel("2500"), { price: 2500 });
  assert.deepEqual(parseLevel("-2%"), { pct: 2 });
  assert.equal(parseLevel("95%"), undefined);
});

test("liquidation distance", () => {
  assert.equal(liqDistancePct("long", 100, 90), 10);
  assert.equal(liqDistancePct("short", 100, 120), 20);
  assert.equal(liqDistancePct("long", 100, undefined), undefined);
  assert.equal(liqDistancePct("long", 100, 0), undefined);
  assert.equal(liqDistancePct("long", 85, 90), 0);
});

test("escapeHtml", () => {
  assert.equal(escapeHtml(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("levels already crossed by the mark are refused", () => {
  assert.match(checkVsMark("sl", "long", 107.027, 106.917)!, /already at or above/); // the 14:13 UTC SOL case
  assert.equal(checkVsMark("sl", "long", 106.8, 106.917), undefined);
  assert.match(checkVsMark("tp", "short", 100, 99)!, /already at or above/);
  assert.equal(checkVsMark("tp", "long", 110, 106), undefined);
});
