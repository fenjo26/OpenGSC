// Pure extraction of a publishable {title, markdown} out of a SeoHistory row.
//
// Split out of store.ts on purpose: the calibration tool (calibrate.ts) needs to run the
// SAME extraction over the same rows without dragging prisma (and its read-write client)
// into a script that promised to be read-only. store.ts re-exports both helpers, so no
// importer changes.

import { outlineToMarkdown } from "@/lib/seo/outlineFormat";

export function firstHeading(markdown: string): string {
  return /^#{1,6}\s+(.+)$/m.exec(markdown || "")?.[1]?.trim() || "";
}

/**
 * SeoHistory.data is JSON.stringify(item.data): for `text` the article string itself, for
 * `landing` an object whose body is `text` (when the landing step wrote one) or an outline to
 * serialize. Returns null when the record carries no publishable body — the caller reports
 * that instead of publishing an empty post.
 */
export function extractPostFromHistory(row: { type: string; keyword: string; data: string }): { title: string; markdown: string } | null {
  let data: unknown;
  try { data = JSON.parse(row.data); } catch { return null; }
  if (row.type === "text" && typeof data === "string" && data.trim()) {
    return { title: firstHeading(data) || row.keyword, markdown: data };
  }
  if (row.type === "landing" && data && typeof data === "object") {
    const obj = data as { text?: unknown; outline?: unknown };
    let markdown = typeof obj.text === "string" && obj.text.trim() ? obj.text : "";
    if (!markdown && obj.outline) markdown = outlineToMarkdown(obj.outline);
    if (markdown.trim()) return { title: firstHeading(markdown) || row.keyword, markdown };
  }
  return null;
}
