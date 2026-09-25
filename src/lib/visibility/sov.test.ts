import test from "node:test";
import assert from "node:assert/strict";

import {
  mentionsOf, latestPerQuestionEngine, buildSovReport, buildCitedDomains, questionLike, isoWeek,
  sentimentDistribution,
  type SovAnswer,
} from "./sov";
import { parseGeminiGrounding } from "@/lib/seo/aeo";
import { normalizeCompetitorDomain, sanitizeCompetitors } from "./store";

const d = (s: string) => new Date(s);

// ─── mentionsOf ───────────────────────────────────────────────────────────────

test("mentionsOf: word boundary", () => {
  assert.equal(mentionsOf("Welcome to Acme!", ["Acme"]), true);
  assert.equal(mentionsOf("ACME corp released", ["acme"]), true);        // case-insensitive
  assert.equal(mentionsOf("Acmeville is a city", ["Acme"]), false);      // substring ≠ mention
  assert.equal(mentionsOf("Подрядчик сдал объект", ["Подряд"]), false);  // Cyrillic boundary
  assert.equal(mentionsOf("Этот Подряд завершён", ["Подряд"]), true);
});

test("mentionsOf: diacritics-insensitive", () => {
  assert.equal(mentionsOf("Лучший Café in town", ["Cafe"]), true);   // term without accent…
  assert.equal(mentionsOf("Best cafe in town", ["Café"]), true);     // …and text without accent
  assert.equal(mentionsOf("Βρήκαμε το καλύτερο", ["καλυτερο"]), true); // Greek tonos folded
});

test("mentionsOf: terms shorter than 3 chars are ignored", () => {
  assert.equal(mentionsOf("vs code review", ["vs"]), false);
  assert.equal(mentionsOf("ai tools compared", ["ai"]), false);
});

test("mentionsOf: bare domain in text counts", () => {
  assert.equal(mentionsOf("see docs at example.com for more", ["example.com"]), true);
  assert.equal(mentionsOf("see docs at notexample.com", ["example.com"]), false); // dot boundary
  assert.equal(mentionsOf("", ["example.com"]), false);
});

// ─── latestPerQuestionEngine ──────────────────────────────────────────────────

