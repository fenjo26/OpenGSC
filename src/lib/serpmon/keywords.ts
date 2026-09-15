// SERP Monitor — keyword import parsing. Pure: no server imports, tested without a database.
//
// One keyword per line, optional group after the first separator found. The separator rule is
// "first found, scanning left to right" rather than a priority list: a pasted list that mixes
// tab-indented groups with commas inside the keyword must split at the tab, and a plain CSV
// must split at its comma — so the earliest of TAB, ";" and "," wins, whichever it is. The
// tests pin this both ways.

/** Hard cap matching MySQL VARCHAR(191); SerpKeyword.keyword is stored normalised. */
const KEYWORD_MAX = 191;

/** Trim, collapse internal whitespace, lower-case (locale-free); null when empty or > 191 chars. */
export function normaliseKeyword(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (!s || s.length > KEYWORD_MAX) return null;
  return s;
}

export interface KeywordImport { rows: { keyword: string; group: string }[]; skipped: number; duplicates: number }

const SEPARATORS = ["\t", ";", ","];

/** A line is a header when its keyword part is literally "keyword" — with or without a group cell. */
const HEADER_KEYWORD = "keyword";

/** Group cells keep their case but get the same whitespace treatment as keywords. */
function cleanGroup(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, KEYWORD_MAX);
}

/**
 * Split a line at the first separator found, scanning left to right — not by separator priority.
 * Returns the keyword part and, when a separator exists, the group part after it.
 */
function splitLine(line: string): { keywordPart: string; groupPart: string | null } {
  let at = -1;
  for (const sep of SEPARATORS) {
    const i = line.indexOf(sep);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return { keywordPart: line, groupPart: null };
  return { keywordPart: line.slice(0, at), groupPart: line.slice(at + 1) };
}

/**
 * One keyword per line; optional group after TAB, ";" or "," — the first separator found wins.
 * A header line whose keyword is "keyword" is skipped without being counted. Blank lines and
 * lines longer than 191 chars are counted in `skipped`; a keyword already seen (they compare
 * after normalisation, so case and spacing differences collapse) is counted in `duplicates`.
 */
export function parseKeywordImport(raw: string): KeywordImport {
  const out: KeywordImport = { rows: [], skipped: 0, duplicates: 0 };
  const seen = new Set<string>();
  // Excel and friends prefix UTF-8 exports with a BOM; on the first line it would otherwise
  // glue itself to the keyword and turn "casino online" into an invisible different string.
  const text = raw.replace(/^\uFEFF/, "");
  for (const line of text.split(/\r\n|\r|\n/)) {
    const { keywordPart, groupPart } = splitLine(line);
    const keyword = normaliseKeyword(keywordPart);
    if (!keyword) {
      out.skipped++;
      continue;
    }
    if (keyword === HEADER_KEYWORD) continue; // the import box's own header line
    if (seen.has(keyword)) {
      out.duplicates++;
      continue;
    }
    seen.add(keyword);
    out.rows.push({ keyword, group: groupPart === null ? "" : cleanGroup(groupPart) });
  }
  return out;
}
