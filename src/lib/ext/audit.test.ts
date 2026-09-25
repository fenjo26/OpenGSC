import assert from "node:assert/strict";
import test from "node:test";
import { META_LIMITS as APP_META_LIMITS } from "@/lib/seo/metaLimits";
// Plain JS by design: the extension ships without a build step, so audit.js is a classic
// script with a module.exports footer (see the file) rather than a module. Importing it here
// keeps the app's test runner honest about what the extension actually runs. jsdom is not a
// dependency of this repo, so the DOM half (collectFacts) is verified by hand — see the N11
// report; deriveIssues is pure and covered below.
import ExtensionAudit from "../../../extension/lib/audit.js";

const { META_LIMITS, metaLength, deriveIssues, countSeverities } = ExtensionAudit as {
  META_LIMITS: typeof APP_META_LIMITS;
  metaLength: (s: string) => number;
  deriveIssues: (facts: Record<string, unknown>) => { id: string; severity: string; detail: string }[];
  countSeverities: (issues: { severity: string }[]) => { error: number; warn: number; info: number };
};

/** A facts object with every check passing; individual tests break one field at a time. */
function healthyFacts(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://example.com/page",
    host: "example.com",
    title: "x".repeat(55),
    titleLength: 55,
    description: "x".repeat(155),
    descriptionLength: 155,
    h1Count: 1,
    h1Text: "Page",
    canonical: "https://example.com/page",
    robots: "index,follow",
    noindex: false,
    hreflang: [],
    jsonLdBlocks: 1,
    jsonLdValid: 1,
    jsonLdInvalid: 0,
    og: { title: true, description: true, image: true, url: true },
    links: { total: 40, internal: 35, external: 5 },
    images: { total: 10, noAlt: 0 },
    words: 900,
    ...overrides,
  };
}

const ids = (facts: Record<string, unknown>) => deriveIssues(facts).map(i => i.id);

// ─── the copied META_LIMITS must not drift from the app's source of truth ────────

test("the extension's copied META_LIMITS match src/lib/seo/metaLimits.ts exactly", () => {
  assert.deepEqual(META_LIMITS, APP_META_LIMITS);
});

test("metaLength counts Unicode code points after trimming, like the app", () => {
  assert.equal(metaLength("  Ελληνικά  "), 8);
  assert.equal(metaLength(""), 0);
});

// ─── a healthy page ──────────────────────────────────────────────────────────────

test("a healthy page produces no issues", () => {
  assert.deepEqual(deriveIssues(healthyFacts()), []);
  assert.deepEqual(countSeverities([]), { error: 0, warn: 0, info: 0 });
});

// ─── title / description bands — same edges the app's audit rules use ───────────

test("title: missing is an error, empty is never 'short'", () => {
  assert.ok(ids(healthyFacts({ title: "", titleLength: 0 })).includes("title_missing"));
  assert.equal(ids(healthyFacts({ title: "", titleLength: 0 })).includes("title_short"), false);
});

test("title: auditMin is fine, one below flags short, auditMax+1 flags long", () => {
  const L = META_LIMITS.title;
  assert.equal(ids(healthyFacts({ titleLength: L.auditMin })).includes("title_short"), false);
  assert.ok(ids(healthyFacts({ titleLength: L.auditMin - 1 })).includes("title_short"));
  assert.equal(ids(healthyFacts({ titleLength: L.auditMax })).includes("title_long"), false);
  assert.ok(ids(healthyFacts({ titleLength: L.auditMax + 1 })).includes("title_long"));
});

test("description: the same band semantics at 150..165", () => {
  const L = META_LIMITS.description;
  assert.ok(ids(healthyFacts({ description: "", descriptionLength: 0 })).includes("description_missing"));
  assert.ok(ids(healthyFacts({ descriptionLength: L.auditMin - 1 })).includes("description_short"));
  assert.equal(ids(healthyFacts({ descriptionLength: L.auditMin })).includes("description_short"), false);
  assert.ok(ids(healthyFacts({ descriptionLength: L.auditMax + 1 })).includes("description_long"));
});

// ─── structure ───────────────────────────────────────────────────────────────────

test("h1: zero is an error, two is a warning", () => {
  assert.ok(ids(healthyFacts({ h1Count: 0 })).includes("h1_missing"));
  assert.ok(ids(healthyFacts({ h1Count: 2 })).includes("h1_multiple"));
});

test("a broken JSON-LD block is an error even when valid blocks exist", () => {
  const found = ids(healthyFacts({ jsonLdBlocks: 3, jsonLdValid: 2, jsonLdInvalid: 1 }));
  assert.ok(found.includes("jsonld_invalid"));
  assert.equal(found.includes("jsonld_missing"), false);
});

test("noindex in the robots meta is an error", () => {
  assert.ok(ids(healthyFacts({ robots: "noindex,follow", noindex: true })).includes("robots_noindex"));
});

test("canonical/jsonld/og absences are info-level, never errors", () => {
  const found = deriveIssues(healthyFacts({
    canonical: null,
    jsonLdBlocks: 0, jsonLdValid: 0, jsonLdInvalid: 0,
    og: { title: false, description: false, image: false, url: false },
  }));
  assert.deepEqual(countSeverities(found), { error: 0, warn: 0, info: 3 });
  assert.deepEqual(found.map(i => i.id).sort(), ["canonical_missing", "jsonld_missing", "og_missing"]);
});

test("partial Open Graph is a warning, and the missing alt count lands in the detail", () => {
  const found = deriveIssues(healthyFacts({
    og: { title: true, description: false, image: false, url: false },
    images: { total: 12, noAlt: 3 },
  }));
  assert.deepEqual(countSeverities(found), { error: 0, warn: 2, info: 0 });
  const noAlt = found.find(i => i.id === "images_no_alt");
  assert.equal(noAlt?.detail, "3/12");
});
