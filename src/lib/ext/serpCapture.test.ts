import assert from "node:assert/strict";
import test from "node:test";
import { validateCapture } from "./serpCapture";
import { CAPTURE_FEATURES } from "./types";

// saveCapture is DB-bound (dictionaries, upserts) and exercised through the route by hand;
// validateCapture is pure and covered here, error code by error code.

function bodyOf(overrides: Record<string, unknown> = {}) {
  return {
    query: "  Bizzo   casino ",
    engineHost: "www.google.it",
    country: "it",
    lang: "it",
    device: "desktop",
    page: 1,
    startPos: 1,
    results: [
      { position: 1, url: "https://a.it/x", title: "A", snippet: "sa" },
      { position: 2, url: "https://b.it/y", title: "B", snippet: "sb" },
    ],
    features: ["paa", "made_up_feature"],
    ...overrides,
  };
}

test("validateCapture: a good body passes with a normalised keyword and clean features", () => {
  const out = validateCapture(bodyOf());
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.keyword, "bizzo casino");
  assert.deepEqual(out.value.features, ["paa"]);
  assert.equal(out.value.device, "desktop");
});

test("validateCapture: query and engine codes", () => {
  const bad = validateCapture(bodyOf({ query: "" }));
  assert.equal(bad.ok, false);
  assert.equal((bad as { error: string }).error, "invalid_query");
  assert.equal((validateCapture(bodyOf({ engineHost: "google.it" })) as { error: string }).error, "invalid_engine");
  assert.equal((validateCapture(bodyOf({ engineHost: "www.bing.com" })) as { error: string }).error, "invalid_engine");
});

test("validateCapture: page and startPos bounds", () => {
  assert.equal((validateCapture(bodyOf({ page: 0 })) as { error: string }).error, "invalid_page");
  assert.equal((validateCapture(bodyOf({ page: 11 })) as { error: string }).error, "invalid_page");
  assert.equal((validateCapture(bodyOf({ startPos: 101 })) as { error: string }).error, "invalid_start");
});

test("validateCapture: duplicate URLs keep the first; positions are recalculated from startPos", () => {
  const out = validateCapture(bodyOf({
    startPos: 11,
    results: [
      { position: 1, url: "https://a.it/x", title: "A", snippet: "sa" },
      { position: 2, url: "https://a.it/x", title: "A2", snippet: "sa2" }, // duplicate URL
      { position: 3, url: "https://b.it/y", title: "B", snippet: "sb" },
    ],
  }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.results.length, 2);
  assert.deepEqual(out.value.results.map(r => r.position), [11, 12]);
  assert.equal(out.value.results[0].title, "A");
});

test("validateCapture: invalid and non-http URLs are dropped, not fatal", () => {
  const out = validateCapture(bodyOf({
    results: [
      { position: 1, url: "not a url", title: "junk", snippet: "" },
      { position: 2, url: "ftp://a.it/x", title: "ftp", snippet: "" },
      { position: 3, url: "https://ok.it/", title: "OK", snippet: "" },
    ],
  }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.results.length, 1);
  assert.equal(out.value.results[0].url, "https://ok.it/");
});

test("validateCapture: no surviving results → no_results", () => {
  assert.equal((validateCapture(bodyOf({ results: [] })) as { error: string }).error, "no_results");
  assert.equal((validateCapture(bodyOf({ results: [{ url: "junk", title: "", snippet: "" }] })) as { error: string }).error, "no_results");
});

test("validateCapture: titles and snippets are truncated to the wire caps", () => {
  const out = validateCapture(bodyOf({
    results: [{ position: 1, url: "https://a.it/x", title: "T".repeat(500), snippet: "S".repeat(500) }],
  }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.results[0].title.length, 200);
  assert.equal(out.value.results[0].snippet.length, 300);
});

test("validateCapture: unknown features are dropped; the known set is CAPTURE_FEATURES", () => {
  const out = validateCapture(bodyOf({ features: ["shopping", "nonsense", "sitelinks", "shopping"] }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.value.features, ["shopping", "sitelinks"]);
  assert.deepEqual([...CAPTURE_FEATURES], [
    "ai_overview", "paa", "local_pack", "top_stories", "video", "images", "shopping", "knowledge_panel", "sitelinks",
  ]);
});
