// Plagiarism check, step 2 — pick the fragments worth searching (pure). Every fragment becomes
// one quoted SERP query, i.e. one line on somebody's bill, so the picker is the pricing lever:
// at most `max` fragments, each rare enough that a match means copying rather than coincidence.
//
// "Rare" is measured without a frequency dictionary: average word length up, stop-word share
// down. metaFit.ts keeps proper per-language stop lists but does not export them, so this is a
// merged list of the same service words — the score is comparative between candidates of one
// text, never an absolute claim about a language.

import { tokenizeWords } from "./text";

/** Service words across the languages OpenGSC ships (the same families metaFit.ts holds per language). */
const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those", "is", "are",
  "was", "were", "be", "been", "being", "to", "of", "in", "on", "at", "by", "for", "with", "without", "from",
  "as", "it", "its", "you", "your", "we", "our", "they", "their", "he", "she", "his", "her", "not", "no",
  "can", "will", "would", "should", "could", "may", "might", "must", "have", "has", "had", "do", "does",
  "did", "there", "here", "what", "which", "who", "when", "where", "how", "all", "any", "more", "most",
  "other", "some", "such", "only", "own", "same", "so", "too", "very", "just", "also", "into", "over",
  "about", "after", "before", "between", "during", "under", "again", "further", "once", "because", "while",
  // Russian / Ukrainian
  "и", "или", "но", "а", "не", "что", "как", "это", "для", "с", "со", "без", "в", "на", "по", "от", "к",
  "у", "за", "из", "о", "об", "же", "бы", "ли", "при", "чтобы", "есть", "быть", "был", "была", "были",
  "та", "і", "або", "щоб", "цей", "ця", "це", "як", "коли", "де", "які",
  // German
  "und", "oder", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "eines", "für", "mit",
  "ohne", "zu", "zur", "zum", "im", "auf", "an", "von", "vom", "bei", "ist", "sind", "war", "waren",
  // French / Spanish / Italian / Portuguese
  "de", "des", "du", "au", "aux", "et", "ou", "pour", "avec", "sans", "dans", "par", "sur", "le", "la",
  "les", "un", "une", "ni", "ne", "que", "chez", "sous", "del", "y", "u", "por", "con", "sin", "el",
  "los", "las", "una", "di", "della", "dei", "e", "ed", "o", "od", "per", "da", "su", "tra", "il", "lo",
  "do", "da", "dos", "das", "em", "no", "na", "os", "as", "um",
  // Greek
  "και", "ή", "για", "με", "χωρίς", "σε", "από", "του", "της", "των", "το", "την", "τη", "τα", "ο", "η",
  "οι", "στις", "στο", "στην",
]);

/** The contract's ceiling — one fragment is one paid SERP query (CONTRACT.md §0.5). */
export const MAX_FRAGMENTS = 10;

export const MIN_FRAGMENT_WORDS = 8;
export const MAX_FRAGMENT_WORDS = 25;

export interface Fragment {
  /** The sentence as it appears in the normalized text (this exact string goes into the query). */
  text: string;
  /** Character offset in the normalized text, for highlighting matches in the UI. */
  start: number;
}

interface Candidate extends Fragment {
  wordCount: number;
  score: number;
}

function hasDigits(words: string[]): boolean {
  return words.some((w) => /\p{N}/u.test(w));
}

/**
 * Distinctive tokens of the keyword (≥ 4 letters): brand and product names. A fragment quoting
 * the brand matches the site's own category page, not a copy — and every generated article is
 * saturated with the keyword, so without this filter the picker would throw most samples away.
 */
function keywordTokens(keyword: string): Set<string> {
  return new Set(tokenizeWords(keyword).filter((w) => w.length >= 4));
}

/**
 * Rarity = mean word length × (1 − stop-word share). Both factors are weak alone ("very nice
 * casino" is short on stop words; "the of and" is long in nothing) and point the same way
 * together: specific vocabulary, little glue.
 */
function rarityScore(words: string[]): number {
  let stop = 0;
  let len = 0;
  for (const w of words) {
    if (STOP_WORDS.has(w)) stop++;
    len += w.length;
  }
  const avgLen = len / words.length;
  return avgLen * (1 - stop / words.length);
}

/**
 * Filter + rank sentence candidates. Pure export so the route can tell the user WHY a text
 * yielded nothing ("no sentence of 8–25 words without digits" is actionable, "error" is not).
 */
export function eligibleFragments(sentences: { text: string; start: number }[], keyword = ""): Candidate[] {
  const brands = keywordTokens(keyword);
  const out: Candidate[] = [];
  for (const s of sentences) {
    const words = tokenizeWords(s.text);
    if (words.length < MIN_FRAGMENT_WORDS || words.length > MAX_FRAGMENT_WORDS) continue;
    if (hasDigits(words)) continue;
    if (words.some((w) => brands.has(w))) continue;
    out.push({ text: s.text, start: s.start, wordCount: words.length, score: rarityScore(words) });
  }
  return out;
}

/**
 * At most `max` fragments, spread evenly over the text: the candidates are split into `max`
 * position buckets and the rarest sentence of each bucket wins. Taking the top-N by score
 * alone would sample one dense paragraph — a single copied block in the middle would be missed
 * exactly where it sits.
 */
export function pickFragments(
  sentences: { text: string; start: number }[],
  opts: { keyword?: string; max?: number } = {},
): Fragment[] {
  const max = Math.max(1, Math.min(MAX_FRAGMENTS, opts.max ?? MAX_FRAGMENTS));
  const candidates = eligibleFragments(sentences, opts.keyword ?? "");
  if (candidates.length <= max) return candidates.map(({ text, start }) => ({ text, start }));
  const out: Fragment[] = [];
  const bucket = candidates.length / max;
  for (let i = 0; i < max; i++) {
    const slice = candidates.slice(Math.floor(i * bucket), i === max - 1 ? candidates.length : Math.floor((i + 1) * bucket));
    // A bucket can be empty only when max > candidates.length, which is excluded above.
    const best = slice.reduce((a, b) => (b.score > a.score ? b : a), slice[0]);
    out.push({ text: best.text, start: best.start });
  }
  return out;
}
