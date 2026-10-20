// Per-user trading keys. Generated here, encrypted at rest with AES-256-GCM under a key derived
// (HKDF-SHA256) from the master secret; the Telegram user id is bound in as AAD, so a ciphertext
// copied onto another user's record does not decrypt. Private keys are never displayed or logged.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface SealedKey { v: 1; iv: string; ct: string; tag: string }

export class KeyVault {
  private readonly k: Buffer;
  constructor(masterHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterHex)) throw new Error("master key must be 32 bytes hex");
    this.k = Buffer.from(hkdfSync("sha256", Buffer.from(masterHex, "hex"), Buffer.from("swiftbotlab-ddmvp"), Buffer.from("user-trading-key-v1"), 32));
  }

  create(userId: number): { address: `0x${string}`; sealed: SealedKey } {
    const pk = generatePrivateKey();
    return { address: privateKeyToAccount(pk).address, sealed: this.seal(userId, pk) };
  }

  seal(userId: number, pk: `0x${string}`): SealedKey {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.k, iv);
    c.setAAD(Buffer.from(`tg:${userId}`));
    const ct = Buffer.concat([c.update(Buffer.from(pk.slice(2), "hex")), c.final()]);
    return { v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
  }

  open(userId: number, s: SealedKey): `0x${string}` {
    const d = createDecipheriv("aes-256-gcm", this.k, Buffer.from(s.iv, "base64"));
    d.setAAD(Buffer.from(`tg:${userId}`));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    const pt = Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]);
    if (pt.length !== 32) throw new Error("bad key length");
    return `0x${pt.toString("hex")}`;
  }
}
