// wave-ext E5 — does a Google snippet's text appear on the page it describes? Pure string
// work, tested in snippet.test.ts. Used by /api/ext/cloak to catch the "SERP shows one thing,
// the visitor sees another" shape that a plain HTML diff calls clean.

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
    .toLowerCase()
    // punctuation and symbols become spaces; letters/digits/spacing survive
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** null when either side is empty (nothing was sent / nothing could be read — "not checked",
 *  never "not found"); true when at least half of the fragments (rounded up) are substrings of
 *  the normalised page text. */
export function snippetFound(snippet: string, pageText: string): boolean | null {
  const fragments = snippetFragments(snippet);
  const page = normalize(String(pageText ?? "").normalize("NFKC"));
  if (!fragments.length || !page) return null;
  const hit = fragments.filter(f => page.includes(f)).length;
  return hit >= Math.ceil(fragments.length / 2);
}
