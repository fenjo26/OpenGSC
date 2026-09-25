import assert from "node:assert/strict";
import test from "node:test";
import { META_LIMITS, metaLength } from "./metaLimits";
import { fitMetaLocal, readMetaBlock, writeMetaBlock, normalizeMetaValue } from "./metaFit";

// The two T0 invariants must survive every rewrite of this file (docs/tasks/wave-oct/T0-foundation.md §2).
test("the target band sits wholly inside the audit band", () => {
  for (const field of ["title", "description"] as const) {
    const { targetMin, targetMax, auditMin, auditMax } = META_LIMITS[field];
    assert.ok(auditMin <= targetMin, `${field}: auditMin ≤ targetMin`);
    assert.ok(targetMin <= targetMax, `${field}: targetMin ≤ targetMax`);
    assert.ok(targetMax <= auditMax, `${field}: targetMax ≤ auditMax`);
  }
});

test("metaLength counts Unicode code points after trimming", () => {
  assert.equal(metaLength("Ελληνικά"), 8);
});

// ─── golden titles from the production audit export (docs/tasks/wave-oct/T1-meta-fit.md) ────

test("80-char strategy title trims at the em dash into the band (80 → 58, trimmed)", () => {
  const r = fitMetaLocal("title",
    "Stratégie Golden Crown Extreme Booster : Bankroll et Mises — Que Faut-il Faire ?",
    [], "stratégie golden crown extreme booster");
  assert.equal(r.method, "trimmed");
  assert.equal(r.after, "Stratégie Golden Crown Extreme Booster : Bankroll et Mises");
  assert.equal(r.length, 58);
  assert.equal(r.inBand, true);
  assert.equal(r.auditOk, true);
});

test("76-char demo title: the only cut lands at 42, below the band → unfixable, value untouched", () => {
  const v = "Golden Crown Extreme Booster Démo Gratuite : Jouer Sans Inscription ni Dépôt";
  assert.equal(metaLength(v), 76);
  const r = fitMetaLocal("title", v, [], "golden crown extreme booster");
  assert.equal(r.method, "unfixable");
  // never an out-of-band trim: the value is left exactly as it came
  assert.equal(r.after, v);
  assert.equal(r.inBand, false);
});

test("69-char helios title: cuts give 62 then 49, both outside the band → unfixable", () => {
  const v = "Helios Triple Sun Slot : Avis Pragmatic Play 2026, RTP 96,46 % & Démo";
  assert.equal(metaLength(v), 69);
  const r = fitMetaLocal("title", v, [], "helios triple sun");
  assert.equal(r.method, "unfixable");
  assert.equal(r.after, v);
});

test("picks the second option when the first is out of band (70 → 55, picked)", () => {
  const long = "A".repeat(70);
  const good = "B".repeat(55);
  const r = fitMetaLocal("title", long, [long, good], "b");
  assert.equal(r.method, "picked");
  assert.equal(r.after, good);
  assert.equal(r.length, 55);
});

test("picked prefers the in-band option where the keyword sits earliest", () => {
  const far = `${"P".repeat(20)} Xyz Review — ${"A".repeat(20)}`; // keyword at char 22, in band
  const near = `Xyz Review: ${"B".repeat(40)}`;                // keyword at char 0, in band
  const r = fitMetaLocal("title", "X".repeat(70), [far, near], "xyz review");
  assert.equal(r.method, "picked");
  assert.equal(r.after, near);
});

test("a title whose every cut loses the keyword → unfixable, never a keyword-less trim", () => {
  // The keyword lives entirely in the tail after the only separator, while the head alone
  // would be in band — the cut must be refused, not shipped keyword-less.
  const v = `${"A".repeat(55)} — helios triple sun review`;
  const r = fitMetaLocal("title", v, [], "helios triple sun review");
  assert.equal(r.method, "unfixable");
  assert.equal(r.after, v);
});

// ─── descriptions ─────────────────────────────────────────────────────────────────

test("181-char description is cut at a sentence boundary, ends with a period, lands in band", () => {
  const s1 = "Golden Crown Extreme Booster est une machine à sous de Pragmatic Play avec un RTP de 96,46 % et une volatilité élevée et des tours gratuits sans dépôt.";
  const tail = " Guide complet du site entier.";
  const v = s1 + tail;
  assert.equal(metaLength(v), 181, "golden precondition: exactly 181 code points");
  const r = fitMetaLocal("description", v, [], "golden crown extreme booster");
  assert.equal(r.method, "trimmed");
  assert.equal(r.inBand, true);
  assert.ok(r.length >= META_LIMITS.description.targetMin && r.length <= META_LIMITS.description.targetMax);
  assert.ok(/[.!?]$/.test(r.after), "must end with a sentence terminator");
  assert.ok(r.after.startsWith("Golden Crown"), "cuts happen at the END");
});

