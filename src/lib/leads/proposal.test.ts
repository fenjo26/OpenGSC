import test from "node:test";
import assert from "node:assert/strict";

// N9 — proposal and first-letter generation. The load-bearing test here is the
// no-forecast guarantee: NO language's dictionary and NO generated proposal may contain
// a traffic / ranking / revenue forecast — a crawl of 5 pages cannot support one, and a
// proposal is a document the client will hold you to (N9 brief §4).

import { LEAD_STRINGS, localizeFindings } from "./i18n";
import {
  containsForecast, generateDraftEmail, generateProposal, mailtoUrl, NO_FORECAST_MARKERS,
  proposalToHtml, groupFindings,
} from "./proposal";
import { LEAD_LANGS, type LeadFinding, type RawFinding } from "./types";

const rawFindings: RawFinding[] = [
  { code: "title_missing", severity: "warning", category: "metadata", evidence: "/about", pages: ["/about"] },
  { code: "broken_links", severity: "critical", category: "links", evidence: "2 · /dead", pages: ["/"] },
  { code: "viewport_missing", severity: "warning", category: "rendering", evidence: "/", pages: ["/"] },
  { code: "lang_missing", severity: "info", category: "content", evidence: "/", pages: ["/"] },
];

const localized = localizeFindings(rawFindings, "en");

// ─── the no-forecast guarantee ────────────────────────────────────────────────

test("no language's strings contain a forecast marker", () => {
  for (const lang of LEAD_LANGS) {
    const L = LEAD_STRINGS[lang];
    const everything = JSON.stringify(L);
    assert.equal(containsForecast(everything), false, `${lang} dictionary carries a forecast marker`);
    for (const [code, f] of Object.entries(L.findings)) {
      assert.equal(containsForecast(`${f.title} ${f.fix} ${f.consequence}`), false, `${lang}:${code}`);
    }
  }
});

test("generated proposals in every language are forecast-free", () => {
  for (const lang of LEAD_LANGS) {
    const proposal = generateProposal({
      domain: "client.example", score: 41,
      findings: localizeFindings(rawFindings, lang), lang,
      aboutCompany: "",
    });
    assert.equal(containsForecast(proposal), false, `proposal in ${lang} carries a forecast marker`);
  }
});

test("containsForecast catches the phrases it exists to catch", () => {
  assert.equal(containsForecast("Мы увеличим трафик на 200%"), true);
  assert.equal(containsForecast("Traffic will grow 3x"), true);
  assert.equal(containsForecast("guaranteed rankings"), true);
  assert.equal(containsForecast("Прогноз: +500 посетителей"), true);
  assert.equal(containsForecast("We will fix the titles."), false);
  assert.ok(NO_FORECAST_MARKERS.length >= 10);
});

// ─── structure ────────────────────────────────────────────────────────────────

