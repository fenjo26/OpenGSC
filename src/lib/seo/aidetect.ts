// Local AI-fingerprint analyzer — no third-party detector API, no local LLM, zero deps.
//
// WHY THIS SHAPE. Modern statistical detectors (Pangram et al.) do not read style: they score
// the *token frequency distribution* over ~300-word windows and average the windows. The giveaway
// is that shuffling every word of an AI text into nonsense barely moves its score — order carries
// almost no signal, presence does. That makes the detector reproducible locally as a bag-of-words
// discriminator, which is exactly what this module is.
//
// WHAT IT IS AND ISN'T. This is a *correlated proxy trained on your own domain*, not a clone of any
// commercial detector. Absolute numbers are not comparable to Pangram's. What IS usable: the delta
// between two of your own texts, and — the actually valuable output — `markers`: the vocabulary that
// separates your competitors' human pages from your own generated ones. That list is worth more
// than the score, because banning those words *at generation time* is the one lever with measured
// effect; post-hoc rewriting of a finished text is not.
//
// Corpora: HUMAN = competitor pages scraped from the SERP; AI = the user's own SeoHistory articles.
// Both are already in the product, so the model is self-training per niche and per language.

// ─── Normalization ──────────────────────────────────────────────────────────────
// CRITICAL: the two corpora arrive in different *formats* — scraped competitors are plain text,
// our own articles are Markdown with a meta block. Without stripping formatting the classifier
// learns "## means AI", scores 99% accuracy on a leak, and produces a marker list of punctuation.
// Everything below flattens both sides to bare prose before a single token is counted.
export function normalizeForCorpus(input: string): string {
  let s = String(input || "");
  // Our generated articles open with a fenced meta block — competitors never have one.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/^\s*(Title|Meta Description|URL Slug)\s*:.*$/gim, " ");
  s = s.replace(/<[^>]+>/g, " ");                    // HTML tags
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");       // images
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");     // links → anchor text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, " ");         // ATX headings
  s = s.replace(/^\s{0,3}>\s?/gm, " ");              // blockquotes
  s = s.replace(/^\s*[-*+]\s+/gm, " ");              // bullets
  s = s.replace(/^\s*\d+[.)]\s+/gm, " ");            // ordered list markers
  s = s.replace(/^\s*\|.*\|\s*$/gm, " ");            // markdown table rows
  s = s.replace(/[*_~`]+/g, " ");                    // emphasis marks
  s = s.replace(/&[a-z]+;|&#\d+;/gi, " ");           // stray entities
  return s.replace(/\s+/g, " ").trim();
}

// ─── Homoglyph folding ──────────────────────────────────────────────────────────
// NFKC alone does NOT merge Cyrillic "а" into Latin "a" — they stay separate code points. Real
// detectors fold confusables before counting, so if we skipped this a user could swap a few letters,
// watch our score collapse, and ship a text that gets flagged anyway. The tool must not be gameable
// in ways the real thing isn't.
//
// Folding is applied ONLY to mixed-script tokens, and always toward the token's dominant script.
// A blanket map would mangle genuine Russian or Greek prose into Latin nonsense.
const CYR_TO_LAT: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p",
  "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ѕ": "s", "ј": "j", "ԁ": "d", "һ": "h", "ӏ": "l",
};
const GRK_TO_LAT: Record<string, string> = {
  "α": "a", "β": "b", "ε": "e", "ζ": "z", "η": "n", "ι": "i", "κ": "k", "μ": "m",
  "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "γ": "y",
};
const LAT_TO_CYR: Record<string, string> = {
  "a": "а", "b": "в", "e": "е", "k": "к", "m": "м", "h": "н", "o": "о", "p": "р",
  "c": "с", "t": "т", "y": "у", "x": "х", "i": "і", "j": "ј",
};

const RE_LAT = /[a-z]/;
const RE_CYR = /[Ѐ-ӿ]/;
const RE_GRK = /[Ͱ-Ͽ]/;

function foldConfusables(tok: string): string {
  const hasLat = RE_LAT.test(tok);
  const hasCyr = RE_CYR.test(tok);
  const hasGrk = RE_GRK.test(tok);
  if ((hasLat ? 1 : 0) + (hasCyr ? 1 : 0) + (hasGrk ? 1 : 0) < 2) return tok; // single script — leave it
  const n = (re: RegExp) => (tok.match(new RegExp(re.source, "g")) || []).length;
  const lat = n(RE_LAT), cyr = n(RE_CYR), grk = n(RE_GRK);
  // Dominant script wins; ties resolve to Latin, the usual disguise target.
  if (cyr > lat && cyr >= grk) return [...tok].map(c => LAT_TO_CYR[c] ?? c).join("");
  return [...tok].map(c => CYR_TO_LAT[c] ?? GRK_TO_LAT[c] ?? c).join("");
}

// Unicode-normalizing tokenizer. NFKC handles width/ligature variants; foldConfusables handles the
// cross-alphabet lookalikes NFKC deliberately leaves alone. \p{L}\p{N} keeps this alphabet-agnostic,
// so Cyrillic, Greek and Latin corpora all tokenize through the same path.
export function tokenize(text: string): string[] {
  const s = text.normalize("NFKC").toLowerCase();
  const raw = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  return raw.map(foldConfusables);
}

export const WINDOW_SIZE = 300;   // matches the window size real detectors average over
const MIN_WINDOW = 120;           // a trailing stub shorter than this is noise, not a sample
const MIN_DOC_FREQ = 3;           // a token seen in <3 documents is memorization, not signal
const LAPLACE = 0.5;
const MAX_VOCAB = 6000;           // keeps a serialized model ~150KB so it fits localStorage

export function toWindows(tokens: string[], size = WINDOW_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < tokens.length; i += size) {
    const w = tokens.slice(i, i + size);
    if (w.length >= MIN_WINDOW || out.length === 0) out.push(w);
  }
  return out.length ? out : [tokens];
}

// ─── Model ──────────────────────────────────────────────────────────────────────
export interface AiDetectModel {
  version: 1;
  language: string;
  createdAt: number;
  humanDocs: number;
  aiDocs: number;
  humanTokens: number;
  aiTokens: number;
  /** log-odds per token: positive = AI-leaning, negative = human-leaning */
  weights: Record<string, number>;
  /**
   * Fraction of HUMAN documents containing each token (0..1).
   *
   * Exists to protect the ban list from itself. A word can be genuinely necessary to the niche AND
   * overused by the model — write "отдача" fifty times where a human writes it five and it earns a
   * high log-odds weight, lands in the ban list, and gets forbidden outright. The model then
   * circumlocutes around required terminology and the article gets worse. If the competitors use a
   * word widely, it is domain vocabulary and must never be banned, however skewed its ratio.
   *
   * Optional: models trained before this field existed still score correctly, they just cannot
   * filter, and the UI flags that.
   */
  humanDf?: Record<string, number>;
  /** linear calibration measured on a HELD-OUT split: mean per-token log-odds of each class */
  calHuman: number;
  calAi: number;
  /** how well the held-out split separated — 0..1, honest quality signal for the UI */
  separation: number;
}

export interface WindowScore {
  index: number;
  words: number;
  score: number;          // 0-100, higher = more AI-like
  preview: string;
}

export interface Marker {
  token: string;
  weight: number;         // log-odds; positive = pushes toward AI
  count: number;          // occurrences in the analyzed text
  contribution: number;   // weight * count — what actually moved the score
}

export interface AiDetectReport {
  avgScore: number;
  verdict: "human" | "mixed" | "ai";
  words: number;
  windows: WindowScore[];
  /** AI-leaning vocabulary present in this text, ranked by how much it moved the score */
  markers: Marker[];
  /** human-leaning vocabulary this text is missing the most (what competitors use and you don't) */
  missing: Marker[];
}

function countTokens(docs: string[][]): { total: Map<string, number>; df: Map<string, number>; n: number } {
  const total = new Map<string, number>();
  const df = new Map<string, number>();
  let n = 0;
  for (const toks of docs) {
    const seen = new Set<string>();
    for (const t of toks) {
      total.set(t, (total.get(t) ?? 0) + 1);
      seen.add(t);
      n++;
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { total, df, n };
}

/**
 * Train the discriminator. `humanTexts` are competitor pages, `aiTexts` are your own generations.
 * 20% of each side is held out purely for calibration, so the 0-100 scale isn't fitted on the same
 * windows it scores — otherwise every model would look perfect and the number would mean nothing.
 */
export function trainModel(
  humanTexts: string[],
  aiTexts: string[],
  language = "auto",
): { ok: true; model: AiDetectModel } | { ok: false; error: string } {
  const prep = (arr: string[]) =>
    arr.map(t => tokenize(normalizeForCorpus(t))).filter(t => t.length >= MIN_WINDOW);

  const human = prep(humanTexts);
  const ai = prep(aiTexts);
  if (human.length < 3) return { ok: false, error: "need_more_human" };
  if (ai.length < 3) return { ok: false, error: "need_more_ai" };

  // Deterministic held-out split (every 5th document) — no RNG, so retraining is reproducible.
  const isHeld = (i: number) => i % 5 === 4;
  const humanFit = human.filter((_, i) => !isHeld(i));
  const humanHold = human.filter((_, i) => isHeld(i));
  const aiFit = ai.filter((_, i) => !isHeld(i));
  const aiHold = ai.filter((_, i) => isHeld(i));

  const H = countTokens(humanFit.length ? humanFit : human);
  const A = countTokens(aiFit.length ? aiFit : ai);

  const vocab = new Set<string>();
  for (const [t, d] of H.df) if (d >= MIN_DOC_FREQ) vocab.add(t);
  for (const [t, d] of A.df) if (d >= MIN_DOC_FREQ) vocab.add(t);
  if (vocab.size < 50) return { ok: false, error: "corpus_too_small" };

  const V = vocab.size;
  const denomH = H.n + LAPLACE * V;
  const denomA = A.n + LAPLACE * V;

  const all: { t: string; w: number; rank: number }[] = [];
  for (const t of vocab) {
    const pH = ((H.total.get(t) ?? 0) + LAPLACE) / denomH;
    const pA = ((A.total.get(t) ?? 0) + LAPLACE) / denomA;
    const w = Math.log(pA / pH);
    // Rank by evidence, not raw magnitude: a huge weight backed by 3 occurrences is noise.
    const support = (H.df.get(t) ?? 0) + (A.df.get(t) ?? 0);
    all.push({ t, w, rank: Math.abs(w) * Math.sqrt(support) });
  }
  all.sort((a, b) => b.rank - a.rank);

  const weights: Record<string, number> = {};
  const humanDf: Record<string, number> = {};
  const humanDocCount = (humanFit.length ? humanFit : human).length || 1;
  for (const { t, w } of all.slice(0, MAX_VOCAB)) {
    weights[t] = Math.round(w * 1e4) / 1e4;
    humanDf[t] = Math.round(((H.df.get(t) ?? 0) / humanDocCount) * 100) / 100;
  }

  // Calibrate on held-out windows (fall back to the fit set only if the corpus was too small
  // to hold anything out — flagged to the user through a low `separation`).
  const meanLlrOf = (docs: string[][]): number[] => {
    const out: number[] = [];
    for (const toks of docs) for (const w of toWindows(toks)) out.push(rawLlr(w, weights));
    return out;
  };
  const hHold = meanLlrOf(humanHold.length ? humanHold : humanFit);
  const aHold = meanLlrOf(aiHold.length ? aiHold : aiFit);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const calHuman = avg(hHold);
  const calAi = avg(aHold);

  // Separation = how cleanly the two held-out clouds sit apart, in pooled-sd units, squashed to 0-1.
  const sd = (xs: number[], m: number) =>
    xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;
  const pooled = Math.sqrt((sd(hHold, calHuman) ** 2 + sd(aHold, calAi) ** 2) / 2) || 1e-6;
  const d = Math.abs(calAi - calHuman) / pooled;
  const separation = Math.max(0, Math.min(1, d / 4));

  if (!isFinite(calHuman) || !isFinite(calAi) || Math.abs(calAi - calHuman) < 1e-6) {
    return { ok: false, error: "no_separation" };
  }

  return {
    ok: true,
    model: {
      version: 1,
      language,
      createdAt: Date.now(),
      humanDocs: human.length,
      aiDocs: ai.length,
      humanTokens: H.n,
      aiTokens: A.n,
      weights,
      humanDf,
      calHuman: Math.round(calHuman * 1e6) / 1e6,
      calAi: Math.round(calAi * 1e6) / 1e6,
      separation: Math.round(separation * 1e3) / 1e3,
    },
  };
}

// Mean per-token log-odds of one window. Mean rather than sum: a sum over 300 tokens saturates
// any sigmoid to 0 or 1 and every text ends up at the extremes, which is useless for comparison.
function rawLlr(tokens: string[], weights: Record<string, number>): number {
  if (!tokens.length) return 0;
  let acc = 0;
  let hits = 0;
  for (const t of tokens) {
    const w = weights[t];
    if (w !== undefined) { acc += w; hits++; }
  }
  return hits ? acc / hits : 0;
}

/** Map a window's raw log-odds onto the 0-100 scale via the model's held-out calibration. */
function calibrate(llr: number, m: AiDetectModel): number {
  const span = m.calAi - m.calHuman;
  const pct = ((llr - m.calHuman) / span) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// Verdict bands mirror the convention used by statistical detectors, so the UI reads familiarly.
export function verdictOf(score: number): "human" | "mixed" | "ai" {
  return score < 15 ? "human" : score < 40 ? "mixed" : "ai";
}

/**
 * Score a text. Returns the averaged window score plus the two lists that make this actionable:
 * which AI-leaning words are doing the damage, and which human-leaning words the text lacks.
 */
export function scoreText(text: string, m: AiDetectModel, markerLimit = 40): AiDetectReport {
  const tokens = tokenize(normalizeForCorpus(text));
  const wins = toWindows(tokens);

  const windows: WindowScore[] = wins.map((w, i) => ({
    index: i,
    words: w.length,
    score: calibrate(rawLlr(w, m.weights), m),
    preview: w.slice(0, 12).join(" "),
  }));

  const avgScore = windows.length
    ? Math.round(windows.reduce((a, b) => a + b.score, 0) / windows.length)
    : 0;

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  const present: Marker[] = [];
  for (const [t, c] of counts) {
    const w = m.weights[t];
    if (w === undefined) continue;
    present.push({ token: t, weight: w, count: c, contribution: w * c });
  }

  const markers = present
    .filter(x => x.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, markerLimit);

  // "Missing" = strongly human-leaning vocabulary the text never uses. Shown as inspiration for
  // the writer, deliberately NOT auto-injected: forcing a word list into a prompt narrows the
  // model's distribution and reliably backfires.
  const missing = Object.entries(m.weights)
    .filter(([t, w]) => w < 0 && !counts.has(t) && t.length > 2)
    .map(([t, w]) => ({ token: t, weight: w, count: 0, contribution: w }))
    .sort((a, b) => a.weight - b.weight)
    .slice(0, markerLimit);

  return { avgScore, verdict: verdictOf(avgScore), words: tokens.length, windows, markers, missing };
}

/**
 * A word used by this share of competitor pages counts as niche vocabulary, not an AI tell, and is
 * withheld from the ban list no matter how lopsided its ratio. Banning terminology the whole niche
 * uses does not make text more human — it makes the model talk around the words the article needs.
 */
export const DOMAIN_DF_THRESHOLD = 0.4;

export interface BanCandidate {
  token: string;
  weight: number;
  /** share of competitor documents using this word, 0..1 */
  humanDf: number;
  /** true when competitors use it widely — excluded by default, shown so the choice is visible */
  domain: boolean;
}

/**
 * Ban-list candidates, ranked by how strongly the word skews machine-ward.
 *
 * Returns candidates rather than a final list on purpose: this vocabulary goes straight into a
 * generation prompt, and a word list nobody looked at is exactly how a "quality" feature quietly
 * degrades output. The UI shows these and lets the operator drop any of them.
 */
export function suggestBannedCandidates(m: AiDetectModel, limit = 60): BanCandidate[] {
  return Object.entries(m.weights)
    .filter(([t, w]) => w > 0 && t.length >= 4 && !/^\d/.test(t))
    .sort((a, b) => b[1] - a[1])
    .map(([token, weight]) => {
      const humanDf = m.humanDf?.[token] ?? 0;
      return { token, weight, humanDf, domain: humanDf >= DOMAIN_DF_THRESHOLD };
    })
    .filter(c => !c.domain)
    .slice(0, limit);
}

/** Flat list for callers that just need the default selection. */
export function suggestBannedWords(m: AiDetectModel, limit = 60): string[] {
  return suggestBannedCandidates(m, limit).map(c => c.token);
}

/** Compact stats for the corpus tab. */
export function modelStats(m: AiDetectModel) {
  const ws = Object.values(m.weights);
  return {
    vocab: ws.length,
    humanDocs: m.humanDocs,
    aiDocs: m.aiDocs,
    separation: m.separation,
    quality: m.separation >= 0.6 ? "good" : m.separation >= 0.35 ? "fair" : "weak",
  };
}