test("128-char description is too short → unfixable, never padded", () => {
  const v = "Golden Crown Extreme Booster : machine à sous avec un RTP de 96,46 %. Testez la démo gratuite sans inscription ni dépôt initial.";
  assert.equal(metaLength(v), 128, "golden precondition: exactly 128 code points");
  const r = fitMetaLocal("description", v, [], "golden crown");
  assert.equal(r.method, "unfixable");
  assert.equal(r.after, v);
});

// ─── tail hygiene ─────────────────────────────────────────────────────────────────

test("a cut never leaves a dangling separator or stop-word at the end (ru/fr)", () => {
  const ru = "Обзор Golden Crown Extreme Booster полная стратегия и — большие выигрыши каждый день";
  const rRu = fitMetaLocal("title", ru, [], "golden crown extreme booster");
  assert.equal(rRu.method, "trimmed");
  assert.ok(!/[\s:|&,–—-]$/.test(rRu.after), "no trailing separator");
  assert.ok(!/\s(для|и|в|на|с|у|к|о)$/iu.test(rRu.after), "no trailing ru stop-word");
  assert.equal(rRu.inBand, true);

  const fr = "Guide complet du Golden Crown Extreme Booster machine pour — jouer sans inscription";
  const rFr = fitMetaLocal("title", fr, [], "golden crown extreme booster");
  assert.equal(rFr.method, "trimmed");
  assert.ok(!/[\s:|&,–—-]$/.test(rFr.after));
  assert.ok(!/\s(de|à|et|pour|ni|le|la|les|du|au)$/iu.test(rFr.after), "no trailing fr stop-word");
  assert.equal(rFr.inBand, true);
});

// ─── normalization ────────────────────────────────────────────────────────────────

test("normalization strips markdown, collapses spaces, decodes entities, drops quotes", () => {
  assert.equal(normalizeMetaValue("  **Title**  with   spaces "), "Title with spaces");
  assert.equal(normalizeMetaValue("&eacute;clair &#233;"), "éclair é");
  assert.equal(normalizeMetaValue("«Titre»"), "Titre");
  assert.equal(normalizeMetaValue("`code`"), "code");
});

test("a value that normalization alone brings into the band is kept", () => {
  const withMd = `**${"C".repeat(50)}**`; // 54 raw chars, 50 after stripping → in band
  const r = fitMetaLocal("title", withMd, [], "c");
  assert.equal(r.method, "kept");
  assert.equal(r.length, 50);
});

// ─── brand drop ───────────────────────────────────────────────────────────────────

test("the brand segment drops first when it is what makes the title too long", () => {
  const body = "B".repeat(52);
  const v = `${body} | Mon Casino`;
  const r = fitMetaLocal("title", v, [], "b", "Mon Casino");
  assert.equal(r.method, "trimmed");
  assert.equal(r.after, body);
  assert.equal(r.inBand, true);
});

// ─── Cyrillic / Greek: code-point safety ─────────────────────────────────────────

test("Cyrillic and Greek lengths are code points and cuts never split a word", () => {
  const ru = "Обзор Golden Crown Extreme Booster игровые автоматы — как выиграть в 2026 году";
  const rRu = fitMetaLocal("title", ru, [], "golden crown extreme booster");
  assert.equal(rRu.method, "trimmed");
  assert.equal(Array.from(rRu.after).length, rRu.length); // length counted in code points
  for (const ch of rRu.after) assert.ok(ru.includes(ch), `torn character: ${ch}`);
  assert.ok(rRu.after.endsWith("игровые автоматы"));

  const el = "Στρατηγική Golden Crown Extreme Booster και τα βασικά — πώς να κερδίσετε";
  const rEl = fitMetaLocal("title", el, [], "golden crown extreme booster");
  assert.equal(rEl.method, "trimmed");
  assert.equal(Array.from(rEl.after).length, rEl.length);
  for (const ch of rEl.after) assert.ok(el.includes(ch), `torn character: ${ch}`);
});

// ─── meta block roundtrip ────────────────────────────────────────────────────────

