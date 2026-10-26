// Card-copy loop: a shared card opens a landing with Copy this trade, a preview, then a single-use Confirm.
// Sharers get attribution pings (rate limited, skipped once they block the bot).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addr, cb, HASH, LIMITS, makeBot, msg, venueMod } from "./_harness.ts";

const SHARER = 7_770_001; // distinctive, so "the landing never shows it" is a real check

/** A sharer with a closed SOL trade at 5x who made one card. Returns the card id. */
async function withCard(h: ReturnType<typeof makeBot>, lev = 5) {
  const s = h.addUser(SHARER, addr(0x5a));
  s.lastClosed = { base: "SOL", side: "long", entry: 100, exit: 104, size: 1, pnl: 4, at: Date.now() - 60_000, reason: "take-profit" };
  s.opens.SOL = { margin: 20, leverage: lev, at: 0 };
  await h.handle(msg(SHARER, "/card"));
  const card = h.bot.store.cardsBy(SHARER)[0]!;
  h.sent.length = 0; h.attempts.length = 0;
  return card;
}
const pingsTo = (h: ReturnType<typeof makeBot>, id: number) => h.to(id).filter((s) => /card (brought|was copied)/.test(s.html));
/** Tap a card's margin button and return the Confirm nonce from the preview. */
async function preview(h: ReturnType<typeof makeBot>, id: number, cardId: string, margin = 25): Promise<string> {
  await h.handle(cb(id, `cm:${cardId}:${margin}`));
  const data = h.cbData(h.to(id).at(-1)).find((d) => d.startsWith("cx:"));
  assert.ok(data, "preview shows Confirm");
  return data!.split(":")[1]!;
}

test("/card makes a card record and a Copy this trade link (button + caption)", async () => {
  const h = makeBot();
  const s = h.addUser(SHARER, addr(0x5a));
  s.lastClosed = { base: "SOL", side: "long", entry: 100, exit: 104, size: 1, pnl: 4, at: Date.now(), reason: "manual close" };
  await h.handle(msg(SHARER, "/card"));
  const card = h.bot.store.cardsBy(SHARER)[0]!;
  assert.match(card.id, /^[0-9a-f]{10}$/);
  const photo = h.sent.find((x) => x.photo)!;
  assert.deepEqual(photo.buttons, [[{ text: "Copy this trade", url: `https://t.me/SwiftPerpsBot?start=c_${card.id}` }]]);
  assert.match(photo.html, /Forward this card\. Friends tap Copy this trade/);
  assert.match(photo.html, new RegExp(`Copy this trade: https://t\\.me/SwiftPerpsBot\\?start=c_${card.id}`));
});

test("T5: a new user from /start c_<id>: refBy, pendingCopy, counters, ONE sharer ping; after linking the copy buttons appear", async () => {
  const h = makeBot();
  const card = await withCard(h);
  const sharer = h.bot.store.get(SHARER);
  await h.handle(msg(200, `/start c_${card.id}`));
  const u = h.bot.store.get(200)!;
  assert.equal(u.refBy, sharer.ref);
  assert.equal(u.pendingCopy?.card, card.id);
  assert.deepEqual([card.newUsers, card.taps, card.copies], [1, 1, 0]);
  assert.equal(pingsTo(h, SHARER).length, 1);
  assert.match(pingsTo(h, SHARER)[0]!.html, /SOL card brought a new trader/);
  const landing = h.to(200).find((x) => /Shared trade/.test(x.html))!;
  assert.match(landing.html, /SOL-PERP long 5x · entry 100\.000 → exit 104\.000/);
  assert.equal(h.cbData(landing).filter((d) => d.startsWith("cm:")).length, 0, "no trade buttons before linking");
  assert.ok(!landing.html.includes(addr(0x5a)) && !landing.html.includes(String(SHARER)), "never shows the sharer");
  assert.ok(h.to(200).some((x) => /link your personal bot key/.test(x.html)), "normal onboarding follows");
  // A second tap by the same person counts once.
  await h.handle(msg(200, `/start c_${card.id}`));
  assert.equal(card.taps, 1);
  h.sent.length = 0;
  await h.bot.attach(u, 200, addr(0xb2));
  const btn = h.to(200).map((x) => h.cbData(x).filter((d) => d.startsWith("cm:"))).find((d) => d.length)!;
  assert.deepEqual(btn, LIMITS.cardMargins.map((m) => `cm:${card.id}:${m}`));
  assert.equal(u.pendingCopy, undefined);
});

