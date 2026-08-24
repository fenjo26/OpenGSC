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

/**
 * Strips the writer model's own self-check lines that leaked into shipped articles:
 * "Double check word count: / Section 1: 121 words. / Total: 211 words. (201-225 range
 * met perfectly)". Observed verbatim in a completed generation on 2026-08-16, sitting in
 * the article body between the meta block and the first heading.
 *
 * Line-anchored on purpose: it only removes lines whose whole shape is a scratch note, so
 * it cannot eat legitimate prose that happens to contain the word "total" or "section".
 */
export function stripModelScratch(md: string): string {
  return md
    .replace(/^\s*double[- ]check(ing)?\s+word\s+count:?\s*\d*.*$/gim, "")
    .replace(/^\s*(section|секция|раздел)\s+\d+\s*:\s*\d+\s+words?\.\s*$/gim, "")
    .replace(/^\s*total:\s*\d+\s+words?\.\s*\(.*?\)\.?\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strips page furniture a URL scrape drags into the rewrite source: contact widgets
 * (WhatsApp/Viber/Telegram lines), booking-form confirmation lines ("Ευχαριστούμε! Θα
 * επικοινωνήσουμε…", "Thank you! We will contact…"), and cross-sell links ending in "→".
 *
 * Why this matters: the rewrite prompt demands the source's structure be preserved EXACTLY,
 * so every furniture line in the source comes back in the rewrite — and the QA judge then
 * correctly rejects the draft for containing buttons and form confirmations (observed on
 * skgclean.gr, 2026-08-24: a faithful rewrite rejected twice for furniture the SCRAPER
 * included). Patterns are deliberately conservative and language-independent: brand tokens,
 * thank-you line openers, and arrow-terminated lines. Applied to URL-mode sources only.
 */
export function stripPageFurniture(md: string): string {
  return md
    // Contact widgets — brand tokens are the same in every language.
    .replace(/^[^\n]{0,80}\b(whats\s?app|viber|telegram|messenger)\b[^\n]{0,80}$/gim, "")
    // Booking-form confirmations: the line OPENS with a thank-you word, whatever the locale.
    .replace(/^(ευχαριστ[oο]ύμε|ευχαριστώ|thank you|merci|gracias|danke|спасибо|дякую|teşekkürler|dziękujemy|obrigad[oa])[^\n]{0,140}$/gim, "")
    // Cross-sell / "see service" links that end in an arrow, whatever the label.
    .replace(/^[^\n]{0,100}→[^\n]{0,20}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
