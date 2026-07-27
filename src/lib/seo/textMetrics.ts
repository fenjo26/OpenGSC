// Pure text metrics shared by the server-side rewriter and the client-side result editor.
//
// Split out of rewrite.ts because that module imports the scraper and cannot be pulled into a
// browser bundle. The editor needs to recompute these live as the user types — showing a uniqueness
// score that describes a draft the user has since edited is worse than showing none.

/** Word-trigram set, used for the similarity comparison below. */
function shingles(s: string, n = 3): Set<string> {
  const w = s.toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const set = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(" "));
  return set;
}

/** Uniqueness = 1 − word-trigram Jaccard similarity against the source, as a percentage. */
export function uniquenessPct(source: string, rewritten: string): number {
  const A = shingles(source), B = shingles(rewritten);
  if (!A.size || !B.size) return 100;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const sim = union ? inter / union : 0;
  return Math.max(0, Math.min(100, Math.round((1 - sim) * 100)));
}

export function wordCount(s: string): number {
  return (s.replace(/<[^>]+>/g, " ").match(/[\p{L}\p{N}]+/gu) || []).length;
}
