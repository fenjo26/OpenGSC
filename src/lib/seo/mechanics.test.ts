import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMixedScript, checkMechanics, placeholdersFromInstruction,
  linksFromInstruction, brandsFromDomains, repairableIssues,
} from "./mechanics";

// The defect that started this: a Greek word typed half in Cyrillic. Both look identical on
// screen, so nothing downstream — model, judge or human proofreader — can catch it by reading.
test("normalizes a Cyrillic/Greek hybrid word to the majority script", () => {
  const r = normalizeMixedScript("Ask for the апо́δειξη (receipt).", "en");
  assert.equal(r.text.includes("απόδειξη"), true, r.text);
  assert.equal(r.fixed.length, 1);
  assert.equal(r.unfixed.length, 0);
});

test("normalizes a Cyrillic letter hiding inside a Latin word", () => {
  // "price" with a Cyrillic "\u0441" standing in for the Latin "c" — one of the pairs that are
  // pixel-identical in every common font, so no amount of proofreading finds it.
  const r = normalizeMixedScript("The pri\u0441e is fixed.", "en");
  assert.equal(r.text, "The price is fixed.");
  assert.equal(r.fixed.length, 1);
});

test("leaves clean single-script text and legitimate quoted foreign words alone", () => {
  const clean = "Metro tickets cost €9 and the bus is €5.50. Αθήνα is the capital.";
  const r = normalizeMixedScript(clean, "en");
  assert.equal(r.text, clean);
  assert.equal(r.fixed.length, 0);
});

test("refuses to half-convert a word it cannot map, and reports it instead", () => {
  // Cyrillic "ж" has no Latin homoglyph — the word must survive untouched.
  const r = normalizeMixedScript("moжel", "en");
  assert.equal(r.text, "moжel");
  assert.equal(r.fixed.length, 0);
  assert.equal(r.unfixed.length, 1);
});

test("derives placeholders and internal links from the author's instruction", () => {
  const instruction = "Keep [[TRANSFER_WIDGET]] where the form goes. Link to /where-to-stay/athens/ and /day-trips/ once each. Do not link out to https://example.com/x/.";
  assert.deepEqual(placeholdersFromInstruction(instruction), ["[[TRANSFER_WIDGET]]"]);
  const links = linksFromInstruction(instruction);
  assert.equal(links.includes("/where-to-stay/athens/"), true);
  assert.equal(links.includes("/day-trips/"), true);
  // An absolute URL's path must not be mistaken for a site-internal one.
  assert.equal(links.some(l => l.includes("example")), false);
});

test("derives competitor names from the domains the article was grounded on", () => {
  const brands = brandsFromDomains([
    "https://welcomepickups.com/athens/", "www.suntransfers.com", "https://en.wikipedia.org/wiki/Athens",
    "holiday-extras.com",
  ]);
  assert.equal(brands.includes("welcomepickups"), true);
  assert.equal(brands.includes("suntransfers"), true);
  assert.equal(brands.includes("holiday extras"), true);
  // Generic hosts must not become "brands" — otherwise the check fires on ordinary words.
  assert.equal(brands.includes("wikipedia"), false);
});

test("flags a named competitor in prose but not one that only appears as a link target", () => {
  const md = "## Costs\n\nA private transfer with Welcome Pickups starts at €58.\n\nSee [the page](https://suntransfers.com/athens).";
  const { issues } = checkMechanics(md, { language: "en", forbiddenBrands: ["welcomepickups", "suntransfers"] });
  const brand = issues.find(i => i.code === "forbidden_brand");
  assert.ok(brand, "expected a forbidden_brand issue");
  assert.deepEqual(brand!.samples, ["welcomepickups"]);
});

test("flags a dropped placeholder and a missing internal link", () => {
  const md = "## Book\n\nUse the booking form below.\n\n[Where to stay](/where-to-stay/athens/)";
  const { issues } = checkMechanics(md, {
    language: "en",
    placeholders: ["[[TRANSFER_WIDGET]]"],
    requiredLinks: ["/where-to-stay/athens/", "/day-trips/"],
  });
  assert.equal(issues.some(i => i.code === "missing_placeholder"), true);
  const link = issues.find(i => i.code === "missing_link");
  assert.deepEqual(link!.samples, ["/day-trips/"]);
});

test("flags a non-eurozone price on a Greek page and never converts it", () => {
  const md = "Tipping runs $8–12 per trip, while the metro is €9.";
  const { text, issues } = checkMechanics(md, { language: "en", country: "gr" });
  assert.equal(text, md, "currency must never be rewritten");
  const cur = issues.find(i => i.code === "foreign_currency");
  assert.ok(cur);
  assert.equal(cur!.fixed, false);
});

test("a clean article on a matching market produces no issues at all", () => {
  const md = "# Athens Airport to the City Centre\n\n## Metro\n\nThe metro costs €9 and takes 40 minutes.\n\n[[TRANSFER_WIDGET]]\n\n[Where to stay](/where-to-stay/athens/)";
  const { issues } = checkMechanics(md, {
    language: "en", country: "gr",
    placeholders: ["[[TRANSFER_WIDGET]]"], requiredLinks: ["/where-to-stay/athens/"],
    forbiddenBrands: ["suntransfers"],
  });
  assert.deepEqual(issues, []);
});

test("only the defects a scoped model pass can fix are offered for repair", () => {
  const { issues } = checkMechanics("The pрiсe is $12 in Athens.", { language: "en", country: "gr" });
  const codes = repairableIssues(issues).map(i => i.code);
  // mixed_script is already fixed in place, so it must not be sent to the model again.
  assert.equal(codes.includes("mixed_script" as never), false);
  assert.equal(codes.includes("foreign_currency"), true);
});
