import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  buildParityReport, classifyBot, looksLikeChallenge, noiseFloorOf, BOT_IDENTITIES, type ProbeSample,
} from "./parity";
import {
  countCaptures, crawlPresence, domainKeyRange, findBlocks, isDomainKey, parseCollinfo, parseIdxLine,
  pickBlocks, runPresence, surtDomain, backoffMs, isThrottleStatus, RangeThrottledError, type RangeReader,
} from "./ccPresence";
import { authorityFromRank, ccRankBaseUrl, parseRankResponse, CCRANK_DEFAULT_URL } from "./ccRank";
import { accessScore, authorityScore, compactRank, computeScore, gradeFor, presenceScore, rankTier } from "./score";
import type { AccessPart, PresenceMonth, PresencePart, RankPart } from "./types";

// ─── T1: parity ───────────────────────────────────────────────────────────────

const words = (seed: string, n = 400) => Array.from({ length: n }, (_, i) => `${seed}${i % 97} token${i}`).join(" ");
const page = (text: string, over: Partial<ProbeSample> = {}): ProbeSample =>
  ({ status: 200, finalHost: "example.com", text, challenge: false, error: null, ...over });

test("parity: a bot served the browser's page is 'same'", () => {
  const base = page(words("alpha"));
  const r = classifyBot(page(words("alpha")), [base], 0);
  assert.equal(r.verdict, "same");
  assert.equal(r.similarity, 1);
});

test("parity: refusal, challenge, error and off-host redirect are four different verdicts", () => {
  const base = [page(words("alpha"))];
  assert.equal(classifyBot(page("", { status: 403 }), base, 0).verdict, "blocked");
  assert.equal(classifyBot(page("", { status: 404 }), base, 0).verdict, "blocked");
  assert.equal(classifyBot(page("x", { status: 403, challenge: true }), base, 0).verdict, "challenge");
  assert.equal(classifyBot(page("", { status: null, error: "request_timeout" }), base, 0).verdict, "error");
  assert.equal(classifyBot(page(words("alpha"), { finalHost: "parked.example.net" }), base, 0).verdict, "redirected");
  // www ↔ bare host is the same site, not a redirect elsewhere.
  assert.equal(classifyBot(page(words("alpha"), { finalHost: "www.example.com" }), base, 0).verdict, "same");
});

test("parity: divergence is charged only beyond the page's own noise", () => {
  const a = page(words("alpha")), b = page(words("alpha", 300) + " " + words("rotating", 100));
  const noise = noiseFloorOf(a, b)!;
  assert.ok(noise > 0.05 && noise < 0.6, `noise ${noise}`);
  // The second browser fetch, replayed as a bot, is as different as the page is from itself:
  // with the measured floor it is 'same'…
  assert.equal(classifyBot(b, [a], noise).verdict, "same");
  // …and a genuinely different document is 'different' whatever the floor.
  assert.equal(classifyBot(page(words("casino")), [a, b], noise).verdict, "different");
});

test("parity: a 200 stub where the browser got a page is 'different' (soft block)", () => {
  const base = [page(words("alpha"))];
  assert.equal(classifyBot(page("Access restricted."), base, 0).verdict, "different");
  // …but two near-empty SPA shells are the same page.
  assert.equal(classifyBot(page("Loading"), [page("Loading")], 0).verdict, "same");
});

test("parity: no usable baseline makes every row inconclusive, never blocked", () => {
  const dead = page("", { status: 503 });
  const report = buildParityReport("https://example.com/", [dead, dead], BOT_IDENTITIES.map(identity => ({ identity, sample: page("", { status: 403 }) })));
  assert.equal(report.conclusive, false);
  assert.equal(report.noiseFloor, null);
  assert.ok(report.rows.every(r => r.verdict === "inconclusive"));
  assert.equal(report.rows.length, 4);
});

test("parity: challenge detection trusts the header, and body markers only on short/refused pages", () => {
  assert.equal(looksLikeChallenge(200, new Headers({ "cf-mitigated": "challenge" }), "<html></html>"), true);
  assert.equal(looksLikeChallenge(403, new Headers(), "<title>Just a moment...</title>"), true);
  assert.equal(looksLikeChallenge(200, new Headers(), "<p>hello</p>"), false);
  // A long real page with a reCAPTCHA on its contact form is a page, not an interstitial.
  assert.equal(looksLikeChallenge(200, new Headers(), "<div class=\"g-recaptcha\"></div>" + "x".repeat(30_000)), false);
});

