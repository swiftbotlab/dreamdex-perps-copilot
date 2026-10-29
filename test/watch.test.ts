// /watch: read-only liquidation pings for any account. Validation, caps, rate limit, unwatch, buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addr, cb, LIMITS, makeBot, msg } from "./_harness.ts";

const A = (n: number) => addr(0xe000 + n);
const last = (h: ReturnType<typeof makeBot>, id: number) => h.to(id).at(-1)!.html;

test("T10: /watch with an address creates the user record (no link) and confirms with the account view", async () => {
  const h = makeBot();
  assert.equal(h.bot.store.get(1), undefined);
  await h.handle(msg(1, `/watch ${A(1)}`));
  const u = h.bot.store.get(1)!;
  assert.ok(u, "user record made");
  assert.equal(u.owner, undefined);
  assert.deepEqual(u.watches.map((w: { addr: string }) => w.addr.toLowerCase()), [A(1)]);
  assert.match(last(h, 1), /Watching/);
  assert.match(last(h, 1), /equity 500\.00 USDso/);
  assert.deepEqual(h.watchRefreshes.map((a) => a?.toLowerCase()), [A(1)], "the new address is read once");
  const data = h.cbData(h.to(1).at(-1));
  assert.deepEqual(data, [`wg:${A(1).slice(2)}`, `uw:${A(1).slice(2)}`]);
});

test("T10: a bare /watch or /unwatch from a stranger makes no record", async () => {
  const h = makeBot();
  await h.handle(msg(2, "/watch"));
  await h.handle(msg(2, "/unwatch"));
  assert.equal(h.bot.store.get(2), undefined);
  assert.match(h.to(2)[0]!.html, /Read only: no link, no key, no trading/);
});

test("T10: 3 watches per user, the 4th refused; bad and zero addresses refused; a 6th add within 10 min refused", async () => {
  const h = makeBot();
  for (let i = 1; i <= 3; i++) { await h.handle(msg(1, `/watch ${A(i)}`)); assert.match(last(h, 1), /Watching/); }
  await h.handle(msg(1, `/watch ${A(4)}`));
  assert.match(last(h, 1), /up to 3 accounts/);
  for (const bad of ["0x123", "hello", `0x${"g".repeat(40)}`, `${A(5)}00`, "0x0000000000000000000000000000000000000000"]) {
    await h.handle(msg(1, `/watch ${bad}`));
    assert.match(last(h, 1), /not an account address|zero address/, bad);
  }
  assert.equal(h.bot.store.get(1).watches.length, 3);
  // 4 rate-limited adds so far (3 OK + 1 over the cap). Unwatch + re-add is the 5th; the 6th is refused.
  await h.handle(msg(1, `/unwatch ${A(1)}`));
  assert.match(last(h, 1), /Stopped watching/);
  await h.handle(msg(1, `/watch ${A(1)}`));
  assert.match(last(h, 1), /Watching/);
  await h.handle(msg(1, `/unwatch ${A(1)}`));
  await h.handle(msg(1, `/watch ${A(1)}`));
  assert.match(last(h, 1), /Too many \/watch requests/);
  assert.equal(h.bot.store.get(1).watches.length, 2);
});

test("T10: the global cap of distinct watched addresses holds; an address someone already watches is still accepted", async () => {
  const h = makeBot();
  let n = 0;
  for (let id = 1000; n < LIMITS.watchedMax; id++) {
    const u = h.addUser(id);
    u.watches = [];
    for (let k = 0; k < LIMITS.watchesPerUser && n < LIMITS.watchedMax; k++) u.watches.push({ addr: A(100 + n++), at: 0 });
  }
  h.bot.store.save();
  assert.equal(h.bot.store.watchedAddresses().length, LIMITS.watchedMax);
  await h.handle(msg(5, `/watch ${A(999)}`));
  assert.match(last(h, 5), /Watch mode is full/);
  await h.handle(msg(5, `/watch ${A(100)}`));
  assert.match(last(h, 5), /Watching/);
});

test("T10: /unwatch, the Unwatch button and the Guard it button", async () => {
  const h = makeBot();
  await h.handle(msg(1, `/watch ${A(1)}`));
  await h.handle(msg(1, `/watch ${A(2)}`));
  await h.handle(msg(1, "/unwatch"));
  assert.match(last(h, 1), /Which one/);
  await h.handle(cb(1, `uw:${A(2).slice(2)}`));
  assert.deepEqual(h.bot.store.get(1).watches.map((w: { addr: string }) => w.addr.toLowerCase()), [A(1)]);
  await h.handle(msg(1, `/unwatch ${A(7)}`));
  assert.match(last(h, 1), /not watching that account/);
  await h.handle(cb(1, `wg:${A(1).slice(2)}`));
  assert.match(last(h, 1), new RegExp(`/link ${"0x"}`, "i"));
  assert.match(last(h, 1), /cannot|never withdraw/);
  h.bot.store.get(1).owner = A(9);
  await h.handle(cb(1, `wg:${A(1).slice(2)}`));
  assert.match(last(h, 1), /One account per Telegram user/);
  for (const bad of [`uw:${A(1).slice(2).toUpperCase()}`, `wg:${A(1).slice(3)}`, "uw:", `uw:${A(1).slice(2)}:x`]) await h.handle(cb(1, bad));
  assert.match(last(h, 1), /One account per Telegram user/, "malformed buttons do nothing");
  await h.handle(msg(1, "/unwatch"));
  assert.match(last(h, 1), /Stopped watching/);
  assert.equal(h.bot.store.get(1).watches, undefined);
});

test("T10: the Guard it button is hidden for your own linked account; /watch lists from the cache only", async () => {
  const h = makeBot();
  h.addUser(1, A(1));
  await h.handle(msg(1, `/watch ${A(1)}`));
  assert.deepEqual(h.cbData(h.to(1).at(-1)), [`uw:${A(1).slice(2)}`]);
  const calls = h.state.accountCalls;
  await h.handle(msg(1, "/watch"));
  assert.match(last(h, 1), /Watched accounts/);
  assert.equal(h.state.accountCalls, calls, "no new chain read");
});

test("/demo's Watch this account button works before /start", async () => {
  const h = makeBot();
  await h.handle(cb(9, "wd"));
  assert.deepEqual(h.bot.store.get(9).watches.map((w: { addr: string }) => w.addr), ["0x2A11e7388D1D2F9690f2636846d44b478f61bF08"]); // the current demo account
});

test("watch-only users are kept by the 48 h unlinked-user prune; plain unlinked users are not", async () => {
  const h = makeBot();
  const watcher = h.addUser(1); watcher.created = 0; watcher.watches = [{ addr: A(1), at: 0 }];
  const idle = h.addUser(2); idle.created = 0;
  assert.equal(h.bot.store.pruneUnlinked(48 * 3_600_000), 1);
  assert.ok(h.bot.store.get(1));
  assert.equal(h.bot.store.get(2), undefined);
});
