import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DDMVP_WASM = new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url).pathname;
const { cardSvg, renderCard, returnPct } = await import("../src/card.ts");

const base = { base: "ETH", side: "long" as const, leverage: 5, entry: 2000, price: 2100, pnl: 1, open: true, botUsername: "SwiftPerpsBot", ref: "a1b2c3d4e5", when: new Date(0) };

test("return on margin and price move", () => {
  assert.equal(returnPct(base).pct.toFixed(2), "25.00");
  assert.equal(returnPct({ ...base, leverage: undefined }).pct.toFixed(2), "5.00");
  assert.equal(returnPct({ ...base, side: "short" }).pct.toFixed(2), "-25.00");
});

test("card refuses unvalidated text", () => {
  assert.throws(() => cardSvg({ ...base, base: "<script>" }));
  assert.throws(() => cardSvg({ ...base, botUsername: "a\"onload" }));
  assert.throws(() => cardSvg({ ...base, ref: "../../x" }));
});

test("card renders a PNG with the deep link", async () => {
  assert.match(cardSvg(base), /t\.me\/SwiftPerpsBot\?start=r_a1b2c3d4e5/);
  const png = await renderCard({ ...base, spark: [1, 2, 3, 2, 4, 5, 4, 6, 7] });
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.length > 20_000);
});
