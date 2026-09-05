// ─── Layer A: AI marks scrub ─────────────────────────────────────────────────────
// Models occasionally leave invisible fingerprints in their output — zero-width spaces,
// word joiners, soft hyphens, bidi controls, Unicode tag characters, private-use code
// points — that no reader sees but any scanner finds with a trivial grep. This module is
// the deterministic pass that strips them. Scope note, same honesty as maskAIPatterns:
// removing hidden characters cannot touch a statistical watermark spread across token
// choices. What it buys is hygiene — the text a publisher receives should not contain
// characters its CMS, spellchecker, or copy-paste can trip over.
//
// The pass is deliberately conservative about what counts as a "mark". Legitimate uses are
// preserved: ZWJ inside emoji sequences, variation selectors that color emoji, ZWNJ in
// Arabic and Indic scripts where spelling depends on it, tag characters inside the
// black-flag sequences that encode subdivision flags (🏴󠁧󠁢󠁥󠁮󠁧󠁿). Everything else invisible goes.

export type MarkClass =
  | "zeroWidth"        // ZWSP, word joiner, invisible operators, BOM, U+180E — always junk
  | "bidi"             // embedding / override / isolate controls
  | "tag"              // tag characters outside a flag-tag sequence
  | "softHyphen"       // U+00AD
  | "exoticSpace"      // NBSP and friends → plain space
  | "control"          // C0 / C1 / DEL except \t \n \r
  | "privateUse"       // renders as tofu everywhere
  | "noncharacter"     // permanently unassigned code points
  | "variationSelector" // VS16 etc. outside an emoji context
  | "quote";           // curly quotes → straight (Latin-quote text only, see below)

export interface MarkScan {
  total: number;
  byClass: Partial<Record<MarkClass, number>>;
}

export interface ScrubResult extends MarkScan {
  text: string;
}

export interface ScrubOptions {
  /** Straighten curly quotes when the text uses Latin-style quoting (default true). */
  quotes?: boolean;
}

// A lone format character only means something in a script whose orthography requires it.
const JOINER_SCRIPT =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0D80-\u0DFF]/;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Guillemets and low quotes mark a locale whose quote style is correct as written
// (fr «…», de „…“); straightening curly quotes there would only break typography.
const NON_LATIN_QUOTES = /[«»„‚]/;

const ZERO_WIDTH = new Set([0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x180e]);
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const SPACES = new Map<number, string>([
  [0x00a0, " "], [0x1680, " "], [0x202f, " "], [0x205f, " "], [0x3000, " "],
  [0x2028, "\n"], [0x2029, "\n"],
  ...Array.from({ length: 11 }, (_, k) => [0x2000 + k, " "] as [number, string]),
]);
const QUOTES = new Map<number, string>([
  [0x201c, '"'], [0x201d, '"'], [0x2018, "'"], [0x2019, "'"],
]);

const bump = (counts: Partial<Record<MarkClass, number>>, c: MarkClass) => {
  counts[c] = (counts[c] ?? 0) + 1;
};

interface ProcessResult extends ScrubResult {
  changed: boolean;
}

function process(text: string, dryRun: boolean, applyQuotes: boolean): ProcessResult {
  // Decided once for the whole text, not per character.
  const straightenQuotes = applyQuotes && !NON_LATIN_QUOTES.test(text);
  const counts: Partial<Record<MarkClass, number>> = {};
  let total = 0;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    // A black flag followed by a full tag run is a real subdivision flag: copy verbatim.
    // Tag characters live on plane 14 — every one of them is an astral surrogate pair.
    if (cp === 0x1f3f4) {
      let j = i + 2;
      let complete = false;
      while (j < text.length) {
        const t = text.codePointAt(j)!;
        if (t === 0xe007f) { complete = true; j += 2; break; }
        if (t >= 0xe0020 && t <= 0xe007e) { j += 2; continue; }
        break;
      }
      out.push(complete ? text.slice(i, j) : text.slice(i, i + 2));
      i = complete ? j : i + 2;
      continue;
    }
    // Context keepers first: ZWNJ in a joining script, ZWJ/VS next to a pictographic.
    if (cp === 0x200c || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) {
      const prev = text.slice(Math.max(0, i - 2), i);
      const next = text.slice(i + 1, i + 3);
      const keep =
        cp === 0x200c
          ? JOINER_SCRIPT.test(prev) || JOINER_SCRIPT.test(next)
          : PICTOGRAPHIC.test(prev) || PICTOGRAPHIC.test(next);
      if (keep) { out.push(text.slice(i, i + size)); }
      else {
        bump(counts, cp === 0x200c || cp === 0x200d ? "zeroWidth" : "variationSelector");
        total++;
      }
      i += size;
      continue;
    }
    if (ZERO_WIDTH.has(cp)) { bump(counts, "zeroWidth"); total++; i += size; continue; }
    if (BIDI.has(cp)) { bump(counts, "bidi"); total++; i += size; continue; }
    if (cp === 0x00ad) { bump(counts, "softHyphen"); total++; i += size; continue; }
    const space = SPACES.get(cp);
    if (space !== undefined) {
      bump(counts, "exoticSpace"); total++;
      if (!dryRun) out.push(space);
      i += size;
      continue;
    }
    if (straightenQuotes && QUOTES.has(cp)) {
      bump(counts, "quote"); total++;
      if (!dryRun) out.push(QUOTES.get(cp)!);
      i += size;
      continue;
    }
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      bump(counts, "control"); total++; i += size; continue;
    }
    if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd) || (cp >= 0xe0100 && cp <= 0xe01ef)) {
      bump(counts, "privateUse"); total++; i += size; continue;
    }
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      // Reached only outside a flag run: an orphaned tag character.
      bump(counts, "tag"); total++; i += size; continue;
    }
    if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xffff) === 0xfffe || (cp & 0xffff) === 0xffff) {
      bump(counts, "noncharacter"); total++; i += size; continue;
    }
    if (!dryRun) out.push(text.slice(i, i + size));
    i += size;
  }
  let result = dryRun ? "" : out.join("");
  // Removing invisible characters can leave doubled spaces behind (a soft hyphen inside a
  // word would not, but a dropped control between two spaces does).
  if (!dryRun && total > 0) result = result.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n");
  return { text: result, total, byClass: counts, changed: total > 0 };
}

/** Count the marks without changing anything — for the analyzer panels and diagnostics. */
export function scanMarks(text: string): MarkScan {
  const r = process(text, true, true);
  return { total: r.total, byClass: r.byClass };
}

/** Strip every mark that is not serving a legitimate purpose. Free and deterministic. */
export function scrubMarks(text: string, opts?: ScrubOptions): ScrubResult {
  const r = process(text, false, opts?.quotes !== false);
  return { text: r.text, total: r.total, byClass: r.byClass };
}
