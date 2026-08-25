import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSectionTextPrompt, buildFaqSectionPrompt, buildTextPrompt,
  buildSectionEnrichPrompt, buildStructureExpandPrompt, buildOutlinePrompt,
  buildTextExpandPrompt, buildTextTrimPrompt, buildAutoFactCleanPrompt, buildWireframePrompt,
} from "./prompts";
import { buildRewritePrompt } from "./rewrite";
import { DEFAULT_POLICY, type EditorialPolicy } from "./policy";

// What this file locks down, and why it is worth its length.
//
// The bug it exists to prevent shipped for months and was invisible from every angle a person
// normally looks from. The field was in the type. The UI wrote it. The API carried it. The MCP
// schema documented it. `buildTextPrompt` rendered it — and `buildTextPrompt` is not the builder
// that runs: any outline with 10+ sections goes to the chunked writer, whose prompt never
// mentioned the instruction at all. So the pipeline read the user's text, passed it through six
// layers, and dropped it in the last one, silently, on the default path.
//
// Nothing in a normal test suite catches that. A test of the pipeline would need a model; a test
// of the type would pass; a test of the UI would pass. The one cheap check that would have caught
// it is the one below: prompt builders are pure string functions, so ASSERT THE USER'S TEXT IS IN
// THE STRING. Every builder that writes prose or shapes structure appears here. When a new one is
// added, its absence from this file is the omission to notice.

const AUTHOR = "NEVER-NAME-A-COMPETITOR-sentinel-8f3a";
const RULES = "NO-SEPARATE-SECTION-FOR-THE-REVERSE-ROUTE-sentinel-91b2";
const TEMPLATE = "H2-TEMPLATE-SKELETON-sentinel-c4d7";
const BANNED = "sentinel-bannedword-e2f1";

/** A policy carrying one unmistakable string, so "the policy block is present" is checkable. */
const POLICY: EditorialPolicy = {
  ...DEFAULT_POLICY,
  brand: { ...DEFAULT_POLICY.brand, name: "SentinelBrandCo-a7c9" },
};

const OUTLINE = {
  meta: {
    keyword: "athens airport to piraeus",
    language: "en",
    country: "gr",
    h1: "Athens Airport to Piraeus Port",
    narration: "first",
    target_word_count: 1800,
    structureRules: RULES,
  },
  sections: [
    { h_level: "H2", heading: "Getting to the port", word_count: [200, 300], summary: "", keywords: ["x"] },
    { h_level: "H3", heading: "By taxi", word_count: [120, 180], summary: "", keywords: ["y"] },
  ],
  faq: [{ question: "How long does it take?", answer_guideline: "40 minutes" }],
};

// ─── The chunked writer: the builder that actually writes almost every article ────────

test("buildSectionTextPrompt carries the author's instruction", () => {
  const p = buildSectionTextPrompt({
    keyword: "k", language: "en", tone: "expert", allHeadings: [], sections: OUTLINE.sections,
    custom: AUTHOR, promptType: "service",
  });
  assert.equal(p.includes(AUTHOR), true, "the author's instruction is missing from the chunk prompt");
});

test("buildSectionTextPrompt marks a custom-type instruction as the highest priority", () => {
  const service = buildSectionTextPrompt({
    keyword: "k", language: "en", tone: "expert", allHeadings: [], sections: OUTLINE.sections,
    custom: AUTHOR, promptType: "service",
  });
  const custom = buildSectionTextPrompt({
    keyword: "k", language: "en", tone: "expert", allHeadings: [], sections: OUTLINE.sections,
    custom: AUTHOR, promptType: "custom",
  });
  assert.equal(custom.includes("ВЫСШИЙ ПРИОРИТЕТ"), true);
  assert.equal(service.includes("ВЫСШИЙ ПРИОРИТЕТ"), false);
});

test("buildSectionTextPrompt carries the editorial policy and the structure rules", () => {
  const p = buildSectionTextPrompt({
    keyword: "k", language: "en", tone: "expert", allHeadings: [], sections: OUTLINE.sections,
    policy: POLICY, structureRules: RULES,
  });
  assert.equal(p.includes("SentinelBrandCo-a7c9"), true, "policy block missing");
  assert.equal(p.includes(RULES), true, "structure rules missing");
});

test("buildSectionTextPrompt states the market's currency, so prices are not quoted in dollars", () => {
  const p = buildSectionTextPrompt({
    keyword: "k", language: "en", country: "gr", tone: "expert", allHeadings: [], sections: OUTLINE.sections,
  });
  assert.equal(p.includes("EUR (€)"), true);
});

test("buildSectionTextPrompt adds no author block when there is no instruction", () => {
  // The empty case matters: an "instruction" heading with nothing under it is a prompt telling the
  // model a constraint exists and refusing to say what it is.
  const p = buildSectionTextPrompt({
    keyword: "k", language: "en", tone: "expert", allHeadings: [], sections: OUTLINE.sections,
  });
  assert.equal(p.includes("ИНСТРУКЦИЯ АВТОРА"), false);
});

