// Page mechanics: the deterministic half of "did the article come out right".
//
// The split this file assumes. A generation pipeline is good at prose and bad at bookkeeping:
// it will write an honest, well-sourced 2000-word page and, in the same pass, name a competitor
// it was told never to name, drop the [[WIDGET]] placeholder it was told to keep, quote a price
// in dollars on a Greek page, and emit a word with three Cyrillic letters inside a Greek one.
// Restating those rules more forcefully in the prompt does not fix them — they are not style
// judgements, they are checks, and a check belongs in code where it either passes or does not.
//
// So this module measures the finished text against rules that are mostly DERIVED rather than
// configured (placeholders and internal links are read out of the author's own instruction; the
// forbidden brands are the source domains the article was grounded on when it was told not to
// name them), fixes deterministically what can be fixed deterministically — exactly one class,
// mixed-script words — and reports the rest as named defects for a scoped repair pass or a human.
//
// What it deliberately does NOT do: rewrite prose. Everything except confusable normalization is
// a report. A regex that "removes competitor mentions" from a sentence leaves a sentence that no
// longer parses, and a currency it converts is a fabricated number.

/** One thing wrong with the finished page. */
export interface MechanicsIssue {
  code:
    | "mixed_script"        // a single word built from two alphabets — invisible to the eye
    | "foreign_currency"    // prices in a currency that is not the target market's
    | "forbidden_brand"     // a competitor named on a page told not to name competitors
    | "missing_placeholder" // an author placeholder the writer dropped
    | "missing_link"        // an internal link the instruction required
    | "raw_keyword";        // a search phrase pasted into prose unedited
  /** Human-readable, already carrying the offending samples — safe to show in a job result. */
  detail: string;
  /** Whether this module repaired it in place (only ever true for mixed_script). */
  fixed: boolean;
  /** Up to a handful of examples, for a repair prompt or a UI list. */
  samples: string[];
}

export interface MechanicsRules {
  /** Article language code — decides the document's expected alphabet. */
  language?: string;
  /** Two-letter market — decides the expected currency. */
  country?: string;
  /** Tokens like `[[TRANSFER_WIDGET]]` that must survive verbatim. */
  placeholders?: string[];
  /** Competitor/brand names that must not appear in the body. */
  forbiddenBrands?: string[];
  /** Internal paths (`/where-to-stay/athens/`) that must be linked at least once. */
  requiredLinks?: string[];
  /** Target queries — used only to spot a phrase pasted in raw. */
  keywords?: string[];
}

// ─── Script handling ────────────────────────────────────────────────────────────────
// Three alphabets share enough shapes that a model mixing keyboards produces words no reader can
// debug by looking: `апо́δειξη` is Cyrillic а-п-о followed by Greek δειξη, and on screen it is
// simply the Greek word for "receipt". The pairs below are the ones that actually collide.

type Script = "latin" | "cyrillic" | "greek";

const RANGES: [Script, RegExp][] = [
  ["latin", /[A-Za-z]/],
  ["cyrillic", /[\u0400-\u04FF]/],
  ["greek", /[\u0370-\u03FF\u1F00-\u1FFF]/],
];

function scriptOf(ch: string): Script | null {
  for (const [name, re] of RANGES) if (re.test(ch)) return name;
  return null;
}

/**
 * Homoglyph map, keyed `from→to` by script pair. Only characters that are genuinely
 * indistinguishable (or near enough that a model substitutes them) appear here; a letter with no
 * entry makes the whole word unfixable, which is the intended outcome — a half-converted word is
 * worse than a reported one.
 */
