// Deterministic fact-drift detection for rewritten text.
//
// Any rewrite — humanization, variant generation, a trim pass — can quietly change a number or drop
// a brand name, and that is the failure mode that actually costs an SEO operator money: an article
// that reads beautifully and states the wrong RTP, the wrong price, the wrong year. A note in the UI
// asking people to "check the facts" is not protection, because the whole point of a rewrite tool is
// that nobody rereads 2000 words.
//
// So this checks the two classes of fact that CAN be verified without a model and without a network
// call: numeric values, and identifier-shaped tokens (acronyms, model names, internal-caps brands).
// Everything else — claims, relationships, causality — is out of scope and honestly labelled as such
// in the UI rather than silently implied to be covered.
//
// Zero dependencies, pure functions, runs client-side in microseconds.

export interface DriftReport {
  /** present in the source, gone from the rewrite — a dropped fact */
  lost: string[];
  /** present in the rewrite but NOT in the source — invented, the dangerous direction */
  added: string[];
  /** how many source values survived unchanged */
  kept: number;
  /** nothing invented and nothing dropped */
  clean: boolean;
}

export interface FactDrift {
  numbers: DriftReport;
  /** acronyms / model names / internal-caps brands, e.g. RTP, MSRP, iPhone, PlayStation */
  identifiers: DriftReport;
  clean: boolean;
}