// ─── The FAQ pass: one call, previously the only prompt in the pipeline with no rules ────

test("buildFaqSectionPrompt carries the policy, the instruction and the banned vocabulary", () => {
  const p = buildFaqSectionPrompt({
    keyword: "k", language: "en", faq: OUTLINE.faq,
    policy: POLICY, custom: AUTHOR, bannedWords: [BANNED], country: "gr",
  });
  assert.equal(p.includes("SentinelBrandCo-a7c9"), true, "policy missing from the FAQ call");
  assert.equal(p.includes(AUTHOR), true, "instruction missing from the FAQ call");
  assert.equal(p.includes(BANNED), true, "banned vocabulary missing from the FAQ call");
  assert.equal(p.includes("EUR (€)"), true, "currency rule missing from the FAQ call");
});

// ─── The single-shot writer (fallback path) ──────────────────────────────────────────

test("buildTextPrompt carries the instruction in both prompt types", () => {
  const service = buildTextPrompt({ outlineJson: OUTLINE, tone: "expert", language: "en", custom: AUTHOR, promptType: "service" });
  const custom = buildTextPrompt({ outlineJson: OUTLINE, tone: "expert", language: "en", custom: AUTHOR, promptType: "custom" });
  assert.equal(service.includes(AUTHOR), true);
  assert.equal(custom.includes(AUTHOR), true);
  // structureRules ride on the outline for this builder, not as an argument.
  assert.equal(service.includes(RULES), true);
});

// ─── The outline side ────────────────────────────────────────────────────────────────

test("buildSectionEnrichPrompt carries what the notes it writes must not contradict", () => {
  // These notes ARE the writer's brief for a section. Enriching them blind to the policy is how a
  // compliant skeleton acquires copywriter_notes telling the writer to do the forbidden thing.
  const p = buildSectionEnrichPrompt({
    keyword: "k", language: "en", country: "gr", sections: OUTLINE.sections,
    policy: POLICY, structureRules: RULES, custom: AUTHOR, bannedWords: [BANNED],
  });
  assert.equal(p.includes("SentinelBrandCo-a7c9"), true, "policy missing from the enrich pass");
  assert.equal(p.includes(RULES), true, "structure rules missing from the enrich pass");
  assert.equal(p.includes(AUTHOR), true, "instruction missing from the enrich pass");
  assert.equal(p.includes(BANNED), true, "banned vocabulary missing from the enrich pass");
});

test("buildStructureExpandPrompt knows which headings must not exist", () => {
  // This pass invents headings. Without the rules it re-adds the section the outline step was
  // told to leave out, and reports success for doing it.
  const p = buildStructureExpandPrompt({
    keyword: "k", language: "en", country: "gr",
    sections: OUTLINE.sections.map(s => ({ h_level: s.h_level, heading: s.heading })),
    structureRules: RULES, policy: POLICY,
  });
  assert.equal(p.includes(RULES), true, "structure rules missing from the expand pass");
  assert.equal(p.includes("SentinelBrandCo-a7c9"), true, "policy missing from the expand pass");
});

test("buildOutlinePrompt carries the instruction, the rules and the custom template", () => {
  const p = buildOutlinePrompt({
    keyword: "k", language: "en", country: "gr", competitors: [],
    policy: POLICY, custom: AUTHOR, structureRules: RULES, customTemplate: TEMPLATE, bannedWords: [BANNED],
  });
  assert.equal(p.includes(AUTHOR), true, "instruction missing from the outline prompt");
  assert.equal(p.includes(RULES), true);
  assert.equal(p.includes(TEMPLATE), true);
  assert.equal(p.includes("SentinelBrandCo-a7c9"), true);
  assert.equal(p.includes(BANNED), true);
});

// ─── Cross-builder invariant ─────────────────────────────────────────────────────────

test("every prose-writing builder renders the instruction it is given", () => {
  // Stated once as a loop as well as individually above, so a new builder can be added to one
  // array and inherit the check rather than needing a test written for it from scratch.
  const built: [string, string][] = [
    ["chunk writer", buildSectionTextPrompt({ keyword: "k", language: "en", tone: "t", allHeadings: [], sections: OUTLINE.sections, custom: AUTHOR })],
    ["faq", buildFaqSectionPrompt({ keyword: "k", language: "en", faq: OUTLINE.faq, custom: AUTHOR })],
    ["single-shot", buildTextPrompt({ outlineJson: OUTLINE, tone: "t", language: "en", custom: AUTHOR })],
    ["enrich", buildSectionEnrichPrompt({ keyword: "k", language: "en", country: "gr", sections: OUTLINE.sections, custom: AUTHOR })],
    ["outline", buildOutlinePrompt({ keyword: "k", language: "en", country: "gr", competitors: [], custom: AUTHOR })],
    ["rewrite", buildRewritePrompt({ source: "## H\n\nbody", custom: AUTHOR })],
  ];
  const missing = built.filter(([, p]) => !p.includes(AUTHOR)).map(([name]) => name);
  assert.deepEqual(missing, [], `these builders silently dropped the author's instruction: ${missing.join(", ")}`);
});

