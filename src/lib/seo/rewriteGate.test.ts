import assert from "node:assert/strict";
import test from "node:test";
import { contentGate } from "./rewriteGate";
import { stripModelScratch } from "./textMetrics";

// ─── contentGate: the failures that actually shipped as "completed" pages ─────────
// Every fixture below is real output observed on this instance on 2026-08-24 (rewrites)
// and 2026-08-16 (generations). The gate exists to make each of them impossible to save.

const greekSource = Array.from(
  { length: 120 },
  (_, i) => `Η εταιρεία καθαρισμού προσφέρει υπηρεσίες ${i} με τιμές από 35€ έως 70€ ανά επίπλο`,
).join(" ") + " " + Array.from({ length: 40 }, (_, i) => `Τηλέφωνο +30 694 504 8010 παραγγελία ${i}`).join(" ");

// The 85-word "rewrite" of katharismos-tzamion: the model's number-planning notes,
// returned as if they were the article. Uniqueness 100%, shipped as completed.
const scratchNotes = [
  'στούντιο: 25€"',
  '- `45€`: "Διαμέρισμα 2 υπνοδωματίων: 45€"',
  '- `50€`: "Μεζονέτα ή μονοκατοικία: 50€"',
  '- `95€`: "Ολοκληρωμένο πακέτο γενικού καθαρισμού: 95€"',
  '- `4.5`: "ελαφρώς όξινο διάλυμα με pH 4.5"',
  '- `55`: "επαγγελματικά squeegee πλάτους από 35cm έως 55cm (ή 55 εκ.)" -> let\'s have `55`',
  '- `60`: "θερμοκρασία νερού έως 60 βαθμούς" / "διάρκεια 60 ημερών" -> `60`',
  '- `90€`: "Μεγάλη μονοκατοικία με πολλαπλά επίπεδα: 90€"',
  '- `IPC`: "κορυφαίες εταιρείες όπως η IPC και η Pulex" / "εξοπλισμός IPC"',
].join("\n");

// The 94-word stub of viologikos-katharismos-kanape: heading + intro + the page's own
// booking-form confirmation text, cut mid-sentence. Drift "danger", still saved.
const formBoilerplateStub = [
  "# Επαγγελματικός Βιοκαθαρισμός Καναπέ",
  "Ολοκληρωμένος οικολογικός καθαρισμός σε βάθος για καναπέδες.",
  "Ευχαριστούμε θερμά! Σας ευχαριστούμε! Ένας εκπρόσωπός μας θα επικοινωνήσει άμεσα μαζί σας.",
  "WhatsApp Υποβολή νέου αιτήματος ή τηλεφωνήστε στο +30 694 504 8010",
  "## Γιατί είναι αναγκαίος ο εξειδικευμένος βιολογικός καθαρισμός;",
  "Η επιλογή ενός επαγγελματικού βιολογικού καθαρισμού αποτελεί στοχευμένη μέθοδο, κρίσιμη για τη",
].join("\n\n");

// A real article-shaped draft: source-length prose under real headings. Must pass.
const healthyDraft =
  "# Βιολογικός Καθαρισμός Καναπέ\n\n" +
  Array.from({ length: 90 }, (_, i) => `## Ενότητα ${i}\n\n` + Array.from({ length: 25 }, (_, j) => `Η υπηρεσία καθαρισμού ${i}-${j} κοστίζει από 15€ έως 70€ και διαρκεί 30 έως 90 λεπτά με παιδιά και κατοικίδια ασφαλή.`).join(" ")).join("\n\n");

test("the model's planning notes are rejected, not saved", () => {
  const g = contentGate(greekSource, scratchNotes);
  assert.equal(g.ok, false);
  assert.equal(g.reason, "gate_scratch_leaked");
});

test("a short stub that copied booking-form text is rejected as too short", () => {
  const g = contentGate(greekSource, formBoilerplateStub);
  assert.equal(g.ok, false);
  assert.equal(g.reason, "gate_too_short");
});

test("an unterminated code fence is rejected", () => {
  const broken = healthyDraft + "\n\n```\nsome trailing fragment";
  const g = contentGate(greekSource, broken);
  assert.equal(g.ok, false);
  assert.equal(g.reason, "gate_broken_fence");
});