test("T5 (positive control): an unknown card is a plain start; the sharer's own tap changes nothing", async () => {
  const h = makeBot();
  const card = await withCard(h);
  await h.handle(msg(300, "/start c_ffffffffff"));
  assert.equal(h.bot.store.get(300).refBy, undefined);
  assert.equal(h.bot.store.get(300).pendingCopy, undefined);
  await h.handle(msg(SHARER, `/start c_${card.id}`));
  assert.deepEqual([card.newUsers, card.taps, card.copies], [0, 0, 0]);
  assert.equal(pingsTo(h, SHARER).length, 0);
  assert.match(h.to(SHARER).at(-1)!.html, /Your card: open it again/); // run it back
  // A linked tapper gets the landing with buttons and no onboarding.
  h.addUser(301, addr(0xb3));
  await h.handle(msg(301, `/start c_${card.id}`));
  assert.equal(h.to(301).length, 1);
  assert.equal(h.cbData(h.to(301)[0]).filter((d) => d.startsWith("cm:")).length, 3);
});

test("T6: one preview sends at most one order; expired or foreign drafts send nothing; bad button data is ignored", async () => {
  const h = makeBot();
  const card = await withCard(h);
  h.addUser(200, addr(0xb2));
  h.addUser(201, addr(0xb3));
  const n1 = await preview(h, 200, card.id);
  assert.equal(h.state.opens.length, 0, "cm: sends nothing");
  await h.handle(cb(200, `cx:${n1}:0`));
  await h.handle(cb(200, `cx:${n1}:0`));
  assert.equal(h.state.opens.length, 1);
  assert.match(h.to(200).at(-1)!.html, /expired or was already used/);
  // Expired: confirm 11 minutes after the preview.
  const n2 = await preview(h, 200, card.id);
  const real = Date.now;
  Date.now = () => real() + 11 * 60_000;
  try { await h.handle(cb(200, `cx:${n2}:0`)); } finally { Date.now = real; }
  assert.equal(h.state.opens.length, 1);
  // Someone else's draft.
  const n3 = await preview(h, 200, card.id);
  await h.handle(cb(201, `cx:${n3}:0`));
  assert.equal(h.state.opens.length, 1);
  // Malformed or out-of-range button data: no preview, no order.
  const before = h.sent.length;
  for (const d of [`cm:${card.id}:30`, `cm:${card.id}:25:1`, "cm:zzzzzzzzzz:25", `cx:${n3}:2`, `cx:${n3.slice(1)}:0`, "cm:ffffffffff:25"]) await h.handle(cb(200, d));
  assert.equal(h.state.opens.length, 1);
  assert.equal(h.sent.slice(before).filter((s) => /Copy preview/.test(s.html)).length, 0);
  assert.match(h.sent.at(-1)!.html, /expired/); // the unknown card id
});

test("T6 (positive control): a second fresh preview -> confirm does send a second order", async () => {
  const h = makeBot();
  const card = await withCard(h);
  h.addUser(200, addr(0xb2));
  await h.handle(cb(200, `cx:${await preview(h, 200, card.id)}:0`));
  await h.handle(cb(200, `cx:${await preview(h, 200, card.id, 10)}:0`));
  assert.equal(h.state.opens.length, 2);
  assert.match(h.to(200).find((s) => /Copy preview/.test(s.html) && /10\.00 x/.test(s.html))!.html, /adds to your SOL long/);
});

