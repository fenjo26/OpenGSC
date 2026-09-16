// Pure tests only: every helper here runs without a database and without a network.
// The live parts of T4 (registry age, DR) are covered by the drops suite this module builds on.
import assert from "node:assert/strict";
import test from "node:test";
import {
  calcAgeMonths, countBounces, csvField, csvLine, domainQueryFromSearchParams,
  domainTags, hostMatchesEntries, slugifyName,
  type BounceChange,
} from "./domains";
import { DEFAULT_PLATFORM_HOSTS, type DomainRow } from "./types";

const NOW = new Date("2026-09-15T12:00:00Z");
const isPlatform = (h: string) => hostMatchesEntries(h, DEFAULT_PLATFORM_HOSTS);

function mkRow(over: Partial<Omit<DomainRow, "tags">>): Omit<DomainRow, "tags"> {
  return {
    hostId: 1, host: "example.com", registrable: "example.com",
    firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-14T00:00:00.000Z",
    registeredAt: "2020-01-15T00:00:00.000Z", ageMonths: 67, ageError: null,
    dr: 31,
    refdomains: null,
    keywords: 10, prevKeywords: 10, top10: 3, top30: 6,
    bestPos: 4, avgPos: 22.5, bounces: 0,
    ...over,
  };
}

const TAG_CTX = {
  now: NOW,
  firstRunAt: new Date("2026-09-01T00:00:00.000Z"),
  ownDomains: ["myshop.com"] as readonly string[],
  isPlatform,
  maxAgeMonths: 6,
};

// ─── hostMatchesEntries (own + platform matching, dot boundary) ────────────────

test("own domains match on the dot boundary only", () => {
  const own = ["myshop.com"];
  assert.equal(hostMatchesEntries("myshop.com", own), true, "exact match");
  assert.equal(hostMatchesEntries("www.myshop.com", own), true, "subdomain of an own domain is own");
  assert.equal(hostMatchesEntries("a.b.myshop.com", own), true, "deep subdomain is own");
  assert.equal(hostMatchesEntries("notmyshop.com", own), false, "prefix without a dot is a different domain");
  assert.equal(hostMatchesEntries("myshop.com.evil.io", own), false, "suffix without a dot boundary is a different domain");
  assert.equal(hostMatchesEntries("myshop.comx", own), false);
});

test("platform matching treats m.facebook.com as facebook.com but netflix.com is not x.com", () => {
  assert.equal(isPlatform("m.facebook.com"), true);
  assert.equal(isPlatform("www.instagram.com"), true);
  assert.equal(isPlatform("apps.apple.com"), true, "a two-label platform entry matches exactly");
  assert.equal(isPlatform("netflix.com"), false, "x.com must not swallow every host ending in x.com");
  assert.equal(isPlatform("notfacebook.com"), false);
});

// ─── calcAgeMonths (full months, boundary) ─────────────────────────────────────

test("ageMonths counts full months and holds at the boundary day", () => {
  assert.equal(calcAgeMonths("2026-03-15T00:00:00Z", NOW), 6, "exactly six months");
  assert.equal(calcAgeMonths("2026-03-16T00:00:00Z", NOW), 5, "one day short of the anniversary is five");
  assert.equal(calcAgeMonths("2020-01-15T00:00:00Z", NOW), 80);
});

test("ageMonths is never negative and survives month lengths", () => {
  assert.equal(calcAgeMonths("2027-01-01T00:00:00Z", NOW), 0, "a registration date in the future is 0");
  assert.equal(calcAgeMonths("2020-01-31T00:00:00Z", new Date("2020-02-29T00:00:00Z")), 0, "Jan 31 → Feb 29 is not a full month");
  assert.equal(calcAgeMonths("2020-01-31T00:00:00Z", new Date("2020-03-01T00:00:00Z")), 1);
  assert.equal(calcAgeMonths("not-a-date", NOW), null, "garbage WHOIS data is not an age");
});