// ─── T2: presence ─────────────────────────────────────────────────────────────

test("presence: SURT form and the domain key range", () => {
  assert.equal(surtDomain("Blog.Example.co.uk"), "uk,co,example,blog");
  assert.equal(surtDomain("www.example.com."), "com,example");
  const { lo, hi } = domainKeyRange("com,example");
  for (const k of ["com,example)/", "com,example)/a?b=1", "com,example,www)/", "com,example,shop,eu)/x"]) {
    assert.ok(k >= lo && k < hi, k);
    assert.ok(isDomainKey(k, "com,example"), k);
  }
  // Neighbours that merely share the prefix are other domains and fall outside the range.
  for (const k of ["com,example-shop)/", "com,examples)/", "com,exampl)/", "com,example1)/"]) {
    assert.ok(!(k >= lo && k < hi), k);
    assert.ok(!isDomainKey(k, "com,example"), k);
  }
});

test("presence: cluster.idx line and collinfo parsing", () => {
  assert.deepEqual(parseIdxLine("com,withloah)/cafe-bakery-pair 20261010235022\tcdx-00151.gz\t524393081\t254575\t454884"),
    { key: "com,withloah)/cafe-bakery-pair", file: "cdx-00151.gz", offset: 524393081, length: 254575 });
  assert.equal(parseIdxLine("garbage"), null);
  assert.equal(parseIdxLine("k 1\t../../etc/passwd\t0\t10\t1"), null); // the file name is used in a URL
  const crawls = parseCollinfo([
    { id: "CC-MAIN-2026-43", from: "2026-10-05T10:56:23" },
    { id: "CC-NEWS-2026-10", from: "2026-10-01T00:00:00" },
    { id: "CC-MAIN-2026-39", from: "2026-09-04T13:16:03" },
  ]);
  assert.deepEqual(crawls, [{ id: "CC-MAIN-2026-43", month: "2026-10" }, { id: "CC-MAIN-2026-39", month: "2026-09" }]);
  assert.deepEqual(parseCollinfo({ nope: 1 }), []);
});

test("presence: pickBlocks takes the block before the range and those starting inside it", () => {
  const L = (key: string, n: number) => ({ key, file: "cdx-00001.gz", offset: n * 100, length: 100 });
  const lines = [L("com,aaa)/", 0), L("com,exa)/", 1), L("com,example)/m", 2), L("com,example,www)/z", 3), L("com,examples)/", 4), L("com,zzz)/", 5)];
  const { blocks, more } = pickBlocks(lines, "com,example", 5);
  assert.deepEqual(blocks.map(b => b.offset), [100, 200, 300]);
  assert.equal(more, false);
  assert.equal(pickBlocks(lines, "com,example", 2).more, true);
  // A domain sorting before the first line still yields that first block (and finds nothing in it).
  assert.deepEqual(pickBlocks(lines, "com,aa").blocks.map(b => b.offset), [0]);
});

// A synthetic crawl index: 40 000 domains × 3 records, 5 records per block. Big enough
// (> 1 MB of cluster.idx) that findBlocks really binary-searches instead of reading one window.
function fakeCrawl() {
  const records: string[] = [];
  for (let d = 0; d < 40_000; d++) {
    const host = `com,site${String(d).padStart(5, "0")}`;
    records.push(`${host})/ 20261005000000 {"status": "200"}`, `${host})/about 20261005000001 {"status": "200"}`, `${host},www)/x 20261005000002 {"status": "200"}`);
  }
  records.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const blocks: Buffer[] = [];
  const idx: string[] = [];
  let offset = 0;
  for (let i = 0; i < records.length; i += 5) {
    const gz = gzipSync(Buffer.from(records.slice(i, i + 5).join("\n") + "\n", "latin1"));
    const first = records[i].split(" ");
    idx.push(`${first[0]} ${first[1]}\tcdx-00000.gz\t${offset}\t${gz.length}\t${idx.length + 1}`);
    blocks.push(gz);
    offset += gz.length;
  }
  const files: Record<string, Buffer> = { "cluster.idx": Buffer.from(idx.join("\n") + "\n", "latin1"), "cdx-00000.gz": Buffer.concat(blocks) };
  let calls = 0, bytes = 0;
  const read: RangeReader = async (url, start, end) => {
    const file = files[url.slice(url.lastIndexOf("/") + 1)];
    if (!file) throw new Error("404");
    calls++;
    const slice = file.subarray(start, Math.min(file.length, end + 1));
    bytes += slice.length;
    return { bytes: new Uint8Array(slice), total: file.length };
  };
  return { read, idxSize: files["cluster.idx"].length, stats: () => ({ calls, bytes }) };
}

