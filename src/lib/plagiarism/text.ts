// Plagiarism check, step 1 — reduce an article to plain prose sentences (pure, no Prisma,
// no network). The quoted-phrase queries in index.ts work on exact word sequences, so every
// piece of formatting that is not prose would be searched as if it were text and either find a
// false match (a markdown table row that also sits in a GitHub README) or, worse, make the
// fragment so weird that Google returns nothing and the check goes blind.

/** Words only — letters, digits and apostrophes, lower-cased. Punctuation is noise for shingles. */
export function tokenizeWords(s: string): string[] {
  const out = s.toLowerCase().match(/[\p{L}\p{N}']+/gu);
  return out ?? [];
}

const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`]*)`/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>")]+/gi;
const HTML_TAG = /<[^>]+>/g;
const EMPHASIS = /(\*\*|__|\*|_|~~)/g;
const HEADING = /^#{1,6}[^\n]*$/gm;
const TABLE_ROW = /^\|.*\|$/gm;
const LIST_BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/gm;

/**
 * The YAML meta block the generators prepend (`---\ntitle: …\n---`). Stolen wholesale it would
 * be a perfect plagiarism signal — and a perfectly wrong one: every generated article carries
 * the same block shape, and a quoted search for "title: Best Casino Bonuses" matches nothing
 * but our own template.
 */
function stripMetaBlock(s: string): string {
  if (!s.startsWith("---")) return s;
  const end = s.indexOf("\n---", 3);
  if (end === -1) return s;
  return s.slice(end + 4).replace(/^\s*\n/, "");
}

/**
 * Link-list lines: "Further reading:" followed by bullets that are ≥ 60 % URL by characters.
 * Navigation and "read more" blocks are boilerplate, not authorship — they are on every page
 * of the source site, which makes them the opposite of a rare fragment.
 */
function isLinkLine(line: string): boolean {
  const chars = line.replace(/\s/g, "");
  if (chars.length < 8) return false;
  let urlChars = 0;
  for (const m of line.matchAll(BARE_URL)) urlChars += m[0].length;
  return urlChars / chars.length >= 0.6;
}

/** Article markdown (or pasted plain text) → clean prose. */
export function normalizeTextForPlagiarism(raw: string): string {
  let s = String(raw ?? "");
  s = stripMetaBlock(s);
  s = s.replace(FENCE, " ").replace(INLINE_CODE, "$1");
  s = s.replace(IMAGE, " ").replace(LINK, "$1");
  s = s.replace(HTML_TAG, " ");
  s = s.replace(HEADING, "").replace(TABLE_ROW, " ");
  s = s.replace(LIST_BULLET, "").replace(EMPHASIS, "");
  // &amp; and friends survive when HTML is pasted as text; quoted search on the literal
  // "&amp;" would match other scraped copies, not the original article.
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const lines = s.split(/\r?\n/).filter((line) => !isLinkLine(line));
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export interface Sentence {
  text: string;
  /** Character offset of the sentence inside the normalized text (for highlighting). */
  start: number;
}

const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[\p{Lu}\p{Lt}"«„"'\[(])/gu;

/**
 * Split prose into sentences. The lookbehind boundary (terminator + whitespace + something
 * that starts a sentence) keeps "St. James" and "3.5" intact without an abbreviation table;
 * a mismatch just yields a longer candidate, which the 8–25 word filter in sample.ts handles.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_SPLIT)) {
    const idx = m.index ?? 0;
    const piece = text.slice(last, idx).trim();
    if (piece) out.push({ text: piece, start: text.indexOf(piece, last) });
    last = idx + m[0].length;
  }
  const tail = text.slice(last).trim();
  if (tail) out.push({ text: tail, start: text.indexOf(tail, last) });
  return out.filter((s) => s.text.length > 0);
}
