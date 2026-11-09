import assert from "node:assert/strict";
import test from "node:test";
import {
  cgTarget, cgCodeToStatus, parseCgEnvelope, mapCgRefDomain, mapCgBacklinks, mapCgReleases,
  mapCgChanges, mapCgGapSubmit, mapCgGapJob,
} from "./crawlgraphParse";
import {
  parseMetricsProvider, isKeywordCapable, domainUnits, gatewayStatusFromError, UNIT_PRICE_USD,
  estimateCostUsd, CRAWLGRAPH_LIMIT, CRAWLGRAPH_STATS_UNITS, CRAWLGRAPH_PROFILE_UNITS,
  CRAWLGRAPH_CHANGES_UNITS, CRAWLGRAPH_GAP_UNITS, estimateCrawlgraphProfileUnits, formatProviderUnits,
  metersInDollars,
} from "./metricsPricing";

// Fixture shapes follow the documented response of each endpoint (crawlgraph.com/docs/api,
// fetched 2026-11-09); the backlinks example is the quickstart's own, with example.com's totals.

test("pricing: the meter is calls — flat 1 unit per backlinks/changes call, 1 per gap job", () => {
  assert.equal(CRAWLGRAPH_LIMIT, 10_000);
  assert.equal(CRAWLGRAPH_STATS_UNITS, 1);
  assert.equal(CRAWLGRAPH_PROFILE_UNITS, 1);
  assert.equal(CRAWLGRAPH_CHANGES_UNITS, 1);
  assert.equal(CRAWLGRAPH_GAP_UNITS, 1);
  assert.equal(estimateCrawlgraphProfileUnits(), 2); // stats pre-flight + the pull itself
  assert.equal(domainUnits("crawlgraph"), 1);
  // $19/month per 1 000 calls — one call ≈ $0.019, a full refresh ≈ $0.038.
  assert.equal(UNIT_PRICE_USD.crawlgraph, 0.019);
  assert.ok(Math.abs(estimateCostUsd(estimateCrawlgraphProfileUnits(), "crawlgraph") - 0.038) < 1e-12);
});

test("provider plumbing: parse, keyword guard, calls on screen", () => {
  assert.equal(parseMetricsProvider("crawlgraph"), "crawlgraph");
  assert.equal(parseMetricsProvider("nope"), "ahrefs"); // unknown still falls back
  assert.equal(isKeywordCapable("crawlgraph"), false); // no keyword side, like Majestic
  assert.equal(metersInDollars("crawlgraph"), false); // the cap is a call count, not dollars
  assert.equal(formatProviderUnits(2, "crawlgraph"), "2");
  assert.equal(gatewayStatusFromError("crawlgraph 429: quota_exceeded"), 429);
});

test("target normalization strips scheme, www and path", () => {
  assert.equal(cgTarget("https://www.Example.com/some/page"), "example.com");
  assert.equal(cgTarget("example.com"), "example.com");
});

test("error codes fold onto the three-digit statuses the UI branches on", () => {
  assert.equal(cgCodeToStatus("auth_missing", 401), 401);
  assert.equal(cgCodeToStatus("auth_invalid", 401), 401);
  assert.equal(cgCodeToStatus("quota_exceeded", 429), 429);
  // What a free key really gets on a gap submit (verified live, 2026-11-09): a paywall, not a
  // spent quota — folded onto 402 so the UI says "needs a paid plan", not "out of calls".
  assert.equal(cgCodeToStatus("upgrade_required", 429), 402);
  assert.equal(cgCodeToStatus("validation_error", 400), 400);
  assert.equal(cgCodeToStatus("release_unavailable", 409), 409);
  assert.equal(cgCodeToStatus("not_found", 404), 404);
  assert.equal(cgCodeToStatus("internal_error", 500), 500);
  assert.equal(cgCodeToStatus("something_new", 418), 418); // unknown keeps its HTTP status
  assert.equal(cgCodeToStatus("something_new", 200), 502); // …or is a bad answer when 2xx
});

test("envelope: non-2xx becomes crawlgraph <status> with the request_id along", () => {
  const env = parseCgEnvelope(429, { error: "quota_exceeded", message: "Monthly quota hit", request_id: "req_a1b2" });
  assert.equal(env.ok, false);
  if (!env.ok) {
    assert.equal(env.status, 429);
    assert.match(env.error, /^crawlgraph 429: Monthly quota hit/);
    assert.match(env.error, /req_a1b2/);
    assert.equal(gatewayStatusFromError(env.error), 429);
  }
  assert.equal(parseCgEnvelope(200, "not an object" as unknown as Record<string, unknown>).ok, false);
  assert.equal(parseCgEnvelope(200, { domain: "x.com" }).ok, true);
});

test("refdomain mapping: www stripped, nullable authority is an answer not an error", () => {
  assert.deepEqual(mapCgRefDomain({ linking_domain: "Blog.Foo.com", num_hosts: 12, tld: "com", cg_authority: 84, cg_rank: 1421 }), {
    refDomain: "blog.foo.com", authority: 84, linksToTarget: 12, dofollow: true, firstSeen: "",
  });
  const noRank = mapCgRefDomain({ linking_domain: "news.bar.org", num_hosts: 7, cg_authority: null, cg_rank: null });
  assert.equal(noRank?.authority, null);
  assert.equal(mapCgRefDomain({ linking_domain: "no-dot" }), null);
});