test("a source-length article with real headings passes", () => {
  const g = contentGate(greekSource, healthyDraft);
  assert.equal(g.ok, true);
  assert.equal(g.reason, undefined);
});

// A shorter source still demands a substantive draft, not a 90-word fragment.
test("the absolute floor applies even to short sources", () => {
  const shortSource = Array.from({ length: 60 }, (_, i) => `Ο καναπές καθαρίζεται σε βάθος ${i} με κόστος 25€ ανά θέση`).join(" ");
  const g = contentGate(shortSource, "Μικρό κείμενο χωρίς headings μόλις δέκα λέξεις.");
  assert.equal(g.ok, false);
  assert.equal(g.reason, "gate_too_short");
});

// ─── stripModelScratch: the volume-guard leak inside a completed article ─────────
// Observed 2026-08-16 in "καθαρισμός βίλας αφυτοσ": the writer's own word-count
// self-check, verbatim, between the meta block and the first heading.
test("leaked word-count self-check lines are stripped", () => {
  const leaked = [
    "## Επισκόπηση Υπηρεσιών",
    "",
    "Double check word count:",
    "Section 1: 121 words.",
    "Section 2: 90 words.",
    "Total: 211 words. (201-225 range met perfectly).",
    "",
    "Ο επαγγελματικός καθαρισμός βίλας αποτελεί θεμέλιο.",
  ].join("\n");
  const out = stripModelScratch(leaked);
  assert.ok(!/double[- ]check/i.test(out), "self-check header must be gone");
  assert.ok(!/Section 1: 121 words/i.test(out), "per-section count must be gone");
  assert.ok(!/Total: 211 words/i.test(out), "total count must be gone");
  assert.ok(out.includes("Ο επαγγελματικός καθαρισμός βίλας"), "real prose must survive");
});

test("legitimate prose containing 'total' or 'section' is not stripped", () => {
  const prose = "The total price includes VAT. This section of the report covers windows.\n\nTotal: everything above.";
  assert.equal(stripModelScratch(prose), prose.trim());
});

// ─── stripPageFurniture: the scrape-side fix for the judge/rewriter conflict ──────
// 2026-08-24, skgclean.gr/katharismos-tzamion: a faithful rewrite was rejected twice by
// the judge for "page furniture" — booking-form confirmations and WhatsApp buttons that
// the SCRAPER put in the source and the "preserve structure EXACTLY" instruction copied.
// The strip removes furniture before it can become part of the contract.
import { stripPageFurniture } from "./textMetrics";

test("booking-form confirmation lines are stripped from scraped sources", () => {
  const scraped = [
    "Κλείστε ραντεβού από 50€",
    "Ευχαριστούμε!",
    "Ευχαριστούμε! Θα έρθετε σε επαφή μαζί σας το ταχύτερο δυνατόν.",
    "WhatsApp Νέα αίτηση",
    "## Καθαρισμός Τζαμιών",
    "Επαγγελματικός καθαρισμός τζαμιών με πιστοποιημένο εξοπλισμό.",
  ].join("\n");
  const out = stripPageFurniture(scraped);
  assert.ok(!/Ευχαριστούμε/.test(out), "thank-you confirmations must be gone");
  assert.ok(!/WhatsApp/i.test(out), "contact widget lines must be gone");
  assert.ok(out.includes("Κλείστε ραντεβού"), "a price CTA in the source is kept — not this stripper's call");
  assert.ok(out.includes("## Καθαρισμός Τζαμιών"), "article headings must survive");
});

test("cross-sell arrow links are stripped, prose arrows are not", () => {
  const scraped = "Γενικός καθαρισμός σπιτιού\nαπό 45€ Δείτε την υπηρεσία →\nΟ καθαρισμός γίνεται → σύμφωνα με το πρόγραμμα.";
  const out = stripPageFurniture(scraped);
  assert.ok(!/Δείτε την υπηρεσία/.test(out), "arrow-terminated link line must be gone");
  assert.ok(out.includes("σύμφωνα με το πρόγραμμα"), "an arrow inside prose must survive");
});