test("presence: binary search over cluster.idx finds every probed domain with a bounded number of reads", async () => {
  const { read, idxSize, stats } = fakeCrawl();
  assert.ok(idxSize > 1_000_000, `idx ${idxSize}`);
  const crawl = { id: "CC-MAIN-2026-43", month: "2026-10" };
  for (const d of ["site00000.com", "site00001.com", "site12345.com", "site20000.com", "site39998.com", "site39999.com"]) {
    const m = await crawlPresence(read, crawl, d);
    assert.deepEqual({ present: m.present, captures: m.captures, capped: m.capped }, { present: true, captures: 3, capped: false }, d);
  }
  for (const d of ["site4.com", "aaa.com", "zzz.com", "site123456.com", "site1234.net"]) {
    const m = await crawlPresence(read, crawl, d);
    assert.deepEqual({ present: m.present, captures: m.captures }, { present: false, captures: 0 }, d);
  }
  const { calls, bytes } = stats();
  // 11 lookups; each must stay a handful of small reads, nowhere near the index size.
  assert.ok(calls / 11 < 20, `calls per lookup ${calls / 11}`);
  assert.ok(bytes / 11 < 400_000, `bytes per lookup ${bytes / 11}`);
  const { blocks } = await findBlocks(read, "CC-MAIN-2026-43", "com,site12345");
  assert.ok(blocks.length >= 1 && blocks.length <= 2);
});

test("presence: countCaptures counts only lines that start with the domain's key", () => {
  const block = ["com,exa)/ 1 {}", "com,example)/ 1 {}", "com,example)/a 2 {\"url\": \"http://x/com,example)/\"}", "com,example,www)/ 3 {}", "com,examples)/ 4 {}"].join("\n") + "\n";
  assert.equal(countCaptures(block, "com,example"), 3);
  assert.equal(countCaptures("", "com,example"), 0);
});

test("presence: answered months are final, failed ones stay unknown, and the budget leaves a remainder", async () => {
  const crawls = ["43", "39", "34", "30"].map((w, i) => ({ id: `CC-MAIN-2026-${w}`, month: `2026-${String(10 - i).padStart(2, "0")}` }));
  const asked: string[] = [];
  const read: RangeReader = async url => { asked.push(url.match(/CC-MAIN-\d{4}-\d{2}/)![0]); throw new Error("boom"); };
  const previous: PresenceMonth[] = [
    { crawl: "CC-MAIN-2026-39", month: "2026-09", present: true, captures: 7, capped: false },
    { crawl: "CC-MAIN-2026-34", month: "2026-08", present: null, captures: 0, capped: false },
  ];
  const part = await runPresence("example.com", crawls, previous, read);
  assert.deepEqual(part.months.map(m => m.present), [null, true, null, null]);
  assert.equal(part.months[1].captures, 7);
  assert.ok(!asked.includes("CC-MAIN-2026-39"), "a final month must not be re-read");
  assert.equal(part.pending, 0, "tried-and-failed is not pending — the UI must not loop on a dead endpoint");

  // Budget already spent: nothing is attempted and everything unread is reported as pending.
  let t = 0;
  const spent = await runPresence("example.com", crawls, previous, read, { budgetMs: 10, now: () => (t += 100) });
  assert.equal(spent.pending, 3);
});

test("presence: a throttle answer stops the run — no further months are asked, and the UI is not told to loop", async () => {
  const crawls = Array.from({ length: 8 }, (_, i) => ({ id: `CC-MAIN-2026-${String(40 - i).padStart(2, "0")}`, month: "2026-01" }));
  const asked = new Set<string>();
  const read: RangeReader = async url => { asked.add(url.match(/CC-MAIN-\d{4}-\d{2}/)![0]); throw new RangeThrottledError(429); };
  const part = await runPresence("example.com", crawls, undefined, read);
  assert.equal(part.throttled, true);
  assert.equal(part.pending, 0);
  assert.ok(asked.size <= 3, `asked ${asked.size} crawls — only the first wave of workers may have started`);
  assert.ok(part.months.every(m => m.present === null), "throttled months are unknown, never absent");
  // An ordinary failure does not set the flag.
  const plain = await runPresence("example.com", crawls.slice(0, 2), undefined, async () => { throw new Error("boom"); });
  assert.equal(plain.throttled, undefined);
});

