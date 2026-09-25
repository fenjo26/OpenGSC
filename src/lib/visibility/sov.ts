// T7 — AI share of voice: pure aggregation over the answers the AEO tracker already stores.
//
// The whole point of this module (and the reason it must stay free of any network import): the
// tracker has been persisting the full answer text and the citation list of every check since
// it first shipped. Share of voice and "which domains does the AI cite" are therefore plain
// counting over data that was already paid for — adding a competitor recomputes the entire
// history with zero new AI calls. The store (store.ts) feeds rows in; nothing here knows Prisma.

import type { AiCompetitor, CitedDomainRow, SovEngineRow, SovReport } from "./types";

export interface SovAnswer { questionId: string; question: string; engine: string; checkedAt: Date; answerText: string | null; citations: { url: string; domain: string; title: string }[]; rank: number | null; status: string | null; sentiment?: string | null }

// ─── folding: case- and diacritics-insensitive comparison ─────────────────────

// NFD + strip combining marks makes "Café"/"café"/"CAFE" one string — and, just as important
// for this module's languages, folds Russian ё→е and Greek ά→α so a brand spelled with the
// accent still matches text written without it.
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word boundary spelled out as "not a letter or digit" in Unicode terms — JS's \b is ASCII-only
// and would glue "Подряд" onto "Подрядчик" for Cyrillic brands (same trick as aeo.ts).
const NOT_WORD_CHAR = "[^\\p{L}\\p{N}]";

function mentionsTerm(text: string, term: string): boolean {
  const t = term.trim();
  // Terms shorter than 3 chars ("vs", "AI") would light up in half the answers; ignoring them
  // is cheaper and more honest than pretending they measured anything.
  if (t.length < 3) return false;
  try {
    return new RegExp(`(^|${NOT_WORD_CHAR})${escapeRe(fold(t))}($|${NOT_WORD_CHAR})`, "u").test(fold(text));
  } catch {
    return fold(text).includes(fold(t));
  }
}

/** True when any of the terms appears in the text at a word boundary (case/diacritics-blind).
 *  A bare domain ("example.com") counts too — the dot is not a word character, so it matches. */
export function mentionsOf(text: string, terms: string[]): boolean {
  if (!text) return false;
  return terms.some(t => mentionsTerm(text, t));
}

// ─── domain helpers ───────────────────────────────────────────────────────────

export function stripWww(domain: string): string {
  return (domain || "").trim().toLowerCase().replace(/^www\./, "");
}

