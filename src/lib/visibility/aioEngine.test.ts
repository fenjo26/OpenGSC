// N7 — parsers for the "ai_overview" engine, against fixtures captured from the two suppliers'
// documented shapes. Pure functions only: no network, no Prisma, no instance needed.

import test from "node:test";
import assert from "node:assert/strict";

import { parseDataForSeoAiOverview, parseAparserAiOverview } from "@/lib/seo/aeo";

// ─── DataForSEO SERP Advanced ─────────────────────────────────────────────────

test("parseDataForSeoAiOverview: ai_overview item with items[] sources", () => {
  const data = {
    status_code: 20000,
    tasks: [{
      status_code: 20000,
      result: [{
        items: [
          { type: "organic", rank_absolute: 1, url: "https://organic.example/a", title: "Organic A" },
          {
            type: "ai_overview",
            position: "top",
            text: "Acme and Beta both offer airport transfers in Thessaloniki; Acme is rated higher.",
            items: [
              { type: "ai_overview_item", source: "acme.com", url: "https://acme.com/transfers", title: "Acme transfers" },
              { type: "ai_overview_item", source: "blog.beta.gr", url: "https://blog.beta.gr/guide", title: "Beta guide" },
            ],
          },
        ],
      }],
    }],
  };
  const p = parseDataForSeoAiOverview(data);
  assert.equal(p.noOverview, false);
  assert.match(p.text, /Acme and Beta both offer/);
  assert.equal(p.citations.length, 2);
  assert.deepEqual(p.citations[0], { url: "https://acme.com/transfers", domain: "acme.com", title: "Acme transfers" });
  assert.deepEqual(p.citations[1], { url: "https://blog.beta.gr/guide", domain: "blog.beta.gr", title: "Beta guide" });
});

test("parseDataForSeoAiOverview: references[] spelling and domain field", () => {
  const data = {
    tasks: [{ result: [{ items: [{
      type: "ai_overview",
      text: "Overview text.",
      references: [
        { domain: "example.com", url: "https://example.com/x", title: "X" },
        { domain: "", source: "other.org", url: "https://other.org/y", title: "Y" }, // empty domain → source wins
        { title: "no url, no domain — dropped" },
      ],
    }] }] }],
  };
  const p = parseDataForSeoAiOverview(data);
  assert.equal(p.noOverview, false);
  assert.equal(p.citations.length, 2);
  assert.equal(p.citations[1]!.domain, "other.org");
});

test("parseDataForSeoAiOverview: no ai_overview block → noOverview (a verdict, not an error)", () => {
  const data = { tasks: [{ result: [{ items: [
    { type: "organic", url: "https://organic.example/a", title: "A" },
    { type: "people_also_ask", items: [{ title: "q?" }] },
  ] }] }] };
  const p = parseDataForSeoAiOverview(data);
  assert.equal(p.noOverview, true);
  assert.equal(p.text, "");
  assert.equal(p.citations.length, 0);
});

test("parseDataForSeoAiOverview: empty SERP items and malformed envelopes → noOverview, never a throw", () => {
  assert.equal(parseDataForSeoAiOverview(null).noOverview, true);
  assert.equal(parseDataForSeoAiOverview({}).noOverview, true);
  assert.equal(parseDataForSeoAiOverview({ tasks: [] }).noOverview, true);
  assert.equal(parseDataForSeoAiOverview({ tasks: [{ result: [] }] }).noOverview, true);
});

test("parseDataForSeoAiOverview: no top text → item texts joined", () => {
  const data = { tasks: [{ result: [{ items: [{
    type: "ai_overview",
    items: [
      { source: "a.com", url: "https://a.com/1", title: "1", text: "First part." },
      { source: "b.com", url: "https://b.com/2", title: "2", text: "Second part." },
    ],
  }] }] }] };
  const p = parseDataForSeoAiOverview(data);
  assert.equal(p.noOverview, false);
  assert.equal(p.text, "First part.\nSecond part.");
});

test("parseDataForSeoAiOverview: block with neither text nor sources counts as absent", () => {
  const data = { tasks: [{ result: [{ items: [{ type: "ai_overview" }] }] }] };
  assert.equal(parseDataForSeoAiOverview(data).noOverview, true);
});

// ─── A-Parser SE::Google row ──────────────────────────────────────────────────

test("parseAparserAiOverview: ai_answer text present, no citations from the parser itself", () => {
  const p = parseAparserAiOverview({ ai_answer: "Acme είναι αξιόπιστος μεταφορέας.", ai_type: "works", serp: [] });
  assert.equal(p.noOverview, false);
  assert.equal(p.text, "Acme είναι αξιόπιστος μεταφορέας.");
  assert.equal(p.citations.length, 0); // links, if any, come from the text via linksFromText
});

test("parseAparserAiOverview: 'none' / empty / absent ai_answer → noOverview", () => {
  assert.equal(parseAparserAiOverview({ ai_answer: "none", ai_type: "none" }).noOverview, true);
  assert.equal(parseAparserAiOverview({ ai_answer: "NONE" }).noOverview, true);
  assert.equal(parseAparserAiOverview({ ai_answer: "", ai_type: "none" }).noOverview, true);
  assert.equal(parseAparserAiOverview({ serp: ["https://a.gr/", "T", "S"] }).noOverview, true);
  assert.equal(parseAparserAiOverview(null).noOverview, true);
});

test("parseAparserAiOverview: non-string ai_answer is stringified, not crashed on", () => {
  const p = parseAparserAiOverview({ ai_answer: 12345 });
  assert.equal(p.noOverview, false);
  assert.equal(p.text, "12345");
});
