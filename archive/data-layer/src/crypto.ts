import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url. Delivered in links; only the hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Short random id for the share link. */
export function newSlug(): string {
  return randomBytes(8).toString("base64url");
}

// Webhook URLs are encrypted at rest with AES-256-GCM. Layout: iv(12) | tag(16) | ciphertext.
function webhookKey(): Buffer {
  const raw = process.env.GAMENIGHTLY_WEBHOOK_KEY;
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error("GAMENIGHTLY_WEBHOOK_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encryptWebhook(url: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", webhookKey(), iv);
  const ct = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptWebhook(blob: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", webhookKey(), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}
