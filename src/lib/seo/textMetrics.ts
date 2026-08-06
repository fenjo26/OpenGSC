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

// ─── Keyword coverage ──────────────────────────────────────────────────────────

/** One target query, counted in the source and in the rewrite. */
export interface KeywordCoverageRow {
  keyword: string;
  volume: number | null;
  before: number;
  after: number;
  /** In the source and gone from the rewrite — the failure that costs traffic. */
  lost: boolean;
}

export interface KeywordCoverage {
  rows: KeywordCoverageRow[];
  /** Target phrases present in the rewrite at least once. */
  covered: number;
  /** Present in the source and absent from the rewrite. */
  lost: number;
  total: number;
}

/** Normalized for matching: tags stripped, punctuation flattened, whitespace collapsed. */
function flatten(s: string): string {
  return ` ${s.toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()} `;
}

function countPhrase(haystack: string, phrase: string): number {
  const needle = ` ${phrase.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()} `;
  if (needle.trim().length === 0) return 0;
  let n = 0, i = 0;
  // Overlapping occurrences are counted once each by stepping past the match's first word rather
  // than past the whole match — "seo seo services" contains "seo services" once, not zero times.
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) break;
    n++;
    i = at + 1;
  }
  return n;
}

/**
 * Which target queries survived the rewrite.
 *
 * Deterministic and model-free, deliberately — this sits next to `uniquenessPct` and `factDrift`
 * for the same reason they exist: the point of a rewriter is that nobody rereads two thousand
 * words, so the checks that matter have to be ones a machine can make. A dropped price is caught
 * by `factDrift`; a dropped ranking phrase was, until now, caught by nobody.
 *
 * Exact-phrase matching only. Stemming would report a keyword as "covered" when the page carries
 * an inflected variant that a search engine may or may not treat as equivalent, and a coverage
 * report that is optimistic is worse than none.
 */
export function keywordCoverage(
  source: string,
  rewritten: string,
  targets: { keyword: string; volume?: number | null }[],
): KeywordCoverage {
  const src = flatten(source);
  const out = flatten(rewritten);

  // Mapped over the objects, not over an extracted string list: filtering a projected array and
  // then indexing back into the original by position silently pairs each keyword with the volume
  // of a different one as soon as a single entry is dropped.
  const rows: KeywordCoverageRow[] = targets
    .map(t => ({ keyword: String(t.keyword || "").trim(), volume: t.volume ?? null }))
    .filter(t => t.keyword)
    .map(t => {
      const before = countPhrase(src, t.keyword);
      const after = countPhrase(out, t.keyword);
      return { keyword: t.keyword, volume: t.volume, before, after, lost: before > 0 && after === 0 };
    });

  return {
    rows,
    covered: rows.filter(r => r.after > 0).length,
    lost: rows.filter(r => r.lost).length,
    total: rows.length,
  };
}
