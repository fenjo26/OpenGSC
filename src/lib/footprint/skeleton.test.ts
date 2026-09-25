// Skeleton tests (N1 brief): the four production titles from the portfolio review, the
// hyphenated-domain entity, year/number folding, noEntity, the short-skeleton cutoff, exact
// grouping across sites vs. within one site, and the Jaccard «similar» clusters.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_SITES_DEFAULT,
  MIN_SKELETON_WORDS,
  SIMILARITY_THRESHOLD,
  fold,
  domainEntity,
  skeletonOf,
  isNoEntity,
  skeletonWordCount,
  groupFootprints,
  similarGroups,
  type FootprintItem,
} from "./skeleton";

// ─── constants (the brief: thresholds live in constants and are covered by tests) ──

test("footprint constants match the brief", () => {
  assert.equal(MIN_SITES_DEFAULT, 2);
  assert.equal(MIN_SKELETON_WORDS, 4);
  assert.equal(SIMILARITY_THRESHOLD, 0.85);
});

// ─── fold ────────────────────────────────────────────────────────────────────────

test("fold strips diacritics and lowercases", () => {
  assert.equal(fold("Démo Gratuite À Gagné"), "demo gratuite a gagne");
});

// ─── domainEntity ─────────────────────────────────────────────────────────────────

test("domainEntity: hyphenated registrable label without the TLD, hyphens to spaces", () => {
  assert.equal(domainEntity("golden-crown-extreme-booster.fr"), "golden crown extreme booster");
  assert.equal(domainEntity("https://www.golden-crown-extreme-booster.fr/demo/"), "golden crown extreme booster");
  assert.equal(domainEntity("sc-domain:casino-lucky.fr"), "casino lucky");
});

test("domainEntity: two-label public suffix keeps the third label as the name", () => {
  assert.equal(domainEntity("https://slots-magic.co.uk/"), "slots magic");
});

// ─── skeletonOf ───────────────────────────────────────────────────────────────────

// The two real footprint templates from the production review: the same construction on four
// sites each, only the slot name swapped. All four must collapse onto ONE skeleton per template.
const DEMO_SITES: Array<[string, string]> = [
  // [entity (site label), title]
  ["golden crown extreme booster", "Golden Crown Extreme Booster Démo Gratuite : Jouer Sans Inscription ni Dépôt"],
  ["sweet bonanza", "Sweet Bonanza Démo Gratuite : Jouer Sans Inscription ni Dépôt"],
  ["book of ra deluxe", "Book of Ra Deluxe Démo Gratuite : Jouer Sans Inscription ni Dépôt"],
  ["big bass amazon", "Big Bass Amazon Démo Gratuite : Jouer Sans Inscription ni Dépôt"],
];

test("skeletonOf: the four production demo titles collapse to one skeleton", () => {
  const skeletons = new Set(DEMO_SITES.map(([entity, title]) => skeletonOf(title, [entity])));
  assert.equal(skeletons.size, 1);
  assert.equal([...skeletons][0], "{x} demo gratuite : jouer sans inscription ni depot");
});

test("skeletonOf: the four production strategy titles collapse to one skeleton", () => {
  const titles = [
    ["golden crown extreme booster", "Stratégie Golden Crown Extreme Booster : Bankroll et Mises — Que Faut-il Faire ?"],
    ["sweet bonanza", "Stratégie Sweet Bonanza : Bankroll et Mises — Que Faut-il Faire ?"],
    ["book of ra deluxe", "Stratégie Book of Ra Deluxe : Bankroll et Mises — Que Faut-il Faire ?"],
    ["big bass amazon", "Stratégie Big Bass Amazon : Bankroll et Mises — Que Faut-il Faire ?"],
  ];
  const skeletons = new Set(titles.map(([entity, title]) => skeletonOf(title, [entity])));
  assert.equal(skeletons.size, 1);
  assert.equal([...skeletons][0], "strategie {x} : bankroll et mises — que faut-il faire ?");
});

test("skeletonOf: longest entity wins, so a brand list does not eat a partial name", () => {
  // «sweet bonanza demo» with entities ["sweet", "sweet bonanza"] must consume the FULL phrase
  // first, otherwise «sweet {x}» leaves a real word inside the placeholder slot.
  assert.equal(skeletonOf("Sweet Bonanza Demo Gratuite", ["sweet", "sweet bonanza"]), "{x} demo gratuite");
});

test("skeletonOf: entity matches on word boundaries only", () => {
  assert.equal(skeletonOf("BonanzaDemo Gratuite", ["bonanza"]), "bonanzademo gratuite");
});

test("skeletonOf: years 2000-2099 fold to {y}, other numbers to {n}", () => {
  assert.equal(skeletonOf("Top 10 Casinos en 2025", []), "top {n} casinos en {y}");
  assert.equal(skeletonOf("Top 10 Casinos 1999 et 3000", []), "top {n} casinos {n} et {n}");
  // A year glued to a word is not a year (and not a plain number run either).
  assert.equal(skeletonOf("Bonus200 Actif", []), "bonus200 actif");
});

test("skeletonOf: diacritics fold before the entity match", () => {
  assert.equal(skeletonOf("Démo Sweet Bonanza Gratuite", ["sweet bonanza"]), "demo {x} gratuite");
});

test("skeletonOf: whitespace collapses (after the entity pass, per the brief's order)", () => {
  assert.equal(skeletonOf("Démo\n\tGratuite :   Jouer", ["golden crown"]), "demo gratuite : jouer");
});

// ─── noEntity ─────────────────────────────────────────────────────────────────────