test("latestPerQuestionEngine: one latest per (question, engine); errors dropped", () => {
  const base = { question: "q", citations: [], rank: null, status: null as string | null };
  const answers: SovAnswer[] = [
    // five checks of the SAME pair → only the Sep-20 one survives
    { ...base, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-05T10:00:00Z"), answerText: "old 5" },
    { ...base, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-08T10:00:00Z"), answerText: "old 8" },
    { ...base, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-10T10:00:00Z"), answerText: "old 10" },
    { ...base, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-15T10:00:00Z"), answerText: "old 15" },
    { ...base, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-20T10:00:00Z"), answerText: "latest" },
    // errored check of the same pair (error rows never store answer text) — must not win
    { ...base, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-25T10:00:00Z"), answerText: null },
    // other pair + out-of-window row
    { ...base, questionId: "q1", engine: "perplexity", checkedAt: d("2026-09-12T10:00:00Z"), answerText: "ppx" },
    { ...base, questionId: "q2", engine: "chatgpt", checkedAt: d("2026-01-01T10:00:00Z"), answerText: "outside window" },
  ];
  const latest = latestPerQuestionEngine(answers, d("2026-09-01T00:00:00Z"), d("2026-09-30T00:00:00Z"));
  assert.equal(latest.length, 2);
  const q1chat = latest.find(a => a.engine === "chatgpt" && a.questionId === "q1")!;
  assert.equal(q1chat.answerText, "latest"); // newest row WITH text, not the errored Sep-25 one
  assert.ok(latest.some(a => a.engine === "perplexity" && a.questionId === "q1"));
  assert.ok(!latest.some(a => a.questionId === "q2")); // out of window
});

// ─── buildSovReport: hand-computed fixture ────────────────────────────────────
//
// Six answers, two questions (q1, q2), two engines (chatgpt, perplexity), two competitors
// (Acme/acme.com/"Acme Corp", Beta/betatools.io/no extra terms). Us = mysite.com / "MySite".
// Rows #1 and #6 are superseded by a newer check of the same pair and must count for nothing.
//
//   # pair          date  status     answerText                          citations
//   1 q1/chatgpt    Sep10 cited #2   "Acme is great, MySite too."        acme.com, blog.mysite.com   [SUPERSEDED by #3]
//   2 q1/perplexity Sep15 absent     "Acme Corp leads."                  acme.com, example.org
//   3 q1/chatgpt    Sep20 mentioned  "Beta is okay; MySite cheaper."     betatools.io                [supersedes #1]
//   4 q2/chatgpt    Sep12 (null)     "You can use Acme."                 —
//   5 q2/perplexity Sep25 cited  #1  "MySite does it best."              mysite.com
//   6 q2/perplexity Sep05 mentioned  "Beta mentioned."                   betatools.io                [SUPERSEDED by #5]
//
// Latest rows = {#2, #3, #4, #5} → questions 2, answers 4.
//
// Share of voice (mentioned = status cited|mentioned OR term in text):
//   us   : #3 (mentioned) + #5 (cited)                            = 2
//   Acme : #2 ("Acme Corp") + #4 ("Acme")                         = 2
//   Beta : #3 ("Beta")                                            = 1
//   total = 5 → us 2/5 = 0.4 · Acme 2/5 = 0.4 · Beta 1/5 = 0.2
//
// Citation share (host-boundary match on the citations of latest rows only):
//   us   : #5 mysite.com                                           = 1
//   Acme : #2 acme.com                                             = 1   (#1's acme.com is superseded)
//   Beta : #3 betatools.io                                         = 1   (#6's is superseded)
//   total = 3 → everyone 1/3.
//
// byEngine:
//   chatgpt    (#3,#4): answers 2 · us mentioned 1 (#3), cited 0 · avgRank null
//                       Acme mentioned 1 (#4) cited 0 · Beta mentioned 1 (#3) cited 1 (#3)
//   perplexity (#2,#5): answers 2 · us mentioned 1 (#5), cited 1 (#5) · avgRank 1 (#5 rank 1)
//                       Acme mentioned 1 (#2) cited 1 (#2) · Beta 0/0
//
// trend weeks (latest rows only): week of Sep 14–20 has #2 (Sep 15) and #3 (Sep 20) →
//   us 1, Acme 1, Beta 1 → 1/3; week of Sep 21–27 has #5 → us 1 / 1 = 1;
//   week of Sep 7–13 has #4 → 0 / (0 + 1 Acme) = 0; weeks with no rows → null.

const RIVALS = [
  { name: "Acme", domain: "acme.com", terms: ["Acme Corp"] },
  { name: "Beta", domain: "betatools.io", terms: [] },
];

function fixtureAnswers(): SovAnswer[] {
  const q1 = { question: "best crm for agencies" };
  const q2 = { question: "how to track mentions" };
  return [
    { ...q1, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-10T10:00:00Z"), status: "cited", rank: 2,
      answerText: "Acme is great, MySite too.",
      citations: [{ url: "https://acme.com/a", domain: "acme.com", title: "A" }, { url: "https://blog.mysite.com/b", domain: "blog.mysite.com", title: "B" }] },
    { ...q1, questionId: "q1", engine: "perplexity", checkedAt: d("2026-09-15T10:00:00Z"), status: "absent", rank: null,
      answerText: "Acme Corp leads.",
      citations: [{ url: "https://acme.com/c", domain: "acme.com", title: "C" }, { url: "https://example.org/d", domain: "example.org", title: "D" }] },
    { ...q1, questionId: "q1", engine: "chatgpt", checkedAt: d("2026-09-20T10:00:00Z"), status: "mentioned", rank: null,
      answerText: "Beta is okay; MySite cheaper.",
      citations: [{ url: "https://betatools.io/e", domain: "betatools.io", title: "E" }] },
    { ...q2, questionId: "q2", engine: "chatgpt", checkedAt: d("2026-09-12T10:00:00Z"), status: null, rank: null,
      answerText: "You can use Acme.", citations: [] },
    { ...q2, questionId: "q2", engine: "perplexity", checkedAt: d("2026-09-25T10:00:00Z"), status: "cited", rank: 1,
      answerText: "MySite does it best.",
      citations: [{ url: "https://mysite.com/f", domain: "mysite.com", title: "F" }] },
    { ...q2, questionId: "q2", engine: "perplexity", checkedAt: d("2026-09-05T10:00:00Z"), status: "mentioned", rank: null,
      answerText: "Beta mentioned.",
      citations: [{ url: "https://betatools.io/g", domain: "betatools.io", title: "G" }] },
  ];
}

const FROM = d("2026-09-01T00:00:00Z");
const TO = d("2026-09-30T00:00:00Z");

test("buildSovReport: shares match the hand computation above", () => {
  const r = buildSovReport(fixtureAnswers(), { host: "mysite.com", terms: ["MySite"] }, RIVALS, FROM, TO);

  assert.equal(r.questions, 2);
  assert.equal(r.answers, 4);

  const us = r.shareOfVoice.find(x => x.isUs)!;
  const acme = r.shareOfVoice.find(x => x.name === "Acme")!;
  const beta = r.shareOfVoice.find(x => x.name === "Beta")!;
  assert.equal(us.mentions, 2);
  assert.equal(acme.mentions, 2);
  assert.equal(beta.mentions, 1);
  assert.ok(Math.abs(us.share - 0.4) < 1e-9);
  assert.ok(Math.abs(acme.share - 0.4) < 1e-9);
  assert.ok(Math.abs(beta.share - 0.2) < 1e-9);
  assert.ok(Math.abs(us.share + acme.share + beta.share - 1) < 1e-9);

  const usCit = r.citationShare.find(x => x.isUs)!;
  const acmeCit = r.citationShare.find(x => x.name === "Acme")!;
  const betaCit = r.citationShare.find(x => x.name === "Beta")!;
  assert.equal(usCit.citations, 1);
  assert.equal(acmeCit.citations, 1);   // #1's acme.com citation was superseded
  assert.equal(betaCit.citations, 1);   // #6's betatools.io citation was superseded
  assert.ok(Math.abs(usCit.share - 1 / 3) < 1e-9);

  const chat = r.byEngine.find(e => e.engine === "chatgpt")!;
  const ppx = r.byEngine.find(e => e.engine === "perplexity")!;
  assert.equal(chat.answers, 2);
  assert.equal(chat.us.mentioned, 1);
  assert.equal(chat.us.cited, 0);
  assert.equal(chat.us.avgRank, null);
  assert.equal(chat.competitors.find(c => c.name === "Acme")!.mentioned, 1);
  assert.equal(chat.competitors.find(c => c.name === "Beta")!.cited, 1);
  assert.equal(ppx.answers, 2);
  assert.equal(ppx.us.cited, 1);
  assert.equal(ppx.us.avgRank, 1);
  assert.equal(ppx.competitors.find(c => c.name === "Acme")!.cited, 1);

  const w20 = r.trend.find(w => w.week === isoWeek(d("2026-09-20T12:00:00Z")))!;
  const w25 = r.trend.find(w => w.week === isoWeek(d("2026-09-25T12:00:00Z")))!;
  const w12 = r.trend.find(w => w.week === isoWeek(d("2026-09-12T12:00:00Z")))!; // contains #4 (Sep 12)
  const wEmpty = r.trend.find(w => w.week === isoWeek(d("2026-09-01T12:00:00Z")))!; // before any row
  assert.ok(Math.abs(w20.usShare! - 1 / 3) < 1e-9); // #2 + #3: us 1, Acme 1, Beta 1
  assert.ok(Math.abs(w25.usShare! - 1) < 1e-9);
  assert.equal(w12.usShare, 0);   // answers exist, Acme mentioned, we are absent → a real 0
  assert.equal(wEmpty.usShare, null); // no answers at all → no verdict
});

test("buildSovReport: zero mentions anywhere → shares are 0, no NaN (\"no data\", not 0 %)", () => {
  const answers: SovAnswer[] = [{
    questionId: "q1", question: "q", engine: "chatgpt", checkedAt: d("2026-09-10T10:00:00Z"),
    status: "absent", rank: null, answerText: "Nothing branded here at all.", citations: [],
  }];
  const r = buildSovReport(answers, { host: "mysite.com", terms: ["MySite"] }, RIVALS, FROM, TO);
  assert.equal(r.answers, 1);
  for (const x of r.shareOfVoice) { assert.equal(x.mentions, 0); assert.equal(x.share, 0); assert.ok(Number.isFinite(x.share)); }
  for (const x of r.citationShare) { assert.equal(x.citations, 0); assert.equal(x.share, 0); }
  // Weeks with answers but zero brand mentions are "no data" in the trend too.
  assert.equal(r.trend.find(w => w.usShare !== null), undefined);
});

// ─── buildCitedDomains ────────────────────────────────────────────────────────

test("buildCitedDomains: www-collapse, flags, sort, newest example, limit", () => {
  const answers: SovAnswer[] = [
    { questionId: "q1", question: "newest question", engine: "chatgpt", checkedAt: d("2026-09-25T10:00:00Z"),
      status: "cited", rank: null, answerText: "text",
      citations: [
        { url: "https://www.example.com/x", domain: "www.example.com", title: "X" },
        { url: "https://acme.com/y", domain: "acme.com", title: "Y" },
      ] },
    { questionId: "q1", question: "newest question", engine: "perplexity", checkedAt: d("2026-09-20T10:00:00Z"),
      status: "cited", rank: null, answerText: "text",
      citations: [{ url: "https://example.com/z", domain: "example.com", title: "Z" }] },
    { questionId: "q2", question: "other question", engine: "gemini", checkedAt: d("2026-09-10T10:00:00Z"),
      status: "cited", rank: null, answerText: "text",
      citations: [
        { url: "https://blog.mysite.com/p", domain: "blog.mysite.com", title: "P" },
        { url: "https://sub.acme.com/q", domain: "sub.acme.com", title: "Q" },
      ] },
  ];
  const rows = buildCitedDomains(answers, { host: "mysite.com" }, RIVALS, 50);

  // www.example.com + example.com collapse into one domain cited by 2 answers / 2 slots.
  const example = rows.find(x => x.domain === "example.com")!;
  assert.equal(example.citations, 2);
  assert.equal(example.answers, 2);
  assert.equal(example.questions, 1);
  assert.deepEqual([...example.engines].sort(), ["chatgpt", "perplexity"]);
  assert.equal(example.isUs, false);
  assert.equal(example.competitor, null);
  // the example comes from the newest citing answer
  assert.equal(example.exampleQuestion, "newest question");
  assert.equal(example.exampleUrl, "https://www.example.com/x");

  const ours = rows.find(x => x.domain === "blog.mysite.com")!;
  assert.equal(ours.isUs, true);
  assert.equal(ours.competitor, null);

  const acme = rows.find(x => x.domain === "acme.com")!;
  assert.equal(acme.competitor, "Acme");
  const subAcme = rows.find(x => x.domain === "sub.acme.com")!;
  assert.equal(subAcme.competitor, "Acme"); // host-boundary match, not string equality

  // sort: answers desc, then citations desc → example.com (2 answers) first
  assert.equal(rows[0].domain, "example.com");
  // limit
  assert.equal(buildCitedDomains(answers, { host: "mysite.com" }, RIVALS, 2).length, 2);
});

// ─── questionLike ─────────────────────────────────────────────────────────────

test("questionLike: english", () => {
  assert.equal(questionLike("how to fix a leaky faucet", "en"), true);
  assert.equal(questionLike("What is schema markup?", "en"), true);
  assert.equal(questionLike("best crm for agencies", "en"), true);
  assert.equal(questionLike("buy running shoes", "en"), false);
  assert.equal(questionLike("nike air max review site", "en"), false);
  assert.equal(questionLike("transfer thessaloniki price", "en"), false);
});

test("questionLike: french", () => {
  assert.equal(questionLike("comment créer un site", "fr"), true);
  assert.equal(questionLike("quel hébergeur choisir", "fr"), true);
  assert.equal(questionLike("Meilleur café à Paris", "fr"), true);
  assert.equal(questionLike("chaussures de running homme", "fr"), false);
  assert.equal(questionLike("prix billet de train", "fr"), false);
  assert.equal(questionLike("location voiture Athènes", "fr"), false);
});

test("questionLike: russian (and ё folding)", () => {
  assert.equal(questionLike("как выбрать пылесос", "ru"), true);
  assert.equal(questionLike("что такое сео", "ru"), true);
  assert.equal(questionLike("Лучший хостинг для сайтов", "ru"), true);
  assert.equal(questionLike("купить кроссовки онлайн", "ru"), false);
  assert.equal(questionLike("цена авиабилета", "ru"), false);
  assert.equal(questionLike("пылесос дайсон характеристики", "ru"), false);
});

test("questionLike: greek (tonos folding)", () => {
  assert.equal(questionLike("πως να φτιάξω site", "el"), true);
  assert.equal(questionLike("τι είναι seo", "el"), true);
  assert.equal(questionLike("Καλύτερο φθηνό hosting", "el"), true);
  assert.equal(questionLike("παπούτσια για τρέξιμο", "el"), false);
  assert.equal(questionLike("τιμές ενοικίασης αυτοκινήτων", "el"), false); // τιμές ≠ τι
  assert.equal(questionLike("αεροπορικά εισιτήρια", "el"), false);
});

test("questionLike: '?' counts in any language; empty does not", () => {
  assert.equal(questionLike("καθαρισμός στόματος ?", "el"), true);
  assert.equal(questionLike("zagreb split prijevoz?", "hr"), true);
  assert.equal(questionLike("", "en"), false);
});

// ─── competitor list sanitizing (store helpers, pure) ─────────────────────────

test("sanitizeCompetitors: name required, domain normalized, capped at 10", () => {
  const list = sanitizeCompetitors([
    { name: "Acme", domain: "https://www.Acme.com/path?q=1", terms: ["Acme Corp", "", "x"] },
    { name: "  ", domain: "ignored.com", terms: [] },          // blank name → dropped
    { domain: "nodomain.com", terms: [] },                     // no name → dropped
    "junk",
    ...Array.from({ length: 12 }, (_, i) => ({ name: `R${i}`, domain: "", terms: [] })),
  ]);
  assert.equal(list.length, 10);
  assert.equal(list[0].name, "Acme");
  assert.equal(list[0].domain, "acme.com");
  assert.deepEqual(list[0].terms, ["Acme Corp", "x"]);
  assert.equal(normalizeCompetitorDomain("http://www.example.co.uk/deep/path"), "example.co.uk");
  assert.equal(normalizeCompetitorDomain(""), "");
});

// ─── Gemini groundingMetadata parse ───────────────────────────────────────────

test("parseGeminiGrounding: text, citations from groundingChunks, searched flag", () => {
  const data = {
    candidates: [{
      content: { parts: [{ text: "Acme and MySite both work. " }, { text: "See the sources." }] },
      groundingMetadata: {
        webSearchQueries: ["best crm for agencies"],
        groundingChunks: [
          // uri is a vertexaisearch redirect; the source host hides at the end of the title
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCd", title: "Acme CRM review — acme.com" } },
          // title that does not name a host → domain stays empty, never a guess
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/EfGh", title: "A very long blog headline" } },
          // title that IS a host
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/IjKl", title: "example.org" } },
        ],
      },
    }],
  };
  const tr = parseGeminiGrounding(data, "gemini-3-flash");
  assert.equal(tr.text, "Acme and MySite both work. See the sources.");
  assert.equal(tr.searched, true);
  assert.equal(tr.model, "gemini-3-flash");
  assert.equal(tr.citations.length, 3);
  assert.equal(tr.citations[0].domain, "acme.com");
  assert.equal(tr.citations[0].title, "Acme CRM review — acme.com");
  assert.equal(tr.citations[1].domain, "");
  assert.equal(tr.citations[2].domain, "example.org");
  assert.equal(tr.citations[2].url.includes("vertexaisearch"), true);

  // no grounding at all: plain answer, no citations, searched=false
  const bare = parseGeminiGrounding({ candidates: [{ content: { parts: [{ text: "plain" }] } }] }, "gemini-3-flash");
  assert.equal(bare.text, "plain");
  assert.equal(bare.searched, false);
  assert.equal(bare.citations.length, 0);
});

// ─── no_overview (N7): a pair Google stopped showing an overview for leaves the report ──

const NO_OVERVIEW_BASE = { question: "q", citations: [] as SovAnswer["citations"], rank: null, sentiment: null as string | null };

test("latestPerQuestionEngine: newest no_overview retires the pair entirely", () => {
  const answers: SovAnswer[] = [
    { ...NO_OVERVIEW_BASE, questionId: "q1", engine: "ai_overview", checkedAt: d("2026-09-10T10:00:00Z"), status: "cited", answerText: "Acme is great, MySite too." },
    // Google still served the SERP, but no AI Overview for this question — status no_overview,
    // no answer text. This is the pair's CURRENT state, so the Sep-10 answer must not survive.
    { ...NO_OVERVIEW_BASE, questionId: "q1", engine: "ai_overview", checkedAt: d("2026-09-20T10:00:00Z"), status: "no_overview", answerText: null },
    // An errored newest row must NOT retire anything — a rate limit is not evidence.
    { ...NO_OVERVIEW_BASE, questionId: "q2", engine: "chatgpt", checkedAt: d("2026-09-10T10:00:00Z"), status: "cited", answerText: "MySite mention." },
    { ...NO_OVERVIEW_BASE, questionId: "q2", engine: "chatgpt", checkedAt: d("2026-09-25T10:00:00Z"), status: null, answerText: null },
  ];
  const latest = latestPerQuestionEngine(answers, FROM, TO);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.questionId, "q2");
  assert.equal(latest[0]!.answerText, "MySite mention.");
});

test("buildSovReport: no_overview pairs are outside every denominator", () => {
  const answers: SovAnswer[] = [
    { ...NO_OVERVIEW_BASE, questionId: "q1", engine: "ai_overview", checkedAt: d("2026-09-10T10:00:00Z"), status: "cited", answerText: "MySite is the best transfer." },
    { ...NO_OVERVIEW_BASE, questionId: "q1", engine: "ai_overview", checkedAt: d("2026-09-20T10:00:00Z"), status: "no_overview", answerText: null },
    { ...NO_OVERVIEW_BASE, questionId: "q2", engine: "chatgpt", checkedAt: d("2026-09-15T10:00:00Z"), status: "mentioned", answerText: "MySite is okay, Acme is cheaper." },
  ];
  const r = buildSovReport(answers, { host: "mysite.com", terms: ["MySite"] }, RIVALS, FROM, TO);
  // Only q2/chatgpt counts: 1 answer, 1 question — q1's superseded citation must not leak in.
  assert.equal(r.answers, 1);
  assert.equal(r.questions, 1);
  assert.equal(r.shareOfVoice[0]!.mentions, 1);
  assert.equal(r.citationShare[0]!.citations, 0);
});

// ─── sentimentDistribution (N7) ───────────────────────────────────────────────

test("sentimentDistribution: counts per verdict, notAnalysed for the rest", () => {
  const mk = (id: string, status: string, text: string, sentiment: string | null): SovAnswer => ({
    questionId: id, question: "q", engine: "chatgpt", checkedAt: d("2026-09-10T10:00:00Z"),
    status, rank: null, citations: [], answerText: text, sentiment,
  });
  const answers: SovAnswer[] = [
    mk("q1", "cited", "MySite praised.", "positive"),
    mk("q2", "mentioned", "MySite named.", "neutral"),
    mk("q3", "cited", "MySite trashed.", "negative"),
    mk("q4", "cited", "MySite mixed bag.", "mixed"),
    mk("q5", "mentioned", "MySite named again.", null),   // pass not run / garbage reply
    mk("q6", "absent", "No brand at all.", "positive"),   // not a mention → not counted at all
  ];
  const s = sentimentDistribution(answers, ["MySite"])!;
  assert.deepEqual(s, { positive: 1, neutral: 1, negative: 1, mixed: 1, notAnalysed: 1 });
});

test("sentimentDistribution: no mentions → null (\"no data\", not zeros)", () => {
  const answers: SovAnswer[] = [{
    questionId: "q1", question: "q", engine: "chatgpt", checkedAt: d("2026-09-10T10:00:00Z"),
    status: "absent", rank: null, citations: [], answerText: "Nothing branded.", sentiment: "positive",
  }];
  assert.equal(sentimentDistribution(answers, ["MySite"]), null);
  assert.equal(sentimentDistribution([], ["MySite"]), null);
});