const CONFUSABLES: Record<string, Record<string, string>> = {
  "cyrillic>latin": {
    "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c",
    "т": "t", "у": "y", "х": "x", "ѕ": "s", "і": "i", "ј": "j", "һ": "h", "ԁ": "d", "ԛ": "q", "ԝ": "w",
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C",
    "Т": "T", "У": "Y", "Х": "X", "Ѕ": "S", "І": "I", "Ј": "J",
  },
  "latin>cyrillic": {
    "a": "а", "b": "в", "c": "с", "e": "е", "h": "н", "k": "к", "m": "м", "o": "о", "p": "р",
    "t": "т", "x": "х", "y": "у",
    "A": "А", "B": "В", "C": "С", "E": "Е", "H": "Н", "K": "К", "M": "М", "O": "О", "P": "Р",
    "T": "Т", "X": "Х", "Y": "У",
  },
  "cyrillic>greek": {
    "а": "α", "в": "β", "г": "γ", "е": "ε", "з": "ζ", "и": "ι", "к": "κ", "м": "μ", "н": "η",
    "о": "ο", "п": "π", "р": "ρ", "с": "σ", "т": "τ", "у": "υ", "ф": "φ", "х": "χ", "ω": "ω",
    "А": "Α", "В": "Β", "Е": "Ε", "К": "Κ", "М": "Μ", "Н": "Η", "О": "Ο", "Р": "Ρ", "Т": "Τ", "Х": "Χ",
  },
  "greek>cyrillic": {
    "α": "а", "β": "в", "γ": "г", "ε": "е", "ζ": "з", "ι": "и", "κ": "к", "μ": "м", "η": "н",
    "ο": "о", "π": "п", "ρ": "р", "σ": "с", "τ": "т", "υ": "у", "φ": "ф", "χ": "х",
    "Α": "А", "Β": "В", "Ε": "Е", "Κ": "К", "Μ": "М", "Η": "Н", "Ο": "О", "Ρ": "Р", "Τ": "Т", "Χ": "Х",
  },
  "greek>latin": {
    "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t",
    "υ": "u", "χ": "x", "ω": "w", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I",
    "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X", "Υ": "Y",
  },
  "latin>greek": {
    "a": "α", "b": "β", "e": "ε", "i": "ι", "k": "κ", "n": "ν", "o": "ο", "p": "ρ", "t": "τ",
    "u": "υ", "x": "χ", "w": "ω", "A": "Α", "B": "Β", "E": "Ε", "H": "Η", "I": "Ι", "K": "Κ",
    "M": "Μ", "N": "Ν", "O": "Ο", "P": "Ρ", "T": "Τ", "X": "Χ", "Y": "Υ", "Z": "Ζ",
  },
};

/** Letters plus the combining marks that ride on them — a word is one run of these. */
const WORD_RE = /[A-Za-z\u0300-\u036F\u0400-\u04FF\u0370-\u03FF\u1F00-\u1FFF]+/gu;

export function documentScript(language?: string): Script {
  const l = (language || "").toLowerCase().slice(0, 2);
  if (["ru", "uk", "be", "bg", "sr", "mk", "kk"].includes(l)) return "cyrillic";
  if (l === "el") return "greek";
  return "latin";
}

/**
 * Rewrite words built from more than one alphabet into a single one.
 *
 * The target script is the word's own majority, not the document's: a Greek term quoted inside an
 * English article is legitimately Greek, and forcing it to Latin would corrupt real content. The
 * document's script only breaks ties. A word containing even one letter with no mapping is left
 * exactly as it was and returned as `unfixed`, because a partial conversion is a new defect.
 */
export function normalizeMixedScript(text: string, language?: string): { text: string; fixed: string[]; unfixed: string[] } {
  const docScript = documentScript(language);
  const fixed: string[] = [];
  const unfixed: string[] = [];
  const out = text.replace(WORD_RE, (word) => {
    const counts: Record<Script, number> = { latin: 0, cyrillic: 0, greek: 0 };
    for (const ch of word) {
      const sc = scriptOf(ch);
      if (sc) counts[sc]++;
    }
    const present = (Object.keys(counts) as Script[]).filter(s => counts[s] > 0);
    if (present.length < 2) return word;

    let target = present[0];
    for (const s of present) {
      if (counts[s] > counts[target]) target = s;
      else if (counts[s] === counts[target] && s === docScript) target = s;
    }

    let rebuilt = "";
    for (const ch of word) {
      const sc = scriptOf(ch);
      if (!sc || sc === target) { rebuilt += ch; continue; }
      const mapped = CONFUSABLES[`${sc}>${target}`]?.[ch];
      if (!mapped) { unfixed.push(word); return word; }
      rebuilt += mapped;
    }
    // NFC so a base letter plus a combining accent collapses back into the single precomposed
    // character the language actually uses (ο + U+0301 → ό), rather than staying a two-code-point
    // lookalike that string comparison and search would treat as a different word.
    const norm = rebuilt.normalize("NFC");
    fixed.push(`${word} → ${norm}`);
    return norm;
  });
  return { text: out, fixed, unfixed };
}

