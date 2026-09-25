import assert from "node:assert/strict";
import test from "node:test";
import {
  REPORT_SECTION_IDS, REPORT_TEMPLATES, parseSections, parseTemplate, sectionLabelKey,
} from "./sections";

test("every template section is a known section id", () => {
  for (const [tpl, sections] of Object.entries(REPORT_TEMPLATES)) {
    for (const s of sections) {
      assert.ok((REPORT_SECTION_IDS as readonly string[]).includes(s), `${tpl} references unknown section ${s}`);
    }
  }
});

test("detailed includes everything executive has, plus pages/indexing/backlinks/uptime", () => {
  for (const s of REPORT_TEMPLATES.executive) {
    assert.ok(REPORT_TEMPLATES.detailed.includes(s), `detailed is missing executive's ${s}`);
  }
  for (const s of ["pages", "indexing", "backlinks", "uptime"] as const) {
    assert.ok(REPORT_TEMPLATES.detailed.includes(s));
  }
});

test("technical and local templates carry their promised sections", () => {
  // Core Web Vitals ride inside the audit section (N8 decision), not a section of their own.
  assert.deepEqual(REPORT_TEMPLATES.technical, ["audit", "indexing", "uptime"]);
  // NAP status rides inside local_positions.
  assert.ok(REPORT_TEMPLATES.local.includes("local_positions"));
  assert.ok(REPORT_TEMPLATES.local.includes("reviews"));
});

test("parseSections keeps only known ids and always returns canonical order", () => {
  assert.deepEqual(
    parseSections(["uptime", "not_a_section", "traffic", "summary"]),
    ["summary", "traffic", "uptime"],
  );
  assert.deepEqual(parseSections(null), []);
  assert.deepEqual(parseSections("summary"), []);
  assert.deepEqual(parseSections([]), []);
});

test("parseTemplate falls back to executive for garbage", () => {
  assert.equal(parseTemplate("detailed"), "detailed");
  assert.equal(parseTemplate("executives"), "executive");
  assert.equal(parseTemplate(undefined), "executive");
});

test("section label key matches the UI convention", () => {
  assert.equal(sectionLabelKey("local_positions"), "repSection_local_positions");
});