// ─── domainTags ────────────────────────────────────────────────────────────────

test("a healthy mid-life domain carries no tags at all", () => {
  assert.deepEqual(domainTags(mkRow({}), TAG_CTX), []);
});

test("rising and falling need a swing of at least two keywords", () => {
  assert.ok(domainTags(mkRow({ keywords: 12, prevKeywords: 10 }), TAG_CTX).includes("rising"));
  assert.ok(domainTags(mkRow({ keywords: 8, prevKeywords: 10 }), TAG_CTX).includes("falling"));
  assert.deepEqual(
    domainTags(mkRow({ keywords: 11, prevKeywords: 10 }), TAG_CTX).filter(t => t === "rising" || t === "falling"),
    [], "+1 is noise, not a trend",
  );
  assert.deepEqual(
    domainTags(mkRow({ keywords: 9, prevKeywords: 10 }), TAG_CTX).filter(t => t === "rising" || t === "falling"),
    [], "−1 is noise, not a trend",
  );
});

test("young holds until maxAgeMonths and stops at the boundary", () => {
  assert.ok(domainTags(mkRow({ ageMonths: 5 }), { ...TAG_CTX, maxAgeMonths: 6 }).includes("young"));
  assert.ok(!domainTags(mkRow({ ageMonths: 6 }), { ...TAG_CTX, maxAgeMonths: 6 }).includes("young"), "6 < 6 is false");
  assert.ok(!domainTags(mkRow({ ageMonths: null }), { ...TAG_CTX, maxAgeMonths: 6 }).includes("young"), "no age data, no tag");
});

test("new appears only after the first run and within NEW_HOST_DAYS", () => {
  assert.ok(domainTags(mkRow({ firstSeenAt: "2026-09-12T00:00:00.000Z" }), TAG_CTX).includes("new"), "three days after the first run");
  assert.ok(!domainTags(mkRow({ firstSeenAt: "2026-08-20T00:00:00.000Z" }), TAG_CTX).includes("new"), "seen long ago is not new");
  assert.ok(
    !domainTags(mkRow({ firstSeenAt: "2026-09-01T00:00:00.000Z" }), TAG_CTX).includes("new"),
    "seen exactly at the first run is not new — on the first run nothing is",
  );
  assert.ok(
    !domainTags(mkRow({ firstSeenAt: "2026-09-12T00:00:00.000Z" }), { ...TAG_CTX, firstRunAt: null }).includes("new"),
    "no first run yet, no new hosts",
  );
  assert.ok(
    !domainTags(mkRow({ firstSeenAt: "2026-08-31T23:59:59.000Z" }), TAG_CTX).includes("new"),
    "first-seen before the first run is not new",
  );
});

test("bounced, platform and own tags come from their own signals", () => {
  assert.ok(domainTags(mkRow({ bounces: 1 }), TAG_CTX).includes("bounced"));
  assert.ok(!domainTags(mkRow({ bounces: 0 }), TAG_CTX).includes("bounced"));
  assert.ok(domainTags(mkRow({ host: "m.facebook.com" }), TAG_CTX).includes("platform"));
  assert.ok(domainTags(mkRow({ host: "www.myshop.com" }), TAG_CTX).includes("own"));
});

test("all tags can land on one row at once", () => {
  const row = mkRow({
    host: "www.myshop.com", ageMonths: 2, keywords: 13, prevKeywords: 10, bounces: 2,
    firstSeenAt: "2026-09-13T00:00:00.000Z",
  });
  assert.deepEqual(domainTags(row, TAG_CTX), ["new", "young", "rising", "bounced", "own"]);
});

// ─── countBounces ──────────────────────────────────────────────────────────────

const ch = (keywordId: string, kind: string, runIndex: number): BounceChange => ({ keywordId, kind, runIndex });

