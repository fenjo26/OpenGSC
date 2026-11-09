// wave-ext E5 — does a Google snippet's text appear on the page it describes? Pure string
// work, tested in snippet.test.ts. Used by /api/ext/cloak to catch the "SERP shows one thing,
// the visitor sees another" shape that a plain HTML diff calls clean.
//
// Two real-world shapes the matching must survive (found the hard way, 2026-11-09):
//   • Google snippets drop words the page has — "Search engine optimization (SEO) is the
//     process…" becomes "…optimization is the process…". A whole-fragment substring dies on
//     that, so a fragment matches when ≥ 60% of its 3-word shingles are in the page text.
//   • The fetcher's bodyText can hit its 40 K cap inside a nav wall before the article (a
//     mobile Wikipedia serve put 73 language names first). The cloak route therefore matches
//     against bodyText PLUS htmlToText(htmlRaw); the stripper lives here, pure and tested.

/** Split a snippet into comparable fragments: leading date stripped (Google prepends it in
 *  several locales), cut on ellipses, normalised (lower case, NFKC, punctuation → space,
 *  whitespace collapsed), fragments under 4 words dropped. */
export function snippetFragments(snippet: string): string[] {
  const raw = String(snippet ?? "").normalize("NFKC");
  // Day-first ("12 мар. 2025 г. —", "12 Μαρτίου 2025 —") and month-first ("Mar 12, 2025 —").
  const withoutDate = raw.replace(
    /^\s*(?:\d{1,2}[\s.]+\S{2,12}?[\s.,]+\d{4}|\S{3,12}[\s.]+\d{1,2},?\s+\d{4})\s*(г\.?|p\.?|μ\.?|e\.?|ε\.?)?\s*[—–-]\s*/u,
    "",
  );
  return withoutDate
    .split(/\.{3}|…/u)
    .map(normalize)
    .filter(f => f.split(/\s+/).filter(Boolean).length >= 4);
}

function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    // punctuation and symbols become spaces; letters/digits/spacing survive
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** ≥ 60% of the fragment's 3-word shingles present in the page text — tolerant to the words
 *  Google drops (parentheses, abbreviations), strict enough that unrelated text reads false. */
const SHINGLE = 3;
const FRAGMENT_COVER = 0.6;

function fragmentMatches(fragment: string, page: string): boolean {
  const words = fragment.split(" ").filter(Boolean);
  if (words.length < SHINGLE) return page.includes(fragment);
  const shingles: string[] = [];
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    shingles.push(words.slice(i, i + SHINGLE).join(" "));
  }
  let hit = 0;
  for (const sh of shingles) if (page.includes(sh)) hit++;
  return hit / shingles.length >= FRAGMENT_COVER;
}

/** null when either side is empty (nothing was sent / nothing could be read — "not checked",
 *  never "not found"); true when at least half of the fragments (rounded up) match. */
export function snippetFound(snippet: string, pageText: string): boolean | null {
  const fragments = snippetFragments(snippet);
  const page = normalize(String(pageText ?? ""));
  if (!fragments.length || !page) return null;
  const hit = fragments.filter(f => fragmentMatches(f, page)).length;
  return hit >= Math.ceil(fragments.length / 2);
}

/** Visible-ish text from raw HTML for the bodyText-cap fallback: strips script/style blocks,
 *  then all tags, decodes the common entities, collapses whitespace. Not a renderer — text
 *  that only exists after JS stays invisible to it, and that is fine: the question is whether
 *  the snippet's words are in what the server actually sent. */
export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, d: string) => {
      try { return String.fromCodePoint(Number(d)); } catch { return " "; }
    })
    .replace(/\s+/g, " ")
    .trim();
}