function domainFromUrl(url: string): string {
  if (!url) return "";
  try {
    return stripWww(new URL(url).hostname);
  } catch {
    return stripWww(url.replace(/^https?:\/\//, "").split("/")[0]);
  }
}

// Host-boundary match, same rule as isOurs in aeo.ts: "blog.example.com" belongs to
// "example.com", but "notexample.com" does not.
function hostMatches(domain: string, host: string): boolean {
  if (!domain || !host) return false;
  return domain === host || domain.endsWith("." + host);
}

// A rival's match vocabulary: display name (the contract type says the name is always included
// implicitly), extra spellings, and the bare domain.
function rivalTerms(r: AiCompetitor): string[] {
  return [r.name, ...r.terms, r.domain].filter(Boolean);
}

// ─── latest answer per (question, engine) ─────────────────────────────────────

/** For every (questionId, engine) pair keeps only the newest answer inside [from, to].
 *  A question checked thirty times must not outweigh one checked once. Rows without answer
 *  text are dropped EXCEPT a `no_overview` row: that is the engine's current verdict for the
 *  pair ("Google shows no overview for this question"), so it is selected like any answer and
 *  then EXCLUDED from every denominator — the pair leaves the report rather than dragging a
 *  stale older answer behind it. An errored check (no text, no status) is never a candidate:
 *  a rate limit is not evidence that a brand went unmentioned. */
export function latestPerQuestionEngine(answers: SovAnswer[], from: Date, to: Date): SovAnswer[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const latest = new Map<string, { a: SovAnswer; ts: number }>();
  for (const a of answers) {
    const ts = a.checkedAt instanceof Date ? a.checkedAt.getTime() : new Date(a.checkedAt).getTime();
    if (ts < fromMs || ts > toMs) continue;
    const hasAnswer = !!a.answerText && !!a.answerText.trim();
    const noOverview = a.status === "no_overview";
    if (!hasAnswer && !noOverview) continue; // errored / hollow row — not evidence
    const key = `${a.questionId}\u0000${a.engine}`;
    const prev = latest.get(key);
    if (!prev || ts >= prev.ts) latest.set(key, { a, ts });
  }
  // A selected no_overview row retires the pair instead of counting as an answer.
  return [...latest.values()].map(x => x.a).filter(a => a.status !== "no_overview");
}

// ─── ISO weeks ────────────────────────────────────────────────────────────────

/** ISO-8601 week key, "2026-W40". Weeks start Monday; week 1 is the one with the first Thursday. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; // make Sunday 7, ISO numbering
  t.setUTCDate(t.getUTCDate() + 4 - dow); // the Thursday of this ISO week pins the year
  const year = t.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((t.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// Consecutive ISO weeks covering [from, to] — the x-axis of the trend line.
function weekSpan(from: Date, to: Date): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const d = new Date(from.getTime());
  while (d.getTime() <= to.getTime()) {
    const w = isoWeek(d);
    if (!seen.has(w)) { seen.add(w); out.push(w); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// ─── verdicts on one answer ───────────────────────────────────────────────────

// We count as mentioned when the tracker already said so (its verdict also covers the bare
// domain in the prose) or when our own terms light up in the answer text — the same evidence,
// checked again so a re-run with different brand terms still recomputes history for free.
function usMentionedIn(a: SovAnswer, terms: string[]): boolean {
  return a.status === "cited" || a.status === "mentioned" || mentionsOf(a.answerText ?? "", terms);
}

function usCitedIn(a: SovAnswer, host: string): boolean {
  return a.status === "cited" || a.citations.some(c => hostMatches(stripWww(c.domain), host));
}

// ─── the report ───────────────────────────────────────────────────────────────

export function buildSovReport(
  answers: SovAnswer[],
  us: { host: string; terms: string[] },
  rivals: AiCompetitor[],
  from: Date,
  to: Date,
): SovReport {
  const rows = latestPerQuestionEngine(answers, from, to);

  // ── share of voice: brand mentions per latest answer ──
  const ourMentions = rows.filter(r => usMentionedIn(r, us.terms)).length;
  const rivalMentions = rivals.map(rv => ({
    name: rv.name,
    mentions: rows.filter(r => mentionsOf(r.answerText ?? "", rivalTerms(rv))).length,
  }));
  const totalMentions = ourMentions + rivalMentions.reduce((s, x) => s + x.mentions, 0);
  // Nothing mentioned anywhere is "no data", not 0 %: shares stay 0 and the UI says so.
  const shareOfVoice = [
    { name: us.host, isUs: true, mentions: ourMentions, share: totalMentions ? ourMentions / totalMentions : 0 },
    ...rivalMentions.map(x => ({ name: x.name, isUs: false, mentions: x.mentions, share: totalMentions ? x.mentions / totalMentions : 0 })),
  ];

  // ── citation share: how many of the citation slots belong to each brand ──
  const ourCitations = rows.reduce((s, r) => s + r.citations.filter(c => hostMatches(stripWww(c.domain), us.host)).length, 0);
  const rivalCitations = rivals.map(rv => ({
    name: rv.name,
    citations: rows.reduce((s, r) => s + r.citations.filter(c => rv.domain && hostMatches(stripWww(c.domain), rv.domain)).length, 0),
  }));
  const totalCitations = ourCitations + rivalCitations.reduce((s, x) => s + x.citations, 0);
  const citationShare = [
    { name: us.host, isUs: true, citations: ourCitations, share: totalCitations ? ourCitations / totalCitations : 0 },
    ...rivalCitations.map(x => ({ name: x.name, isUs: false, citations: x.citations, share: totalCitations ? x.citations / totalCitations : 0 })),
  ];

  // ── per-engine rows ──
  const engines = [...new Set(rows.map(r => r.engine))];
  const byEngine: SovEngineRow[] = engines.map(engine => {
    const list = rows.filter(r => r.engine === engine);
    const ranks = list.map(r => r.rank).filter((r): r is number => typeof r === "number" && r !== null);
    return {
      engine,
      answers: list.length,
      us: {
        mentioned: list.filter(r => usMentionedIn(r, us.terms)).length,
        cited: list.filter(r => usCitedIn(r, us.host)).length,
        avgRank: ranks.length ? ranks.reduce((s, r) => s + r, 0) / ranks.length : null,
      },
      competitors: rivals.map(rv => ({
        name: rv.name,
        mentioned: list.filter(r => mentionsOf(r.answerText ?? "", rivalTerms(rv))).length,
        cited: list.filter(r => rv.domain && r.citations.some(c => hostMatches(stripWww(c.domain), rv.domain))).length,
      })),
    };
  }).sort((a, b) => b.answers - a.answers);

  // ── weekly trend of our share ──
  const trend = weekSpan(from, to).map(week => {
    const inWeek = rows.filter(r => isoWeek(r.checkedAt) === week);
    if (!inWeek.length) return { week, usShare: null };
    const um = inWeek.filter(r => usMentionedIn(r, us.terms)).length;
    const tm = um + rivals.reduce((s, rv) => s + inWeek.filter(r => mentionsOf(r.answerText ?? "", rivalTerms(rv))).length, 0);
    // A week with answers but zero brand mentions is the same "no data" as an empty week.
    return { week, usShare: tm ? um / tm : null };
  });

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    questions: new Set(rows.map(r => r.questionId)).size,
    answers: rows.length,
    shareOfVoice,
    citationShare,
    byEngine,
    trend,
  };
}

// ─── cited-domain rating ──────────────────────────────────────────────────────

/** Domains the engines cite across `answers` (expected: the windowed latest-per-pair list),
 *  sorted by how many answers cite them, then by total citation slots. Us and competitor
 *  domains are flagged; the example question/URL comes from the newest citing answer. */
export function buildCitedDomains(
  answers: SovAnswer[],
  us: { host: string },
  rivals: AiCompetitor[],
  limit: number,
): CitedDomainRow[] {
  interface Acc {
    citations: number;
    answers: Set<string>;
    engines: Set<string>;
    questions: Set<string>;
    exampleQuestion: string;
    exampleUrl: string;
  }
  // Newest first, so the first time a domain is seen its example is the freshest answer.
  // An "answer" is a check row: identity = (question, engine, time), because the same question
  // answered by two engines is two answers in the report's own vocabulary.
  const answerKey = (a: SovAnswer) => `${a.questionId}\u0000${a.engine}\u0000${a.checkedAt.getTime()}`;
  const rows = answers
    .filter(a => a.answerText && a.answerText.trim())
    .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());

  const acc = new Map<string, Acc>();
  for (const a of rows) {
    const key = answerKey(a);
    const seenInAnswer = new Set<string>();
    for (const c of a.citations) {
      const domain = stripWww(c.domain || "") || domainFromUrl(c.url);
      if (!domain) continue; // Gemini leaves the domain empty when even the title is not a host
      let x = acc.get(domain);
      if (!x) {
        x = { citations: 0, answers: new Set(), engines: new Set(), questions: new Set(), exampleQuestion: "", exampleUrl: "" };
        acc.set(domain, x);
      }
      x.citations += 1;
      if (!seenInAnswer.has(domain)) {
        seenInAnswer.add(domain);
        x.answers.add(key);
        // The example is set once, from the newest answer that cites the domain (rows are
        // newest-first) — later answers may only bump the counters.
        if (!x.exampleUrl) {
          x.exampleQuestion = a.question;
          x.exampleUrl = c.url;
        }
      }
      x.engines.add(a.engine);
      x.questions.add(a.questionId);
    }
  }

  const competitorOf = (d: string): string | null => {
    for (const rv of rivals) if (rv.domain && hostMatches(d, rv.domain)) return rv.name;
    return null;
  };

  return [...acc.entries()]
    .map(([domain, x]) => ({
      domain,
      citations: x.citations,
      answers: x.answers.size,
      engines: [...x.engines],
      questions: x.questions.size,
      exampleQuestion: x.exampleQuestion,
      exampleUrl: x.exampleUrl,
      isUs: hostMatches(domain, us.host),
      competitor: competitorOf(domain),
    }))
    .sort((a, b) => b.answers - a.answers || b.citations - a.citations)
    .slice(0, Math.max(1, limit));
}

// ─── question-like queries ────────────────────────────────────────────────────

// Question openers per language, folded at load. A query is a question idea when its FIRST word
// is one of these, or when it contains "?" — the same shape of heuristic the AEO tracker's
// placeholder suggests ("best transfer service in Thessaloniki" starts with "best").
const QUESTION_WORDS: Record<string, string[]> = {
  en: ["how", "what", "which", "who", "whom", "whose", "when", "where", "why", "best", "top", "vs", "versus",
    "is", "are", "can", "could", "should", "do", "does", "did", "will", "would", "compare"],
  fr: ["comment", "quel", "quelle", "quels", "quelles", "qui", "quand", "ou", "pourquoi", "combien",
    "que", "quoi", "meilleur", "meilleure", "meilleurs", "top", "vs"],
  es: ["como", "cual", "cuales", "quien", "quienes", "cuando", "donde", "por", "cuanto", "cuanta",
    "que", "mejor", "mejores", "top", "vs"],
  de: ["wie", "was", "welcher", "welche", "welches", "wem", "wessen", "wer", "wann", "wo", "warum",
    "wieviel", "beste", "besten", "top", "vs", "kostet"],
  it: ["come", "quale", "quali", "chi", "quando", "dove", "perche", "quanto", "quanta", "cosa",
    "meglio", "migliore", "migliori", "top", "vs"],
  pt: ["como", "qual", "quais", "quem", "quando", "onde", "por", "quanto", "que",
    "melhor", "melhores", "top", "vs"],
  ru: ["как", "что", "какой", "какая", "какое", "какие", "кто", "когда", "где", "почему", "сколько",
    "лучший", "лучшая", "лучшие", "лучше", "стоит", "можно", "vs", "топ"],
  uk: ["як", "що", "який", "яка", "яке", "які", "хто", "коли", "де", "чому", "скільки",
    "найкращий", "найкраща", "найкращі", "краще", "варто", "чи", "vs", "топ"],
  el: ["πως", "τι", "ποιο", "ποια", "ποιοι", "ποιον", "ποτε", "που", "γιατι", "ποσα", "ποσο",
    "καλυτερο", "καλυτερη", "καλυτερος", "καλυτεροι", "top", "vs"],
};
const FOLDED_QUESTION_WORDS = new Map<string, string[]>(
  Object.entries(QUESTION_WORDS).map(([lang, words]) => [lang, words.map(fold)]),
);
const ALL_FOLDED_WORDS: string[][] = [...FOLDED_QUESTION_WORDS.values()];

/** True when a GSC query is shaped like a real question people would ask an AI assistant. */
export function questionLike(query: string, lang: string): boolean {
  const q = (query || "").trim();
  if (!q) return false;
  if (q.includes("?")) return true;
  const first = fold(q).split(/\s+/)[0] ?? "";
  if (!first) return false;
  const l = (lang || "").trim().toLowerCase().slice(0, 2);
  // Unknown language (or none given): try every list rather than silently answering "no" —
  // GSC queries arrive in whatever language the site's visitors speak.
  const lists = FOLDED_QUESTION_WORDS.get(l) ? [FOLDED_QUESTION_WORDS.get(l)!] : ALL_FOLDED_WORDS;
  return lists.some(list => list.includes(first));
}

// ─── sentiment distribution (N7) ──────────────────────────────────────────────

/** Counts per sentiment over the answers that mention the brand. `notAnalysed` = mentions the
 *  sentiment pass has not reached (or the model answered garbage for): null, not zero, not
 *  "neutral" — an unmeasured answer is a different thing from a measured neutral one. */
export interface SentimentSlice {
  positive: number;
  neutral: number;
  negative: number;
  mixed: number;
  notAnalysed: number;
}

const emptySlice = (): SentimentSlice => ({ positive: 0, neutral: 0, negative: 0, mixed: 0, notAnalysed: 0 });

/** Distribution of stored sentiment across `answers` (expected: the windowed latest-per-pair
 *  list) that mention the brand behind `terms`. Returns null when the brand is not mentioned
 *  anywhere — "no data", never a slice of zeros pretending to be a measurement. */
export function sentimentDistribution(answers: SovAnswer[], terms: string[]): SentimentSlice | null {
  const rows = answers.filter(a => a.status === "cited" || a.status === "mentioned" || mentionsOf(a.answerText ?? "", terms));
  if (!rows.length) return null;
  const slice = emptySlice();
  for (const r of rows) {
    if (r.sentiment === "positive" || r.sentiment === "neutral" || r.sentiment === "negative" || r.sentiment === "mixed") {
      slice[r.sentiment] += 1;
    } else {
      slice.notAnalysed += 1;
    }
  }
  return slice;
}