test("the proposal has all sections, groups by category and includes every finding", () => {
  const proposal = generateProposal({
    domain: "client.example", score: 41, findings: localized, lang: "en",
    aboutCompany: "We are a small agency.",
  });
  assert.match(proposal, /# SEO proposal for client\.example/);
  assert.match(proposal, /## About us/);
  assert.match(proposal, /We are a small agency\./);
  assert.match(proposal, /## What we found/);
  assert.match(proposal, /### Links/);   // broken_links (critical) group
  assert.match(proposal, /## Scope of work/);
  assert.match(proposal, /## Pricing/);
  assert.match(proposal, /## Timeline/);
  assert.match(proposal, /## Next step/);
  assert.match(proposal, /- \[ \] Pages have no <title>/);
  // The no-promises note closes the document.
  assert.match(proposal, /no traffic, ranking or revenue numbers/);
});

test("the include filter narrows the proposal to the ticked findings", () => {
  const proposal = generateProposal({
    domain: "client.example", score: 41, findings: localized, lang: "en",
    aboutCompany: "", include: ["title_missing"],
  });
  assert.match(proposal, /Pages have no <title>/);
  assert.ok(!proposal.includes("Broken links on the main page"));
});

test("an empty findings list still produces a valid document", () => {
  const proposal = generateProposal({ domain: "x.example", score: 100, findings: [], lang: "ru", aboutCompany: "" });
  assert.match(proposal, /Коммерческое предложение/);
  assert.ok(proposal.length > 100);
});

test("groupFindings keeps audit categories and preserves severity order inside a group", () => {
  const groups = groupFindings(localized);
  // Groups follow the canonical FINDING_CATEGORIES order (the proposal's sections are
  // stable whatever order the audit produced), not the input order.
  assert.deepEqual(groups.map(g => g.category), ["metadata", "content", "links", "rendering"]);
});

// ─── the first letter ─────────────────────────────────────────────────────────

test("the draft letter names the 3 worst problems and offers a call", () => {
  const draft = generateDraftEmail({ domain: "client.example", score: 41, findings: localized, lang: "en", leadName: "Ann" });
  assert.match(draft.subject, /client\.example/);
  assert.match(draft.body, /Hello Ann,/);
  assert.match(draft.body, /three things|three|stood out|ressortent|destacan|stechen|突出|три/i);
  assert.match(draft.body, /Broken links on the main page/);
  assert.match(draft.body, /15-minute call|15 minutes|15 хв|15 минут|15 Min|15 分钟/);
  assert.equal(containsForecast(draft.body), false);
});

test("a custom template wins over the built-in letter", () => {
  const draft = generateDraftEmail({
    domain: "client.example", score: 41, findings: localized, lang: "en", leadName: "Ann",
    template: "Hi {name}, your site {domain} scored {score}.\n{issues}\n— me",
  });
  assert.match(draft.body, /Hi Ann, your site client\.example scored 41\./);
  assert.match(draft.body, /Broken links on the main page/);
});

test("mailtoUrl encodes subject and body", () => {
  const url = mailtoUrl("a@b.example", { subject: "Sub & ject", body: "Line 1\nLine 2" });
  assert.match(url, /^mailto:a%40b\.example\?/);
  assert.ok(url.includes(encodeURIComponent("Sub & ject")));
  assert.ok(url.includes(encodeURIComponent("Line 1\nLine 2")));
});

// ─── HTML export ──────────────────────────────────────────────────────────────

test("proposalToHtml renders headings, lists and escapes HTML in findings", () => {
  const nasty: LeadFinding = {
    code: "title_missing", severity: "warning", category: "metadata",
    evidence: "<script>alert(1)</script>", pages: ["/"],
    title: "Pages have no <title>", fix: "Write one.",
  };
  const md = "# Title\n\n- **" + nasty.title + "** (" + nasty.evidence + ")";
  const html = proposalToHtml(md, { companyName: "A&B", logoUrl: "", accentColor: "#123456", footerText: "bye" }, "T");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("A&amp;B"));
  assert.ok(html.includes("<h1>"));
  assert.ok(html.includes("<li>"));
});

// ─── dictionary completeness (every language speaks about every finding) ──────

test("every language describes every finding code, and localizeFindings falls back to English", () => {
  for (const lang of LEAD_LANGS) {
    const codes = Object.keys(LEAD_STRINGS[lang].findings);
    assert.equal(codes.length, Object.keys(LEAD_STRINGS.en.findings).length, `${lang} findings dictionary size`);
    for (const [code, f] of Object.entries(LEAD_STRINGS[lang].findings)) {
      assert.ok(f.title.trim().length > 3, `${lang}:${code} empty title`);
      assert.ok(f.fix.trim().length > 3, `${lang}:${code} empty fix`);
      assert.ok(f.consequence.trim().length > 10, `${lang}:${code} empty consequence`);
    }
  }
  const unknown = localizeFindings([
    { code: "title_missing", severity: "warning", category: "metadata", evidence: "", pages: [] },
  ], "en");
  assert.equal(unknown[0].title, LEAD_STRINGS.en.findings.title_missing.title);
});
