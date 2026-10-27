import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  return scryptSync(config.masterKey, "omnix-streamrelay", 32);
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const d = createDecipheriv(ALGO, key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function maskKey(key: string): string {
  if (key.length <= 6) return "******";
  return `${key.slice(0, 3)}…${key.slice(-3)}`;
}
