import assert from "node:assert/strict";
import test from "node:test";
import { shingleCoverage, aggregateMatches, isOwnHost, hostOfUrl, MATCH_THRESHOLD } from "./match";

const FRAGMENT = "Blackjack dealers must draw cards until the hand reaches seventeen points at most tables";

test("shingleCoverage: identical snippet covers 100 %", () => {
  assert.equal(shingleCoverage(FRAGMENT, FRAGMENT + " — Casino Guide"), 1);
});

test("shingleCoverage: an exact run of most of the fragment scores high", () => {
  const snippet = `… ${FRAGMENT.split(" ").slice(0, 11).join(" ")} …`;
  // 11 of 14 words as one consecutive run → 0.79, above the 0.70 threshold.
  assert.ok(shingleCoverage(FRAGMENT, snippet) >= MATCH_THRESHOLD);
  assert.ok(shingleCoverage(FRAGMENT, snippet) < 1, "the tail words are genuinely missing");
});

test("shingleCoverage: scattered keywords are NOT a run (shingles must be consecutive)", () => {
  const scattered = "dealers until seventeen points cards hand draw reaches tables most the must blackjack at";
  assert.ok(shingleCoverage(FRAGMENT, scattered) < MATCH_THRESHOLD);
});

test("shingleCoverage: unrelated text scores zero", () => {
  assert.equal(shingleCoverage(FRAGMENT, "Roulette wheels spin in the opposite direction across the atlantic"), 0);
});

test("shingleCoverage is case- and punctuation-insensitive", () => {
  const noisy = FRAGMENT.toUpperCase().replace(/ /g, ", ") + "!";
  assert.equal(shingleCoverage(FRAGMENT, noisy), 1);
});

const HIT = (url: string, snippet: string, title = "Copied page") => ({ url, title, snippet });

test("aggregateMatches: a snippet copy is reported as a source and counted in the share", () => {
  const report = aggregateMatches([
    { index: 0, fragment: FRAGMENT, hits: [HIT("https://thief.example.com/a", FRAGMENT)] },
    { index: 1, fragment: "Roulette tables offer novel betting layouts for players who prefer slower games", hits: [] },
  ]);
  assert.equal(report.matchedFragments, 1);
  assert.equal(report.sampledFragments, 2);
  assert.equal(report.matchedPct, 50);
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources[0].url, "https://thief.example.com/a");
  assert.equal(report.sources[0].fragments, 1);
  assert.equal(report.sources[0].ownSite, false);
});

test("aggregateMatches: the own site is reported but never counted as plagiarism", () => {
  const report = aggregateMatches(
    [
      { index: 0, fragment: FRAGMENT, hits: [HIT("https://mysite.example.com/page", FRAGMENT)] },
      { index: 1, fragment: "Roulette tables offer novel betting layouts for players who prefer slower games", hits: [] },
    ],
    "mysite.example.com",
  );
  assert.equal(report.matchedFragments, 0);
  assert.equal(report.matchedPct, 0);
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources[0].ownSite, true);
});

test("aggregateMatches: own site includes subdomains", () => {
  assert.ok(isOwnHost(hostOfUrl("https://blog.mysite.example.com/x"), "mysite.example.com"));
  assert.ok(!isOwnHost(hostOfUrl("https://mysite-example.com/x"), "mysite.example.com"));
});

test("aggregateMatches: a URL answering for two fragments matches even when snippets truncate", () => {
  // The snippets overlap the fragments only slightly (below the 70 % threshold) — the same URL
  // answering twice is the signal, exactly the "snippets truncate" case the rule exists for.
  const report = aggregateMatches([
    {
      index: 0,
      fragment: FRAGMENT,
      hits: [HIT("https://thief.example.com/one", "Blackjack dealers must draw … read more")],
    },
    {
      index: 1,
      fragment: "Insurance side bets pay twice the stake when the dealer shows an ace upward",
      hits: [HIT("https://thief.example.com/one", "Insurance side bets pay twice … read more")],
    },
  ]);
  assert.equal(report.matchedFragments, 2);
  assert.equal(report.matchedPct, 100);
  assert.equal(report.sources[0].fragments, 2);
  assert.equal(report.sources[0].url, "https://thief.example.com/one");
  const reasons = report.fragments.flatMap((f) => f.matches.map((m) => m.reason));
  assert.ok(reasons.includes("repeat"));
});

test("aggregateMatches: a single weak hit is not a match", () => {
  const report = aggregateMatches([
    { index: 0, fragment: FRAGMENT, hits: [HIT("https://one.example.com/a", "Blackjack … something else entirely different words here")] },
    { index: 1, fragment: "Insurance side bets pay twice the stake when the dealer shows an ace upward", hits: [] },
  ]);
  assert.equal(report.matchedFragments, 0);
  assert.equal(report.sources.length, 0);
});

test("aggregateMatches: clean text reports zero and stays explicit about it", () => {
  const report = aggregateMatches([
    { index: 0, fragment: FRAGMENT, hits: [] },
    { index: 1, fragment: "Roulette tables offer novel betting layouts for players who prefer slower games", hits: [] },
  ]);
  assert.equal(report.matchedPct, 0);
  assert.equal(report.matchedFragments, 0);
  assert.deepEqual(report.sources, []);
});