test("a bounce is an enter→exit pair on one keyword within BOUNCE_RUNS runs", () => {
  assert.equal(countBounces([ch("k1", "enter", 1), ch("k1", "exit", 3)]), 1);
  assert.equal(countBounces([ch("k1", "enter", 1), ch("k1", "exit", 8)]), 1, "seven runs apart still pairs (1+7=8)");
  assert.equal(countBounces([ch("k1", "enter", 1), ch("k1", "exit", 9)]), 0, "eight runs apart is not a bounce");
  assert.equal(countBounces([ch("k1", "exit", 3)]), 0, "exit without enter pairs nothing");
  assert.equal(countBounces([ch("k1", "enter", 1), ch("k2", "exit", 3)]), 0, "different keywords never pair");
  assert.equal(countBounces([ch("k1", "up", 1), ch("k1", "down", 3)]), 0, "up/down moves are not bounces");
});

test("repeated bounces on one keyword accumulate", () => {
  assert.equal(countBounces([
    ch("k1", "enter", 1), ch("k1", "exit", 2),
    ch("k1", "enter", 4), ch("k1", "exit", 5),
  ]), 2);
});

test("changes are counted per host by the caller", () => {
  const hostA = [ch("k1", "enter", 1), ch("k1", "exit", 2)];
  const hostB = [ch("k1", "enter", 1), ch("k1", "exit", 9)];
  assert.equal(countBounces(hostA), 1);
  assert.equal(countBounces(hostB), 0);
});

// ─── CSV ───────────────────────────────────────────────────────────────────────

test("csvField quotes exactly what RFC 4180 requires and doubles inner quotes", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField(""), "");
  assert.equal(csvField(null), "");
  assert.equal(csvField("a,b"), '"a,b"', "comma forces quoting");
  assert.equal(csvField('a"b'), '"a""b"', "a quote forces quoting and doubling");
  assert.equal(csvField("a\nb"), '"a\nb"', "newline forces quoting");
  assert.equal(csvField("a\rb"), '"a\rb"', "carriage return forces quoting");
  assert.equal(csvField("казино"), "казино", "non-ASCII passes through; the BOM handles Excel");
});

test("csvLine joins with commas and terminates with CRLF", () => {
  assert.equal(csvLine(["a", "b,c", 'd"e']), 'a,"b,c","d""e"\r\n');
});

// ─── small utilities ───────────────────────────────────────────────────────────

test("slugifyName keeps a filename safe in Content-Disposition", () => {
  assert.equal(slugifyName("Casino BR"), "casino-br");
  assert.equal(slugifyName("Казино 🇧🇷"), "project", "non-latin collapses to nothing, fallback applies");
  assert.equal(slugifyName("  --Weird__Name!!--  "), "weird-name");
  assert.equal(slugifyName("x".repeat(100)), "x".repeat(40), "capped at 40 chars");
});

test("domainQueryFromSearchParams parses, validates and clamps", () => {
  const sp = (s: string) => new URL(`http://x/api?${s}`).searchParams;
  assert.deepEqual(domainQueryFromSearchParams(sp("preset=young&sort=dr&page=2&pageSize=50")), {
    preset: "young", sort: "dr", page: 2, pageSize: 50,
  });
  assert.deepEqual(domainQueryFromSearchParams(sp("preset=hacker")), {}, "unknown preset is dropped");
  assert.deepEqual(domainQueryFromSearchParams(sp("sort=DROP TABLE")), {}, "unknown sort is dropped");
  assert.deepEqual(domainQueryFromSearchParams(sp("maxAgeMonths=3.9")), { maxAgeMonths: 3 });
  assert.deepEqual(domainQueryFromSearchParams(sp("maxAgeMonths=-1")), {}, "negative maxAge is ignored");
  assert.equal(domainQueryFromSearchParams(sp("pageSize=9999")).pageSize, 200, "pageSize caps at 200");
  assert.deepEqual(domainQueryFromSearchParams(sp("includePlatforms=1")), { includePlatforms: true });
});