test("a skeleton without {x} is flagged noEntity and still participates", () => {
  const s = skeletonOf("Démo Gratuite : Jouer Sans Inscription ni Dépôt", ["golden crown"]);
  assert.equal(isNoEntity(s), true);
  assert.ok(s.startsWith("demo gratuite"));
});

// ─── word count and the short-skeleton cutoff ────────────────────────────────────

test("skeletonWordCount counts only tokens that carry content", () => {
  assert.equal(skeletonWordCount("{x} demo gratuite : jouer sans inscription ni depot"), 8);
  assert.equal(skeletonWordCount("{x} review"), 2);
});

test("groupFootprints drops skeletons under MIN_SKELETON_WORDS («{x} review» is not a footprint)", () => {
  const items: FootprintItem[] = [
    mk("{x} review", "site-a", "a"),
    mk("{x} review", "site-b", "b"),
    mk("{x} review", "site-c", "c"),
  ];
  assert.equal(groupFootprints(items).length, 0);
});

// ─── exact grouping ───────────────────────────────────────────────────────────────

function mk(skeleton: string, identity: string, example: string, source: FootprintItem["source"] = "published"): FootprintItem {
  return { skeleton, kind: "title", source, identity, label: identity, example };
}

test("groupFootprints: same skeleton on two sites is a footprint with sites=2", () => {
  const sk = "{x} demo gratuite : jouer sans inscription ni depot";
  const groups = groupFootprints([
    mk(sk, "site-a", "/a.html"),
    mk(sk, "site-a", "/b.html"), // same site twice — a page pair, not a network footprint
    mk(sk, "site-b", "/c.html"),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sites, 2);
  assert.equal(groups[0].pages, 3);
  assert.equal(groups[0].source, "published");
  // One example per identity.
  assert.equal(groups[0].examples.length, 2);
});

test("groupFootprints: the same phrase on ONE site is not a footprint", () => {
  const sk = "{x} demo gratuite : jouer sans inscription ni depot";
  const groups = groupFootprints([
    mk(sk, "site-a", "/a.html"),
    mk(sk, "site-a", "/b.html"),
    mk(sk, "site-a", "/c.html"),
  ]);
  assert.equal(groups.length, 0);
});

test("groupFootprints: one keyword regenerated five times is not a footprint either", () => {
  const sk = "{x} strategie : bankroll et mises";
  const groups = groupFootprints([
    mk(sk, "sweet bonanza", "history:1", "generated"),
    mk(sk, "sweet bonanza", "history:2", "generated"),
    mk(sk, "sweet bonanza", "history:3", "generated"),
  ]);
  assert.equal(groups.length, 0);
});

test("groupFootprints: minSites is honored (3 sites, minSites=3)", () => {
  const sk = "{x} demo gratuite sans depot wager free";
  const items = [mk(sk, "a", "1"), mk(sk, "b", "2"), mk(sk, "c", "3")];
  assert.equal(groupFootprints(items, { minSites: 3 }).length, 1);
  assert.equal(groupFootprints(items, { minSites: 4 }).length, 0);
});

test("groupFootprints: source is both when published and generated meet on one skeleton", () => {
  const sk = "{x} demo gratuite : jouer sans inscription ni depot";
  const groups = groupFootprints([
    mk(sk, "site-a", "/a.html", "published"),
    mk(sk, "sweet bonanza", "history:9", "generated"),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].source, "both");
  assert.equal(groups[0].noEntity, false);
});

test("groupFootprints sorts by sites, then pages", () => {
  const big = "{x} demo gratuite : jouer sans inscription ni depot";
  const small = "{x} tournoi casino en ligne chaque semaine";
  const groups = groupFootprints([
    mk(small, "a", "1"),
    mk(small, "b", "2"),
    mk(big, "a", "1"),
    mk(big, "b", "2"),
    mk(big, "c", "3"),
  ]);
  assert.deepEqual(groups.map(g => g.sites), [3, 2]);
});

// ─── similar (Jaccard) ────────────────────────────────────────────────────────────

test("similarGroups: near-duplicate skeletons cluster above the threshold", () => {
  const a = "{x} casino en ligne avec bonus sans depot";         // 7 content words
  const b = "{x} casino en ligne avec bonus sans depot immediat"; // superset → J = 7/8 = 0.875
  const far = "{x} machine a sous gratuite 7 reels";
  const groups = similarGroups([
    mk(a, "site-a", "1"),
    mk(b, "site-b", "2"),
    mk(far, "site-c", "3"),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].skeletons, [a, b]);
  assert.equal(groups[0].sites, 2);
});

test("similarGroups: {x} is not a similarity word — different entities still match", () => {
  // Same construction, different placeholder content: the {x} token is excluded from the
  // Jaccard set precisely so these two compare as words-only.
  const a = "{x} casino en ligne avec bonus sans depot";
  const b = "{x} casino en ligne avec bonus sans depot immediat";
  const groups = similarGroups([mk(a, "a", "1"), mk(b, "b", "2")]);
  assert.equal(groups.length, 1);
});

test("similarGroups: identical skeletons do not need the similar section (exact report's job)", () => {
  const sk = "{x} casino en ligne avec bonus sans depot";
  // Two items with the SAME skeleton: one cluster entry, not a «similar» pair.
  const groups = similarGroups([mk(sk, "a", "1"), mk(sk, "b", "2")]);
  assert.equal(groups.length, 0); // one distinct skeleton = no pair to cluster
});

test("similarGroups: short skeletons stay out", () => {
  const groups = similarGroups([
    mk("{x} casino en ligne", "a", "1"),
    mk("{x} casino en ligne bonus", "b", "2"),
  ]);
  assert.equal(groups.length, 0);
});
