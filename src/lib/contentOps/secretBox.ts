import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(): Buffer {
  const secret = process.env.CONTENT_OPS_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 24) throw new Error("content_ops_secret_missing");
  return createHash("sha256").update(`opengsc-content-ops:${secret}`).digest();
}
/** Encrypt a GitHub token before it reaches the database. */
export function sealSecret(value: string): string {
  const plain = String(value ?? "").trim();
  if (!plain) throw new Error("missing_github_token");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function openSecret(box: string): string {
  const [version, ivRaw, tagRaw, dataRaw] = String(box ?? "").split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !dataRaw) throw new Error("invalid_secret_box");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("github_token_decrypt_failed");
  }
}