// ─── Rewrite ─────────────────────────────────────────────────────────────────────────
// Extracted out of rewriteContent purely so these can exist: it was the only prompt on the
// instance that no test could reach, which is the exact position the chunked writer was in.

const SOURCE = "# Athens transfers\n\n## Taxi\n\nThe flat fare is €40 by day and €55 at night, about 40 minutes.\n";

test("buildRewritePrompt carries the per-job instruction, the policy and the banned vocabulary", () => {
  const p = buildRewritePrompt({
    source: SOURCE, policy: POLICY, custom: AUTHOR, bannedWords: [BANNED], language: "Greek",
  });
  assert.equal(p.includes(AUTHOR), true, "instruction missing from the rewrite prompt");
  assert.equal(p.includes("SentinelBrandCo-a7c9"), true, "policy missing from the rewrite prompt");
  assert.equal(p.includes(BANNED), true, "banned vocabulary missing from the rewrite prompt");
  assert.equal(p.includes("Write the rewrite in Greek."), true);
});

test("buildRewritePrompt keeps the invariants it had before extraction", () => {
  // Guards the refactor itself: these four lines were computed inline inside rewriteContent and
  // are the reason a rewrite does not quietly lose the page's values or its heading tree.
  const p = buildRewritePrompt({ source: SOURCE, targetKeywords: [{ keyword: "athens airport taxi", volume: 320 }] });
  assert.equal(p.includes("Preserve the heading structure EXACTLY"), true, "structure rule lost");
  assert.equal(p.includes("€40"), true, "the critical-values list lost a price");
  assert.equal(p.includes("do not convert € into EUR"), true, "currency-notation rule lost");
  assert.equal(p.includes('"athens airport taxi" (320/mo)'), true, "target-keyword line lost");
  assert.equal(p.endsWith(`CONTENT:\n${SOURCE}`), true, "the content must be last");
});

test("buildRewritePrompt only numbers variants when there is more than one", () => {
  const single = buildRewritePrompt({ source: SOURCE, variants: 1, variantIndex: 0 });
  const third = buildRewritePrompt({ source: SOURCE, variants: 3, variantIndex: 2 });
  assert.equal(single.includes("This is variant"), false);
  assert.equal(third.includes("This is variant #3"), true);
});

// ─── The post-passes ─────────────────────────────────────────────────────────────────
// These three rewrite a FINISHED article. Expansion is the one that matters: it adds hundreds of
// words of new prose, so a pass that cannot see the rules can hand back a page that breaks them
// after every earlier stage obeyed them.

test("expand, trim and fact-clean all carry the rules the article was written under", () => {
  const article = "# T\n\n## S\n\nbody";
  const built: [string, string][] = [
    ["expand", buildTextExpandPrompt({ article, targetWords: 1800, currentWords: 1200, language: "en", custom: AUTHOR, bannedWords: [BANNED] })],
    ["trim", buildTextTrimPrompt({ article, targetWords: 1800, currentWords: 2400, language: "en", custom: AUTHOR, bannedWords: [BANNED] })],
    ["fact-clean", buildAutoFactCleanPrompt({ article, factsBank: "[1] example.com\nfacts", language: "en", custom: AUTHOR, bannedWords: [BANNED] })],
  ];
  const missingCustom = built.filter(([, p]) => !p.includes(AUTHOR)).map(([n]) => n);
  const missingBanned = built.filter(([, p]) => !p.includes(BANNED)).map(([n]) => n);
  assert.deepEqual(missingCustom, [], `post-passes that would undo the instruction: ${missingCustom.join(", ")}`);
  assert.deepEqual(missingBanned, [], `post-passes free to reuse banned vocabulary: ${missingBanned.join(", ")}`);
});

test("a post-pass with no rules to carry adds no empty constraint block", () => {
  const p = buildTextExpandPrompt({ article: "# T", targetWords: 1800, currentWords: 1200, language: "en" });
  assert.equal(p.includes("ИНСТРУКЦИЯ АВТОРА"), false);
  assert.equal(p.includes("ЗАПРЕЩЁННАЯ ЛЕКСИКА"), false);
});

test("buildWireframePrompt carries the policy and the instruction", () => {
  // A wireframe decides which BLOCKS exist — a comparison table, a reviews strip, a booking form.
  // "No competitor comparison" is a block-level decision, so it has to land here too.
  const p = buildWireframePrompt({
    keyword: "k", language: "en", country: "gr", outline: OUTLINE, policy: POLICY, custom: AUTHOR,
  });
  assert.equal(p.includes(AUTHOR), true);
  assert.equal(p.includes("SentinelBrandCo-a7c9"), true);
});