test("presence: which statuses mean 'back off', and for how long", () => {
  assert.deepEqual([429, 403, 503, 404, 500, 206].map(isThrottleStatus), [true, true, true, false, false, false]);
  assert.deepEqual([null, "1", "3", "600", "abc", "0"].map(backoffMs), [2000, 1000, 3000, 5000, 2000, 2000]);
});

// ─── T3: rank ─────────────────────────────────────────────────────────────────

test("rank: authority is log-scaled — top is 100, the tail is 0, the geometric middle is 50", () => {
  assert.equal(authorityFromRank(1, 118_000_000), 100);
  assert.equal(authorityFromRank(118_000_000, 118_000_000), 0);
  assert.equal(authorityFromRank(10_000, 100_000_000), 50);
  assert.equal(authorityFromRank(null, 100), null);
  assert.equal(authorityFromRank(5, null), null);
  assert.equal(authorityFromRank(999, 100), 0); // a rank past the total clamps, never goes negative
});

test("rank: directory answers map to ok / not_found / unavailable", () => {
  const at = "2026-11-15T00:00:00.000Z";
  const ok = parseRankResponse({ release: "cc-main-2026-may-jun-jul", total: 118_000_000, results: [{ query: "blog.example.com", domain: "example.com", found: true, hcRank: 10_863, prRank: 20_000, hosts: 3 }] }, at);
  assert.deepEqual({ s: ok.status, d: ok.domain, a: ok.authority, h: ok.hosts }, { s: "ok", d: "example.com", a: 50, h: 3 });
  const miss = parseRankResponse({ release: "r", total: 1000, results: [{ query: "x.com", found: false }] }, at);
  assert.deepEqual({ s: miss.status, a: miss.authority }, { s: "not_found", a: 0 });
  for (const bad of [null, "nope", {}, { release: "r", total: 5 }, { release: "r", total: 5, results: [{ found: true }] }]) {
    const r = parseRankResponse(bad, at);
    assert.deepEqual({ s: r.status, a: r.authority }, { s: "unavailable", a: null });
  }
});

test("rank: base URL — default, override, and an explicit off", () => {
  assert.equal(ccRankBaseUrl(undefined), CCRANK_DEFAULT_URL);
  assert.equal(ccRankBaseUrl(""), CCRANK_DEFAULT_URL);
  assert.equal(ccRankBaseUrl("https://ranks.example.org/"), "https://ranks.example.org");
  assert.equal(ccRankBaseUrl("off"), null);
  assert.equal(ccRankBaseUrl("OFF"), null);
});

// ─── Score ────────────────────────────────────────────────────────────────────

const bots = (allowed: number, blocked: number, unknown = 0) => [
  ...Array.from({ length: allowed }, (_, i) => ({ token: `A${i}`, engine: "e", status: "allowed" as const })),
  ...Array.from({ length: blocked }, (_, i) => ({ token: `B${i}`, engine: "e", status: "blocked" as const })),
  ...Array.from({ length: unknown }, (_, i) => ({ token: `U${i}`, engine: "e", status: "unknown" as const })),
];
const access = (o: { allowed?: number; blocked?: number; unknown?: number; llms?: "ok" | "missing" | "failed"; verdicts?: string[]; conclusive?: boolean }): AccessPart => ({
  crawl: {
    robots: { status: o.unknown ? "failed" : "ok", present: !o.unknown },
    llmsTxt: { status: o.llms ?? "missing", present: o.llms === "ok", chars: null },
    bots: bots(o.allowed ?? 7, o.blocked ?? 0, o.unknown ?? 0),
    blockedCount: o.blocked ?? 0, total: 7,
  },
  parity: {
    url: "https://example.com/", baselineStatus: 200, noiseFloor: 0, conclusive: o.conclusive ?? true,
    rows: (o.verdicts ?? ["same", "same", "same", "same"]).map((v, i) => ({ id: `b${i}`, label: "B", engine: "e", status: 200, verdict: v as AccessPart["parity"]["rows"][number]["verdict"], similarity: 1 })),
  },
  checkedAt: "2026-11-15T00:00:00.000Z",
});
const presence = (flags: Array<boolean | null>): PresencePart => ({
  months: flags.map((p, i) => ({ crawl: `c${i}`, month: "2026-01", present: p, captures: p ? 1 : 0, capped: false })),
  pending: 0, checkedAt: "2026-11-15T00:00:00.000Z",
});
const rank = (status: RankPart["status"], authority: number | null): RankPart =>
  ({ status, release: "r", domain: "example.com", hcRank: 1, prRank: 1, total: 10, hosts: 1, authority, checkedAt: "2026-11-15T00:00:00.000Z" });

