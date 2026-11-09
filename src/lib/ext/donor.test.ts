import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Plain JS by design (see audit.test.ts for the why): the extension ships without a build
// step, so donor.js is a classic script with a module.exports footer. The DOM half
// (collect) is verified by hand; deriveSignals/verdict are pure and covered here.
import ExtDonor from "../../../extension/lib/donor.js";

const { MARKERS, deriveSignals, verdict } = ExtDonor as {
  MARKERS: string[];
  deriveSignals: (facts: Record<string, unknown>) => { id: string; severity: string; evidence: string }[];
  verdict: (signals?: { severity: string }[] | null, scanOk?: boolean) => string;
};

// ─── the marker copy must not drift from src/lib/pbn/clean.ts ─────────────────────

test("every marker of pbn/clean.ts residualFootprints is in ExtDonor.MARKERS", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/pbn/clean.ts"), "utf8");
  const listMatch = src.match(/for \(const m of \[([^\]]*)\]\)/);
  assert.ok(listMatch, "the marker array literal in clean.ts was not found");
  const cleanMarkers = [...listMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.ok(cleanMarkers.length >= 6, `expected the 6 WayForge markers, got ${cleanMarkers.length}`);
  for (const m of cleanMarkers) {
    assert.ok(MARKERS.includes(m), `marker "${m}" from clean.ts is missing in ExtDonor.MARKERS`);
  }
});

test("the Wayback leftovers are part of MARKERS", () => {
  for (const m of ["wm-ipp", "__wm", "wombat", "archive.org/static/"]) {
    assert.ok(MARKERS.includes(m));
  }
});

// ─── fixtures ─────────────────────────────────────────────────────────────────────

function factsOf(overrides: Record<string, unknown> = {}) {
  return {
    host: "article.example",
    outbound: [
      { href: "https://a.example/x", host: "a.example", text: "study", rel: [], area: "content", index: 0 },
      { href: "https://b.example/y", host: "b.example", text: "source", rel: ["nofollow"], area: "content", index: 1 },
    ],
    markers: [],
    archiveRefs: 0,
    generator: "WordPress 6.5",
    firstTextBlockIndex: 3,
    ...overrides,
  };
}

const sigIds = (facts: Record<string, unknown>) => deriveSignals(facts).map(s => s.id);
const sigOf = (facts: Record<string, unknown>, id: string) => deriveSignals(facts).find(s => s.id === id);

// ─── signals ──────────────────────────────────────────────────────────────────────

test("a WayForge-restored page fires the hard wayforge marker", () => {
  const facts = factsOf({ markers: [{ id: "data-wf-reconstructed", count: 4, sample: "<div data-wf-reconstructed…" }] });
  const s = sigOf(facts, "wayforge_marker");
  assert.equal(s?.severity, "hard");
  assert.equal(s?.evidence, "data-wf-reconstructed ×4");
  assert.equal(verdict(deriveSignals(facts)), "restored_drop");
});

test("a Wayback toolbar copy fires the hard wayback signal", () => {
  const facts = factsOf({
    markers: [{ id: "wm-ipp", count: 1, sample: "<div id=wm-ipp…" }, { id: "__wm", count: 3, sample: "<script…" }],
    archiveRefs: 2,
  });
  assert.equal(verdict(deriveSignals(facts)), "restored_drop");
});

test("archive_refs: 4 → soft, 5 → hard", () => {
  assert.equal(sigOf(factsOf({ archiveRefs: 4 }), "archive_refs")?.severity, "soft");
  assert.equal(sigOf(factsOf({ archiveRefs: 5 }), "archive_refs")?.severity, "hard");
  assert.equal(sigOf(factsOf({ archiveRefs: 0 }), "archive_refs"), undefined);
});

test("a normal article with two in-text links fires nothing and reads clean", () => {
  const facts = factsOf();
  assert.deepEqual(deriveSignals(facts), []);
  assert.equal(verdict(deriveSignals(facts), true), "clean");
});

test("a link above all content fires link_above_content", () => {
  const facts = factsOf({
    outbound: [{ href: "https://casino.example/", host: "casino.example", text: "best casino", rel: [], area: "top", index: 0 }],
  });
  const s = sigOf(facts, "link_above_content");
  assert.equal(s?.severity, "soft");
  assert.equal(verdict(deriveSignals(facts), true), "clean"); // one soft alone is not suspicious
});

test("two soft signals → suspicious", () => {
  const facts = factsOf({
    outbound: [
      { href: "https://casino.example/", host: "casino.example", text: "casino", rel: [], area: "top", index: 0 },
      { href: "https://a.example/", host: "a.example", text: "a", rel: [], area: "footer", index: 1 },
      { href: "https://b.example/", host: "b.example", text: "b", rel: [], area: "footer", index: 2 },
      { href: "https://c.example/", host: "c.example", text: "c", rel: [], area: "footer", index: 3 },
    ],
    archiveRefs: 1,
  });
  const ids = sigIds(facts);
  assert.ok(ids.includes("sitewide_footer_links"));
  assert.ok(ids.includes("link_above_content"));
  assert.equal(verdict(deriveSignals(facts), true), "suspicious");
});

test("25+ distinct outbound hosts in the text fire many_outbound_hosts", () => {
  const outbound = Array.from({ length: 26 }, (_, i) => ({
    href: `https://h${i}.example/`, host: `h${i}.example`, text: `l${i}`, rel: [], area: "content", index: i,
  }));
  assert.ok(sigIds(factsOf({ outbound })).includes("many_outbound_hosts"));
});

test("a restore-tool generator is a hard signal", () => {
  for (const gen of ["Archivarix", "Generated by Wayback Machine Downloader", "waybackpack 1.2"]) {
    const facts = factsOf({ generator: gen });
    assert.equal(sigOf(facts, "generator_restore_tool")?.severity, "hard", gen);
    assert.equal(verdict(deriveSignals(facts)), "restored_drop", gen);
  }
  // a normal generator is not
  assert.equal(sigOf(factsOf({ generator: "WordPress 6.5" }), "generator_restore_tool"), undefined);
});

// ─── verdict edges ────────────────────────────────────────────────────────────────

test("verdict: failed scan reads unknown even with no signals; empty input is honest", () => {
  assert.equal(verdict([], false), "unknown");
  assert.equal(verdict([], true), "clean");
  assert.equal(verdict(undefined, false), "unknown");
});
