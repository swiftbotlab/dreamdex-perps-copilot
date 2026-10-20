import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { KeyVault } from "../src/keys.ts";

const master = "11".repeat(32);

test("keys round-trip and match the address", () => {
  const v = new KeyVault(master);
  const { address, sealed } = v.create(42);
  const pk = v.open(42, sealed);
  assert.equal(privateKeyToAccount(pk).address, address);
  assert.ok(!JSON.stringify(sealed).includes(pk.slice(2)));
});

test("a sealed key does not open for another user (AAD) or another master", () => {
  const v = new KeyVault(master);
  const { sealed } = v.create(42);
  assert.throws(() => v.open(43, sealed));
  assert.throws(() => new KeyVault("22".repeat(32)).open(42, sealed));
  const tampered = { ...sealed, ct: Buffer.from(Buffer.from(sealed.ct, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
  assert.throws(() => v.open(42, tampered));
});

test("bad master key is refused", () => {
  assert.throws(() => new KeyVault("abc"));
});