test("score: access — open site without llms.txt is 90, with it 100, half-blocked drops accordingly", () => {
  assert.equal(accessScore(access({})), 90);
  assert.equal(accessScore(access({ llms: "ok" })), 100);
  assert.equal(accessScore(access({ allowed: 0, blocked: 7, verdicts: ["blocked", "blocked", "challenge", "different"] })), 0);
  // robots fine, but the server refuses two of four bot identities: 45 + 22.5 + 0 → 68 (67.5 rounds up).
  assert.equal(accessScore(access({ verdicts: ["same", "same", "blocked", "challenge"] })), 68);
});

test("score: what could not be read is excluded, not zeroed", () => {
  // robots unreadable, llms unreadable, parity inconclusive → nothing to score.
  assert.equal(accessScore(access({ allowed: 0, unknown: 7, llms: "failed", conclusive: false })), null);
  // Only parity known, and it is clean → 100, not 45.
  assert.equal(accessScore(access({ allowed: 0, unknown: 7, llms: "failed" })), 100);
  // A network error on one bot is not a block: 3 of 3 judged identities are 'same'.
  assert.equal(accessScore(access({ llms: "ok", verdicts: ["same", "same", "same", "error"] })), 100);
  assert.equal(presenceScore(presence([null, null])), null);
  assert.equal(presenceScore(presence([null, true, false, null])), 65); // 1 of 2 known → 35, newest known present → +30
  assert.equal(authorityScore(rank("unavailable", null)), null);
  assert.equal(authorityScore(rank("not_configured", null)), null);
  assert.equal(authorityScore(rank("not_found", 0)), 0);
});

test("score: presence — all twelve months is 100, none is 0, recency carries 30", () => {
  assert.equal(presenceScore(presence(Array(12).fill(true))), 100);
  assert.equal(presenceScore(presence(Array(12).fill(false))), 0);
  assert.equal(presenceScore(presence([false, ...Array(11).fill(true)])), 64);
  assert.equal(presenceScore(presence([true, ...Array(11).fill(false)])), 36);
});

test("score: overall is the weighted mean of the parts present, and says which ones", () => {
  const full = computeScore({ access: access({ llms: "ok" }), presence: presence(Array(12).fill(true)), rank: rank("ok", 40) });
  assert.deepEqual(full, { score: 82, grade: "B", parts: { access: 100, presence: 100, authority: 40 }, coverage: ["access", "presence", "rank"] });
  const one = computeScore({ access: access({}) });
  assert.deepEqual(one, { score: 90, grade: "A", parts: { access: 90, presence: null, authority: null }, coverage: ["access"] });
  // An unreachable directory leaves the score exactly where two parts put it.
  const two = computeScore({ access: access({ llms: "ok" }), presence: presence(Array(12).fill(false)), rank: rank("unavailable", null) });
  assert.deepEqual({ s: two.score, c: two.coverage }, { s: 71, c: ["access", "presence"] });
  assert.deepEqual(computeScore({}), { score: null, grade: null, parts: { access: null, presence: null, authority: null }, coverage: [] });
});

test("score: grade floors", () => {
  assert.deepEqual([100, 85, 84, 70, 69, 55, 54, 40, 39, 25, 24, 0].map(gradeFor), ["A", "A", "B", "B", "C", "C", "D", "D", "E", "E", "F", "F"]);
});

test("rank tier: one name per order of magnitude, boundaries inclusive, unknown is unranked", () => {
  assert.deepEqual([1, 1000, 1001, 10_000, 10_001, 100_000, 100_001, 1_000_000, 2_222_607, 10_000_000, 10_000_001].map(rankTier),
    ["elite", "elite", "authoritative", "authoritative", "established", "established", "strong", "strong", "emerging", "emerging", "unranked"]);
  assert.deepEqual([null, undefined, 0, -5].map(rankTier), ["unranked", "unranked", "unranked", "unranked"]);
  assert.deepEqual([812, 1000, 1500, 45_300, 999_999, 2_222_607, 10_000_000, 118_000_000].map(compactRank),
    ["812", "1K", "1.5K", "45K", "1M", "2.2M", "10M", "118M"]);
});