// ─── Currency ───────────────────────────────────────────────────────────────────────
const CURRENCY_BY_COUNTRY: Record<string, { symbols: string[]; codes: string[] }> = {
  eur: { symbols: ["€"], codes: ["EUR"] },
  gb: { symbols: ["£"], codes: ["GBP"] },
  us: { symbols: ["$"], codes: ["USD"] },
};
const EUROZONE = ["gr", "de", "fr", "it", "es", "pt", "nl", "be", "at", "ie", "fi", "sk", "si", "lt", "lv", "ee", "cy", "mt", "lu", "hr"];

/** Currency tokens sitting next to a number — a bare "$" in a code sample is not a price. */
const PRICED = /(?:([€£$₽₴₺¥₹])\s?\d|\d\s?([€£$₽₴₺¥₹])|\b(USD|EUR|GBP|CHF|RUB|UAH|TRY|JPY|INR|PLN|CZK|SEK|NOK|DKK)\b)/g;

function expectedCurrency(country?: string): { symbols: string[]; codes: string[] } | null {
  const c = (country || "").toLowerCase();
  if (!c) return null;
  if (EUROZONE.includes(c)) return CURRENCY_BY_COUNTRY.eur;
  return CURRENCY_BY_COUNTRY[c] ?? null;
}

// ─── Derivation helpers ─────────────────────────────────────────────────────────────

/** `[[TRANSFER_WIDGET]]`-style tokens named anywhere in the author's instruction. */
export function placeholdersFromInstruction(instruction?: string): string[] {
  const found = String(instruction || "").match(/\[\[[A-Z0-9_\-]{2,60}\]\]/g) || [];
  return Array.from(new Set(found));
}

/** Site-internal paths named in the instruction (`/where-to-stay/athens/`). */
export function linksFromInstruction(instruction?: string): string[] {
  const found = String(instruction || "").match(/(?<![\w:/])\/[a-z0-9][a-z0-9\-/]{2,80}\/?/gi) || [];
  return Array.from(new Set(found.map(s => s.trim()))).filter(s => !/^\/\//.test(s));
}

/**
 * Brand names implied by the domains the article was grounded on.
 *
 * `sourceMode: "facts"` already means "use these numbers, never name these companies" — so the
 * list of companies not to name is derivable and needs no configuration. Multi-word domains are
 * kept as one phrase (`welcomepickups.com` → `welcome pickups` matches "Welcome Pickups"), and
 * generic hosts are dropped so the check does not fire on the word "booking" in a sentence.
 */
const GENERIC_HOSTS = /^(www|com|co|org|net|blog|shop|site|home|index|wikipedia|wikimedia|reddit|youtube|facebook|instagram|tripadvisor|google|maps|gov|eu)$/i;
export function brandsFromDomains(domains: string[]): string[] {
  const out = new Set<string>();
  for (const d of domains) {
    const host = String(d || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    const label = host.split(".").filter(p => !GENERIC_HOSTS.test(p))[0];
    if (!label || label.length < 4) continue;
    out.add(label.replace(/-/g, " "));
  }
  return [...out];
}

// ─── The check ──────────────────────────────────────────────────────────────────────

/** Everything outside code fences and link targets — where a brand name actually matters. */
function bodyProse(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\]\([^)]*\)/g, "]( )")
    .replace(/^---[\s\S]*?^---/m, " "); // YAML front matter is metadata, not prose
}

function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Audit a finished article. Returns the (possibly repaired) text plus every defect found.
 * Only mixed-script words are repaired here; see the module header for why nothing else is.
 */