function stripMarkup(s: string): string {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`|#>]+/g, " ");
}

// Normalize a numeric literal so "1 000", "1,000" and "1000" compare equal, while a genuine change
// from 1000 to 1500 still shows up. Thousands separators differ by locale and this app is
// multilingual, so both the en (1,000.5) and eu (1.000,5) conventions are handled explicitly.
function normNum(raw: string): string {
  let s = raw.replace(/[\s  ]/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");          // 1,234,567.89
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");  // 1.234.567,89
  else s = s.replace(",", ".");
  // Drop a trailing decimal zero so 96.0 and 96 are the same fact.
  if (s.includes(".")) s = s.replace(/\.?0+$/, "") || "0";
  // Drop leading zeros: a source writing "0:00" and a rewrite writing "00:00" state the same
  // midnight, and reporting that as a lost value is noise of the same kind as currency notation.
  s = s.replace(/^0+(?=\d)/, "");
  return s;
}

// Symbol and word units are matched differently on purpose. A trailing \b cannot be used after a
// symbol — in "5%." the character after % is a period, and two non-word characters produce no word
// boundary, so the unit would silently drop off and "5%" would compare equal to a bare "5". Word
// units get a negative lookahead rather than \b for the mirror-image reason: JS \b is ASCII-only, so
// it never fires at the end of "грн" or "евро".
const SYM_UNIT = "%|€|\\$|£|₽|₴";
const WORD_UNIT = "zł|kr|usd|eur|gbp|pln|rub|uah|грн|гривен|гривень|руб|рублей|рубля|евро|долларов|доллара|долл|злотых";

// Collapse every spelling of a currency onto one code, so "$50", "50 USD" and "50 долларов" are
// recognized as the same amount. Without this the checker would cry drift every time a rewrite
// changed notation — and a checker that fires on non-problems gets ignored, which is worse than
// having none at all.
const UNIT_CANON: Record<string, string> = {
  "€": "EUR", "eur": "EUR", "евро": "EUR",
  "$": "USD", "usd": "USD", "долл": "USD", "доллара": "USD", "долларов": "USD",
  "£": "GBP", "gbp": "GBP",
  "₽": "RUB", "rub": "RUB", "руб": "RUB", "рубля": "RUB", "рублей": "RUB",
  "₴": "UAH", "uah": "UAH", "грн": "UAH", "гривен": "UAH", "гривень": "UAH",
  "zł": "PLN", "pln": "PLN", "злотых": "PLN",
  "kr": "KR", "%": "%",
};
const canonUnit = (u: string) => (u ? UNIT_CANON[u.toLowerCase()] ?? u.toLowerCase() : "");

// Number literal. Space-grouped thousands are matched ONLY as strict groups of three ("5 000",
// "2 400"), never as "any digits with whitespace between them".
//
// The permissive version glued neighbouring values together: stripMarkup removes table pipes, so a
// row like `| €45 | 20-25 λεπτά |` collapsed to "45  20" and came out as the number 4520 — a value
// present in neither document, reported in red as an invented fact. False alarms in the danger tier
// are the fastest way to make the whole check ignorable.
const NUM = "\\d{1,3}(?:[\\s\\u00A0]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)*";

// A numeric fact = the value plus whatever unit is welded to it. "96" and "96%" are different
// claims, and a rewrite that turns one into the other is exactly what we want to catch.
function extractNumbers(text: string): string[] {
  const s = stripMarkup(text);
  const out: string[] = [];
  const re = new RegExp(
    `(?:(${SYM_UNIT})\\s*)?(${NUM})[ \\u00A0]?(?:(${SYM_UNIT})|(${WORD_UNIT})(?![\\p{L}\\p{N}]))?`,
    "giu",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const num = normNum(m[2]);
    if (!num || num === ".") continue;
    // Suffix wins over prefix: "$5" and "5 USD" both normalize to the value plus one unit.
    const unit = canonUnit(m[3] || m[4] || m[1] || "");
    out.push(unit ? `${num} ${unit}` : num);
  }
  return out;
}

// Currency codes are handled by the number extractor as units, so they must not ALSO be counted as
// identifiers. A source writing "€30" and a rewrite writing "30 EUR" state the same price — the
// numeric comparison already canonicalizes both to "30 EUR", but without this exclusion the word
// EUR showed up as a brand-new identifier and the panel reported an invented value in red.
const UNIT_TOKENS = new Set(["EUR", "USD", "GBP", "RUB", "UAH", "PLN", "KR", "KM", "SEK", "NOK", "DKK", "CZK", "TRY", "CHF"]);

// Identifier-shaped tokens only: ALL-CAPS runs (RTP, MSRP, SSL) and internal-caps words (iPhone,
// PlayStation, McDonald). Deliberately NOT every capitalized word — sentence-initial capitals would
// flood the report with false positives, and in a multilingual tool there is no reliable, cheap way
// to tell a proper noun from the first word of a sentence.
function extractIdentifiers(text: string): string[] {
  const s = stripMarkup(text);
  const out: string[] = [];
  const re = /\b(?=\S*\p{Lu})[\p{L}\p{N}]*\p{Lu}[\p{L}\p{N}]*\b/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const w = m[0];
    if (w.length < 2) continue;
    const upper = (w.match(/\p{Lu}/gu) || []).length;
    if (UNIT_TOKENS.has(w.toUpperCase())) continue;
    const isAllCaps = upper === w.replace(/\p{N}/gu, "").length && upper >= 2;
    const hasInternalCaps = /\p{Ll}\p{Lu}/u.test(w);
    if (isAllCaps || hasInternalCaps) out.push(w);
  }
  return out;
}

// A value counts as lost only when it is ABSENT from the rewrite, not when it appears fewer times.
//
// The first version compared multisets and flagged any drop in occurrence count. On a real page it
// reported the brand name, PayPal and "24" as lost while all three were still in the text — the
// source simply repeated its booking notice seven times and the rewrite consolidated the phrasing.
// Seven noisy items buried the two that mattered. A checker that cries wolf gets switched off, and
// then it protects nothing: precision here is worth more than sensitivity.
function diff(src: string[], dst: string[]): DriftReport {
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const a = count(src), b = count(dst);
  const lost: string[] = [];
  const added: string[] = [];
  let kept = 0;
  for (const [k, n] of a) {
    const have = b.get(k) ?? 0;
    kept += Math.min(n, have);
    if (have === 0) lost.push(k);
  }
  for (const [k, n] of b) if (!a.has(k) && n > 0) added.push(k);
  return { lost, added, kept, clean: !lost.length && !added.length };
}

/**
 * Every checkable value in a text, deduplicated — the list a rewrite must carry over intact.
 *
 * Exported so the rewriter can put these IN THE PROMPT rather than only auditing the result
 * afterwards. Detecting a lost price and reporting it is strictly worse than not losing it: the
 * operator is refreshing a page that already lost rankings, and a rewrite that quietly drops
 * "book 48 hours ahead" makes the page worse, which is the opposite of the job.
 */
export function criticalValues(text: string, limit = 120): string[] {
  const nums = extractNumbers(text);
  const ids = extractIdentifiers(text);
  return Array.from(new Set([...nums, ...ids])).slice(0, limit);
}

export function factDrift(source: string, rewritten: string): FactDrift {
  const numbers = diff(extractNumbers(source), extractNumbers(rewritten));
  const identifiers = diff(extractIdentifiers(source), extractIdentifiers(rewritten));
  return { numbers, identifiers, clean: numbers.clean && identifiers.clean };
}

/** Severity for the UI: invented values outrank dropped ones — a wrong fact is worse than a gap. */
export function driftSeverity(d: FactDrift): "clean" | "warn" | "danger" {
  if (d.numbers.added.length || d.identifiers.added.length) return "danger";
  if (d.numbers.lost.length || d.identifiers.lost.length) return "warn";
  return "clean";
}
