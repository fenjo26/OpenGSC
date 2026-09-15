import { test } from "node:test";
import assert from "node:assert/strict";
import { wireframeToMarkdown } from "./outlineFormat";

test("wireframeToMarkdown renders one numbered section per block with checkable requirements", () => {
  const md = wireframeToMarkdown({
    blocks: [
      { type: "HERO_FORM", heading: "Crazy Time Live", requirements: ["H1 с ключом", "CTA со скроллом к таблице"], source_section: "Ти Είναι το Crazy Time" },
      { type: "FAQ", heading: "Συχνές Ερωτήσεις", requirements: ["≥6 вопросов"] },
      { type: "CTA_BANNER", heading: "" },
    ],
  }, "crazy time");

  assert.match(md, /^# Wireframe: crazy time\n/);
  assert.match(md, /## 1\. HERO_FORM — Crazy Time Live/);
  assert.match(md, /## 2\. FAQ — Συχνές Ερωτήσεις/);
  assert.match(md, /## 3\. CTA_BANNER\n/); // no heading → no em-dash suffix
  assert.equal(md.split("- [ ] ").length - 1, 3);
  assert.match(md, /\*Источник в ТЗ: Ти Είναι το Crazy Time\*/);
  // CTA_BANNER has no requirements — no checkbox group under it
  const afterCta = md.slice(md.indexOf("## 3."));
  assert.equal(afterCta.includes("- [ ]"), false);
});

test("wireframeToMarkdown handles missing requirements/source and empty input", () => {
  assert.equal(wireframeToMarkdown(null), "");
  assert.equal(wireframeToMarkdown({}), "");
  assert.equal(wireframeToMarkdown({ blocks: [] }), "");
  const md = wireframeToMarkdown({ blocks: [{ type: "MAP" }] });
  assert.match(md, /## 1\. MAP\n/);
  assert.equal(md.includes("- [ ]"), false);
});
