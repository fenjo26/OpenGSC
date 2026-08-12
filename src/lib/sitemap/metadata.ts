import { createHash } from "node:crypto";

/** A deliberately lossy fingerprint: scripts, styles and markup churn should not impersonate a content edit. */
export function contentFingerprint(content: string, contentType = "text/html"): string {
  const normalized = /html|xml/i.test(contentType)
    ? content
        .replace(/<!--([\s\S]*?)-->/g, " ")
        .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    : content;
  return createHash("sha256").update(normalized).digest("hex");
}

export function extractContentTitle(html: string): string | null {
  return html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || null;
}

export type LastmodReliability = "unknown" | "reliable" | "suspicious";

/** Compare two explicit observations; a missing baseline is unknown, never a failure. */
export function assessLastmodReliability(input: {
  previousHash: string | null;
  currentHash: string;
  previousLastmod: string | null;
  currentLastmod: string | null;
  previousReliability?: string | null;
}): LastmodReliability {
  if (!input.previousHash) return "unknown";
  const contentChanged = input.previousHash !== input.currentHash;
  const lastmodChanged = input.previousLastmod !== input.currentLastmod;
  if (contentChanged !== lastmodChanged) return "suspicious";
  if (contentChanged && lastmodChanged) return "reliable";
  return input.previousReliability === "suspicious" ? "suspicious" : "reliable";
}