test("readMetaBlock parses fenced and unfenced blocks; writeMetaBlock is idempotent", () => {
  const fenced = "```\nTitle: Old Title Value\nMeta Description: Old description value\nURL Slug: old-slug\n```\n\n# Heading\n\nBody.";
  const b = readMetaBlock(fenced);
  assert.ok(b);
  assert.equal(b.title, "Old Title Value");
  assert.equal(b.description, "Old description value");
  assert.equal(b.slug, "old-slug");

  const unfenced = "Title: T\nMeta Description: D\nURL Slug: s\n\n# H";
  const b2 = readMetaBlock(unfenced);
  assert.ok(b2);
  assert.equal(b2.title, "T");
  assert.equal(b2.description, "D");

  // no block → null; text without a block is returned unchanged
  assert.equal(readMetaBlock("# Just an article\n\nText"), null);
  const plain = "# Just an article\n\nText";
  assert.equal(writeMetaBlock(plain, { title: "X" }), plain);

  const once = writeMetaBlock(fenced, { title: "New Title", description: "New description" });
  const b3 = readMetaBlock(once);
  assert.ok(b3);
  assert.equal(b3.title, "New Title");
  assert.equal(b3.description, "New description");
  assert.equal(b3.slug, "old-slug");          // slug survives untouched
  assert.ok(once.includes("# Heading"));      // the article body survives
  assert.ok(once.startsWith("```"));          // fence style preserved
  const twice = writeMetaBlock(once, { title: "New Title", description: "New description" });
  assert.equal(twice, once);                  // idempotent

  // unfenced stays unfenced after a write
  const once2 = writeMetaBlock(unfenced, { title: "T2" });
  assert.ok(!once2.startsWith("```"));
  assert.equal(readMetaBlock(once2)?.title, "T2");

  // case-insensitive labels, as the model may emit them
  const weird = "title: lower\nmeta  description:  spaced value\nurl slug: sl\n\n# H";
  const b4 = readMetaBlock(weird);
  assert.ok(b4);
  assert.equal(b4.title, "lower");
  assert.equal(b4.description, "spaced value");
});

// ─── fitMeta (no network: allow:false never repairs and never force-cuts) ────────

test("fitMeta without llm.allow keeps unfixable values untouched and reports zero calls", async () => {
  const { fitMeta } = await import("./metaFit");
  const v = "Golden Crown Extreme Booster Démo Gratuite : Jouer Sans Inscription ni Dépôt";
  const r = await fitMeta(
    { keyword: "golden crown extreme booster", language: "fr", title: v },
    { allow: false },
  );
  assert.equal(r.llmCalls, 0);
  assert.equal(r.title?.method, "unfixable");
  assert.equal(r.title?.after, v); // no forced cut on the free path
});

// ── keyword guard is per-WORD, not per-phrase (review fix: word order must not force an LLM call) ──

test("a keyword in a different word order than the title still trims for free", () => {
  // Same 80-char golden title, but the query arrived as "golden crown extreme booster
  // stratégie" — not a substring of the title in this order. The free trim must still work:
  // every keyword WORD survives the cut, only the order differs.
  const r = fitMetaLocal("title",
    "Stratégie Golden Crown Extreme Booster : Bankroll et Mises — Que Faut-il Faire ?",
    [], "golden crown extreme booster stratégie");
  assert.equal(r.method, "trimmed");
  assert.equal(r.after, "Stratégie Golden Crown Extreme Booster : Bankroll et Mises");
  assert.equal(r.length, 58);
});

test("a cut that would drop a keyword WORD is still refused", () => {
  // 64-char title, over the 60 target: the " — Review" cut lands at 55, inside the band —
  // but "review" is a word of the keyword, so the guard refuses and the value stays as is.
  const v = "Golden Crown Extreme Booster Deluxe : Bankroll et Mises — Review";
  const r = fitMetaLocal("title", v, [], "golden crown review");
  assert.equal(r.method, "unfixable");
  assert.equal(r.after, v);
  // Control: same title, keyword without "review" — the identical cut is fine, proving the
  // refusal above was the keyword guard and not the band.
  const ok = fitMetaLocal("title", v, [], "golden crown bankroll");
  assert.equal(ok.method, "trimmed");
  assert.equal(ok.length, 55);
});

test("keyword words that were never in the title do not block the free trim", () => {
  // The same 80-char golden title; the query carries a word the French title never had —
  // "slot", or an English "strategy". The trim cannot be blamed for a word the model never
  // wrote; requiring it just forced a paid LLM repair for a deterministic cut.
  const v = "Stratégie Golden Crown Extreme Booster : Bankroll et Mises — Que Faut-il Faire ?";
  for (const kw of ["golden crown extreme booster slot", "golden crown extreme booster strategy"]) {
    const r = fitMetaLocal("title", v, [], kw);
    assert.equal(r.method, "trimmed", kw);
    assert.equal(r.after, "Stratégie Golden Crown Extreme Booster : Bankroll et Mises");
    assert.equal(r.length, 58);
  }
});