export function checkMechanics(text: string, rules: MechanicsRules): { text: string; issues: MechanicsIssue[] } {
  const issues: MechanicsIssue[] = [];

  const ms = normalizeMixedScript(text, rules.language);
  let out = ms.text;
  if (ms.fixed.length) {
    issues.push({
      code: "mixed_script", fixed: true, samples: ms.fixed.slice(0, 8),
      detail: `${ms.fixed.length} word(s) mixed two alphabets and were normalised: ${ms.fixed.slice(0, 5).join(", ")}`,
    });
  }
  if (ms.unfixed.length) {
    issues.push({
      code: "mixed_script", fixed: false, samples: Array.from(new Set(ms.unfixed)).slice(0, 8),
      detail: `${ms.unfixed.length} mixed-alphabet word(s) could not be normalised safely and need a human: ${Array.from(new Set(ms.unfixed)).slice(0, 5).join(", ")}`,
    });
  }

  const prose = bodyProse(out);

  const want = expectedCurrency(rules.country);
  if (want) {
    const hits = new Set<string>();
    for (const m of prose.matchAll(PRICED)) {
      const tok = (m[1] || m[2] || m[3] || "").toUpperCase();
      if (!tok) continue;
      if (want.symbols.includes(m[1] || m[2] || "") || want.codes.includes(tok)) continue;
      hits.add(m[0].trim());
    }
    if (hits.size) {
      issues.push({
        code: "foreign_currency", fixed: false, samples: [...hits].slice(0, 8),
        detail: `Prices quoted outside the market's currency (${rules.country} expects ${want.symbols.concat(want.codes).join(" / ")}): ${[...hits].slice(0, 6).join(", ")}. Not auto-corrected — converting a price invents a number.`,
      });
    }
  }

  const brands = (rules.forbiddenBrands || []).map(b => b.trim()).filter(b => b.length >= 4);
  if (brands.length) {
    // A domain gives one run-together token (`welcomepickups`) and the page writes the brand the
    // way a human does (`Welcome Pickups`), so a word-boundary regex on the raw token finds
    // nothing — which is exactly the check silently passing on the defect it exists to catch.
    // Long single-token brands are therefore matched against a separator-stripped copy of the
    // prose; short ones and multi-word ones keep boundary matching, where collapsing would start
    // finding brands inside ordinary sentences.
    const collapsed = prose.toLowerCase().replace(/[\s\-–—_'’.]/g, "");
    const hits = brands.filter(b => {
      const multi = /[\s\-]/.test(b);
      if (!multi && b.length >= 8) return collapsed.includes(b.toLowerCase().replace(/[\s\-]/g, ""));
      return new RegExp(`(?<![\\w-])${esc(b).replace(/\s+/g, "[\\s-]?")}(?![\\w-])`, "i").test(prose);
    });
    if (hits.length) {
      issues.push({
        code: "forbidden_brand", fixed: false, samples: hits.slice(0, 10),
        detail: `Named in the body despite the no-competitor rule: ${hits.slice(0, 8).join(", ")}. The figures may stay; the names must go.`,
      });
    }
  }

  const missingPh = (rules.placeholders || []).filter(p => !out.includes(p));
  if (missingPh.length) {
    issues.push({
      code: "missing_placeholder", fixed: false, samples: missingPh,
      detail: `Placeholder(s) the instruction required but the writer dropped: ${missingPh.join(", ")}.`,
    });
  }

  const missingLinks = (rules.requiredLinks || []).filter(p => !new RegExp(`\\]\\(\\s*${esc(p)}`, "i").test(out) && !new RegExp(`href=["']\\s*${esc(p)}`, "i").test(out));
  if (missingLinks.length) {
    issues.push({
      code: "missing_link", fixed: false, samples: missingLinks,
      detail: `Internal link(s) the instruction asked for and the article does not contain: ${missingLinks.join(", ")}.`,
    });
  }

  // A search phrase dropped into a sentence unedited reads as machine output to a human and as
  // keyword stuffing to a search engine. Only long phrases are checked: a two-word key legitimately
  // appears in prose all the time, a five-word one lowercase mid-sentence does not.
  const raw = (rules.keywords || [])
    .map(k => String(k || "").trim())
    .filter(k => k.split(/\s+/).length >= 5)
    .filter(k => new RegExp(`[a-zà-ÿа-яα-ω,][ ]${esc(k)}`, "i").test(prose));
  if (raw.length) {
    issues.push({
      code: "raw_keyword", fixed: false, samples: raw.slice(0, 6),
      detail: `Search phrase(s) pasted into a sentence verbatim: ${raw.slice(0, 4).map(k => `"${k}"`).join(", ")}.`,
    });
  }

  return { text: out, issues };
}

/** The defects a scoped model pass can plausibly fix without rewriting the article. */
export const REPAIRABLE: MechanicsIssue["code"][] = ["forbidden_brand", "missing_placeholder", "missing_link", "foreign_currency"];

export function repairableIssues(issues: MechanicsIssue[]): MechanicsIssue[] {
  return issues.filter(i => !i.fixed && REPAIRABLE.includes(i.code));
}

/** One-line summary for a job result / log line. */
export function summarizeMechanics(issues: MechanicsIssue[]): string {
  if (!issues.length) return "mechanics: clean";
  return "mechanics: " + issues.map(i => `${i.code}${i.fixed ? " (fixed)" : ""}×${i.samples.length}`).join(", ");
}
