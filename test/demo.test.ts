// /demo: a live account run by the bot, shown to anyone (no user record). Only validated order-log rows of the
// demo account, at most 5, HTML-escaped; one account read per 15 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { cb, makeBot, msg } from "./_harness.ts";

const DEMO = "0x0e7E8DF6Eac2E14165b4fA4CB2BD4e445d0E3817";
const OTHER = "0x00000000000000000000000000000000000000f1";
const hx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const row = (n: number, o: Record<string, unknown> = {}) => JSON.stringify({ t: `2026-10-20T13:${String(10 + n).padStart(2, "0")}:00.000Z`, kind: n % 2 ? "close" : "open", reason: n % 2 ? "manual close" : undefined, market: "SOL-PERP", side: n % 2 ? "short" : "long", hash: hx(n), filled: 0.47, requested: 0.47, avgPrice: 104.19, key: "0x00000000000000000000000000000000000000bb", account: DEMO.toLowerCase(), ...o });

function fixture(h: ReturnType<typeof makeBot>) {
  const lines = [
    row(1), row(2), row(3, { reason: "take-profit 104.30 reached (mark 104.31)" }), row(4), row(5),
    row(6, { account: OTHER }),                               // another account
    "{not json",                                              // malformed
    row(7, { hash: "0x1234" }),                               // bad hash
    row(8, { market: "<b>-PERP" }),                           // bad market
    row(9, { filled: "NaN" }),                                // bad number
    row(10, { reason: "<b>x</b> stop-loss" }),                // HTML in a reason
    row(11, { kind: "close", reason: "stop-loss 107.03 reached (mark 107.02)" }),
  ];
  appendFileSync(`${h.bot.store["dir"]}/orders.jsonl`, lines.join("\n") + "\n");
}
const orderLines = (html: string) => html.split("\n").filter((l) => /^\d\d-\d\d \d\d:\d\d (open|close|unknown) /.test(l));

test("T12: /demo works without a user record and shows only valid demo rows, at most 5, escaped", async () => {
  const h = makeBot();
  fixture(h);
  await h.handle(msg(500, "/demo"));
  assert.equal(h.bot.store.get(500), undefined);
  const out = h.to(500).at(-1)!;
  const lines = orderLines(out.html);
  assert.equal(lines.length, 5);
  assert.ok(out.html.includes(hx(11)) && out.html.includes(hx(10)), "newest rows first");
  for (const bad of [6, 7, 8, 9]) assert.ok(!out.html.includes(hx(bad)), `row ${bad} filtered`);
  assert.ok(out.html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(!out.html.includes("<b>x</b>"));
  assert.match(out.html, /auto: stop-loss/);
  assert.match(out.html, /Last auto-exit<\/b>: 10-20 13:21 UTC SOL-PERP stop-loss/);
  assert.match(out.html, /Totals<\/b>: 7 orders \(3 opens, 4 closes\), 2 closed by the bot itself/);
  assert.match(out.html, /Somnia Reactivity<\/b>: 1 live mark stream \(ETH 42 pushes\)/);
  assert.deepEqual(h.cbData(out), ["dc", "wd", "st"]);
});

test("T12: a second /demo within 15 s makes no new account read; /demo is rate limited per user", async () => {
  const h = makeBot();
  fixture(h);
  await h.handle(msg(500, "/demo"));
  assert.equal(h.state.accountCalls, 1);
  await h.handle(msg(501, "/demo"));
  assert.equal(h.state.accountCalls, 1);
  await h.handle(msg(500, "/demo"));
  await h.handle(msg(500, "/demo"));
  assert.match(h.to(500).at(-1)!.html, /Live demo/, "3 per minute allowed");
  await h.handle(msg(500, "/demo"));
  assert.match(h.to(500).at(-1)!.html, /a few times a minute/);
});

test("T12 (positive control): switching the demo account shows that account's rows", async () => {
  const h = makeBot();
  fixture(h);
  h.bot.demoAccount = OTHER;
  await h.handle(msg(502, "/demo"));
  const out = h.to(502).at(-1)!.html;
  assert.ok(out.includes(hx(6)));
  assert.equal(orderLines(out).length, 1);
});

test("/demo buttons: Sample PnL card (from the demo user's lastClosed) and Start trading work before /start", async () => {
  const h = makeBot();
  const du = h.addUser(1, DEMO);
  du.lastClosed = { base: "SOL", side: "long", entry: 104.19, exit: 104.36, size: 0.47, pnl: 0.08, at: Date.now(), reason: "take-profit" };
  await h.handle(cb(600, "dc"));
  const photo = h.to(600).find((s) => s.photo)!;
  const card = h.bot.store.cardsBy(1)[0]!;
  assert.equal(photo.buttons![0]![0]!.url, `https://t.me/SwiftPerpsBot?start=c_${card.id}`);
  assert.match(photo.html, /Sample card from the demo account/);
  await h.handle(cb(600, "dc"));
  assert.equal(h.bot.store.cardsBy(1).length, 1, "reuses the newest card");
  await h.handle(cb(601, "st"));
  assert.ok(h.bot.store.get(601));
  assert.match(h.to(601).at(-1)!.html, /^Look around first, no wallet needed: \/demo/);
});
