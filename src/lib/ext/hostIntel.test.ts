import assert from "node:assert/strict";
import test from "node:test";
import { normaliseHosts, pickDr, rankProjects, weightedPosition, sameApex } from "./hostIntelPure";

// ─── normaliseHosts ───────────────────────────────────────────────────────────────

test("normaliseHosts: urls, bare hosts, case and www all collapse to the same host", () => {
  assert.deepEqual(
    normaliseHosts(["https://Example.com/x", "example.com", "www.EXAMPLE.com", "https://www.example.com"], 100),
    ["example.com"],
  );
  assert.equal(normaliseHosts(["https://other.gr/path?q=1"], 100)[0], "other.gr");
});

test("normaliseHosts: junk is dropped, order kept, cap respected", () => {
  assert.deepEqual(normaliseHosts(["", "not a host", "   "], 100), []);
  assert.deepEqual(
    normaliseHosts(["b.gr", "a.gr", "b.gr"], 100),
    ["b.gr", "a.gr"],
  );
  assert.deepEqual(
    normaliseHosts(["h1.io", "h2.io", "h3.io", "h4.io"], 3).length,
    3,
  );
});

// ─── pickDr ───────────────────────────────────────────────────────────────────────

test("pickDr: the freshest non-null wins regardless of source order", () => {
  const out = pickDr({
    serpmon: { dr: 10, at: new Date("2026-01-01") },
    metric: { dr: 20, at: new Date("2026-06-01") },
    drCache: { dr: 30, at: new Date("2026-03-01") },
  });
  assert.equal(out.dr, 20);
  assert.equal(out.source, "metric_cache");
});

test("pickDr: null drs are skipped; all-null → null with no source", () => {
  assert.deepEqual(
    pickDr({ serpmon: { dr: null, at: new Date() }, metric: { dr: 5, at: null } }),
    { dr: 5, source: "metric_cache", at: null },
  );
  assert.deepEqual(pickDr({}), { dr: null, source: null, at: null });
});

test("pickDr: a freshness tie resolves serpmon > metric > dr_cache", () => {
  const at = new Date("2026-05-05");
  assert.equal(pickDr({ serpmon: { dr: 1, at }, metric: { dr: 2, at }, drCache: { dr: 3, at } }).source, "serpmon");
  assert.equal(pickDr({ metric: { dr: 2, at }, drCache: { dr: 3, at } }).source, "metric_cache");
});

// ─── rankProjects ─────────────────────────────────────────────────────────────────

test("rankProjects: matching country/lang first, then by keywords", () => {
  const rows = [
    { id: "big", country: "us", lang: "en", keywords: 50 },
    { id: "matching-small", country: "gr", lang: "el", keywords: 2 },
    { id: "matching-big", country: "gr", lang: "el", keywords: 9 },
  ];
  assert.deepEqual(
    rankProjects(rows, "gr", "el", 3).map(r => r.id),
    ["matching-big", "matching-small", "big"],
  );
});

test("rankProjects: unknown country/lang matches everything, ranked by keywords; capped", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, country: "de", lang: "de", keywords: i }));
  assert.deepEqual(
    rankProjects(rows, "", "", 3).map(r => r.id),
    ["p5", "p4", "p3"],
  );
});

// ─── weightedPosition ─────────────────────────────────────────────────────────────

test("weightedPosition: impression-weighted average, 1 decimal; no impressions → null", () => {
  assert.equal(weightedPosition([{ impressions: 3, position: 4 }, { impressions: 1, position: 8 }]), 5);
  assert.equal(weightedPosition([{ impressions: 1, position: 4.25 }]), 4.3);
  assert.equal(weightedPosition([{ impressions: 0, position: 4 }]), null);
  assert.equal(weightedPosition([]), null);
});

// ─── sameApex ─────────────────────────────────────────────────────────────────────

test("sameApex: apex equality, www/subdomains count, two-label suffixes included", () => {
  assert.ok(sameApex("www.example.co.uk", "shop.example.co.uk"));
  assert.ok(!sameApex("example.co.uk", "other.co.uk"));
  assert.ok(!sameApex("example.gr", "example.com"));
  assert.ok(!sameApex("", "example.com"));
});