test("T7: Confirm + SL 3% copies the card's market and side with the 0.5% touch limit, clamps leverage, sets an SL 3% from the fill", async () => {
  const h = makeBot({ maxLev: { SOL: 20, ETH: 20 } });
  const card = await withCard(h, 20); // the sharer used 20x; copies are capped at 10x
  const u = h.addUser(200, addr(0xb2));
  await h.handle(cb(200, `cm:${card.id}:25`));
  const pv = h.to(200).at(-1)!;
  assert.match(pv.html, /Open long SOL 25\.00 x 10x = 250\.00 USDso at market/);
  assert.match(pv.html, /Leverage capped at 10x \(the card used 20x/);
  assert.match(pv.html, /more than 0\.5% from the mark/);
  await h.handle(cb(200, `cx:${h.cbData(pv).find((d) => d.endsWith(":1"))!.split(":")[1]}:1`));
  assert.equal(h.state.opens.length, 1);
  assert.deepEqual(h.state.opens[0], { owner: addr(0xb2), base: "SOL", side: "long", notional: 250, opts: { maxTouchPct: 0.5 } });
  assert.equal(u.rules.SOL?.sl, 97); // fill 100, SL 3% below
  const rows = (await import("node:fs")).readFileSync(`${h.bot.store["dir"]}/orders.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([rows[0].via, rows[0].card], ["card", card.id]);
});

test("T7 (positive control): /long passes no touch override; the real Venue.touch refuses 0.8% for copies and accepts it by default", async () => {
  const h = makeBot();
  h.addUser(200, addr(0xb2));
  await h.handle(msg(200, "/long SOL 20 5x"));
  assert.equal(h.state.opens[0]!.opts.maxTouchPct, undefined);
  // Real Venue code, fake book: best ask 0.8% above the mark.
  const v: any = new venueMod.Venue();
  const m = { display: "SOL-PERP", symbol: "SOL/USDso:USDso", info: { poolAddress: "0x1111111111111111111111111111111111111111" } };
  v.exchange = { fetchOrderBook: async () => ({ asks: [[100.8, 1]], bids: [[99.2, 1]] }) };
  v.markets.set("SOL", m);
  v.mark = async () => 100;
  await assert.rejects(v.open({ owner: addr(0xb2), operator: addr(0xbb) }, "SOL", "long", 50, { maxTouchPct: LIMITS.cardCopyMaxTouchPct }), /thin.*more than 0\.5%/);
  assert.equal(await v.touch(m, "long", 100), 100.8); // default 1.5%
});

test("T8: 10 copies in an hour -> counters at 10, at most 6 pings; the first ping is delivered", async () => {
  const h = makeBot();
  const card = await withCard(h);
  for (let i = 0; i < 10; i++) {
    const id = 400 + i;
    h.addUser(id, addr(0xc00 + i));
    await h.handle(cb(id, `cx:${await preview(h, id, card.id)}:0`));
  }
  assert.equal(h.state.opens.length, 10);
  assert.equal(card.copies, 10);
  const pings = pingsTo(h, SHARER);
  assert.equal(pings.length, LIMITS.pingsPerHour);
  assert.match(pings[0]!.html, /Your SOL long card was copied \(25\.00 USDso x 5x\)/);
  assert.equal(h.attempts.filter((c) => c === SHARER).length, LIMITS.pingsPerHour, "silent above the limit");
});

test("T8: a sharer who blocked the bot gets marked and no more ping attempts; any update from them clears it", async () => {
  const h = makeBot();
  const card = await withCard(h);
  h.blocked.add(SHARER);
  h.addUser(401, addr(0xc01));
  h.addUser(402, addr(0xc02));
  await h.handle(cb(401, `cx:${await preview(h, 401, card.id)}:0`));
  assert.ok(h.bot.store.get(SHARER).blockedAt, "403 'blocked by the user' sets blockedAt");
  const tries = h.attempts.filter((c) => c === SHARER).length;
  assert.equal(tries, 1);
  await h.handle(cb(402, `cx:${await preview(h, 402, card.id)}:0`));
  assert.equal(h.attempts.filter((c) => c === SHARER).length, 1, "no attempt while blocked");
  assert.equal(card.copies, 2);
  h.blocked.delete(SHARER);
  await h.dispatch(msg(SHARER, "/invite"));
  assert.equal(h.bot.store.get(SHARER).blockedAt, undefined);
  assert.match(h.to(SHARER).at(-1)!.html, /copies: 2/);
});

test("/invite shows the r_ link, joins through links and cards, and 30-day card totals", async () => {
  const h = makeBot();
  const card = await withCard(h);
  await h.handle(msg(200, `/start c_${card.id}`));
  await h.handle(msg(SHARER, "/invite"));
  const s = h.to(SHARER).at(-1)!.html;
  assert.match(s, new RegExp(`start=r_${h.bot.store.get(SHARER).ref}`));
  assert.match(s, /joined through your links and cards: 1/);
  assert.match(s, /Cards made: 1 · taps: 1 · new traders: 1 · copies: 0/);
  assert.ok(!s.includes(HASH));
});

test("store: cards are capped per user and pruned after 30 days", async () => {
  const h = makeBot();
  const st = h.bot.store;
  for (let i = 0; i < LIMITS.cardsPerUser + 5; i++) st.addCard({ by: 1, base: "ETH", side: "long", entry: 1, price: 1, pnl: 0, open: false, at: 1_000 + i });
  assert.equal(st.cardsBy(1).length, LIMITS.cardsPerUser);
  assert.equal(st.cardsBy(1).at(-1).at, 1_005, "the oldest went first");
  const fresh = st.addCard({ by: 2, base: "ETH", side: "long", entry: 1, price: 1, pnl: 0, open: false, at: Date.now() });
  assert.equal(st.pruneCards(Date.now()), LIMITS.cardsPerUser);
  assert.ok(st.card(fresh.id));
  assert.equal(st.card("__proto__"), undefined);
});