test("backlinks mapping: the quickstart example, and truncation is returned < total", () => {
  const full = mapCgBacklinks({
    domain: "example.com", release_id: "cc-main-2026-jul-aug-sep", release_label: "Jul-Sep 2026",
    total_linking_domains: 4821, returned: 10, cg_authority: 61, cg_rank: 90210,
    results: [
      { linking_domain: "blog.foo.com", num_hosts: 12, tld: "com", cg_authority: 84, cg_rank: 1421 },
      { linking_domain: "news.bar.org", num_hosts: 7, tld: "org", cg_authority: null, cg_rank: null },
    ],
  });
  assert.equal(full.summary.releaseLabel, "Jul-Sep 2026");
  assert.equal(full.summary.totalLinkingDomains, 4821);
  assert.equal(full.summary.authority, 61);
  assert.equal(full.refDomains.length, 2);
  assert.equal(full.summary.truncated, true); // 10 < 4821

  const whole = mapCgBacklinks({ domain: "a.gr", total_linking_domains: 7, returned: 7, results: [] });
  assert.equal(whole.summary.truncated, false); // nothing left on the table → complete pull
});

test("releases mapping keeps availability, for the free key check", () => {
  const rel = mapCgReleases({ releases: [
    { id: "cc-main-2026-jul-aug-sep", label: "Jul-Sep 2026", available: true },
    { id: "cc-main-2026-jan-feb-mar", label: "Jan-Mar 2026", available: false },
    { label: "no id, dropped" },
  ] });
  assert.equal(rel.length, 2);
  assert.deepEqual(rel[1], { id: "cc-main-2026-jan-feb-mar", label: "Jan-Mar 2026", available: false });
});

test("changes mapping: counts, rows, caveat — and absence ≠ lost stays visible", () => {
  const ch = mapCgChanges({
    domain: "example.com", comparison_available: true,
    from_release: { id: "cc-main-2026-apr-may-jun", label: "Apr-Jun 2026" },
    to_release: { id: "cc-main-2026-jul-aug-sep", label: "Jul-Sep 2026" },
    counts: { from_snapshot: 4821, to_snapshot: 4890, added: 92, removed: 23, authority_moved: 17 },
    added: [{ linking_domain: "new-reference.org", num_hosts: 4, cg_authority: 73 }],
    removed: [{ linking_domain: "older-reference.net", num_hosts: 2, cg_authority: 61 }],
    authority_moved: [{ linking_domain: "example-source.com", from_authority: 52, to_authority: 60, delta: 8 }],
    truncated: false, cap: 100000,
    snapshot_caveat: "Absence from a newer snapshot does not prove a page removed a link.",
  });
  assert.equal(ch.comparisonAvailable, true);
  assert.equal(ch.counts.added, 92);
  assert.equal(ch.added[0]?.refDomain, "new-reference.org");
  assert.equal(ch.authorityMoved[0]?.delta, 8);
  assert.match(ch.snapshotCaveat, /does not prove/);
  assert.equal(ch.fromRelease?.label, "Apr-Jun 2026");
});

test("changes mapping: comparison_available:false is a 200 that still burned a call", () => {
  const ch = mapCgChanges({
    domain: "example.com", comparison_available: false, from_release: null,
    to_release: { id: "cc-main-2026-mar-apr-may", label: "Mar-May 2026" },
    counts: { from_snapshot: 0, to_snapshot: 0, added: 0, removed: 0, authority_moved: 0 },
    added: [], removed: [], authority_moved: [], truncated: false, cap: 100000,
    message: "both indexed release artifacts are required for a comparison",
    snapshot_caveat: "Common Crawl snapshots are periodic observations, not live link monitoring.",
  });
  assert.equal(ch.comparisonAvailable, false);
  assert.equal(ch.fromRelease, null);
  assert.match(ch.message, /required/);
  assert.deepEqual(ch.added, []);
});

test("gap submit: job id and poll url", () => {
  assert.deepEqual(mapCgGapSubmit({ job_id: "gap_a1b2c3", status: "queued", poll_url: "/api/v1/gap-analysis/gap_a1b2c3" }), {
    jobId: "gap_a1b2c3", status: "queued", pollUrl: "/api/v1/gap-analysis/gap_a1b2c3",
  });
  assert.equal(mapCgGapSubmit({ status: "queued" }), null);
});

test("gap job: running, completed and failed shapes", () => {
  const running = mapCgGapJob({ job_id: "gap_a1b2c3", status: "running", started_at: "2026-04-27T12:34:56Z", progress_pct: 42 });
  assert.equal(running?.status, "running");
  assert.equal(running?.progressPct, 42);
  assert.equal(running?.result, null);

  const done = mapCgGapJob({
    job_id: "gap_a1b2c3", status: "completed", completed_at: "2026-04-27T12:36:18Z",
    result: {
      my_domain: "example.com", competitor_domains: ["a.com", "b.com"],
      gaps: [{ linking_domain: "x.com", found_on: ["a.com", "b.com"] }],
      total_gaps: 1284, truncated: false, release_id: "cc-main-2026-jul-aug-sep",
      provenance_status: "verified", built_at: "2026-04-27T12:36:00Z",
    },
  });
  assert.equal(done?.status, "completed");
  assert.equal(done?.result?.totalGaps, 1284);
  assert.deepEqual(done?.result?.gaps[0]?.foundOn, ["a.com", "b.com"]);
  assert.equal(done?.result?.provenanceStatus, "verified");

  const failed = mapCgGapJob({ job_id: "gap_a1b2c3", status: "failed", error: { code: "internal_error", message: "worker died" } });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error?.code, "internal_error");

  // An unknown status word still maps to a pollable job, never to null.
  assert.equal(mapCgGapJob({ job_id: "j", status: "weird" })?.status, "queued");
});
