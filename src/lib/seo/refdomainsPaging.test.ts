import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchBacklinkProfile, refdomainShortfall, REFDOMAIN_PAGE_SIZE } from "./metrics";
import { __setWriterForTests } from "../providerLog/log";

// The referring-domains profile pull against gateways that do NOT behave like the original API.
// The incident behind this file: a reseller gateway answered a limit=1000 request with 12 rows
// for a 648-domain profile, the pull read "page shorter than asked" as "end of profile", and
// reported a complete profile of 12 domains. Every case below is a gateway shape that has to end
// in a truthful verdict — complete only when the whole profile arrived, incomplete (never
// looping, never lying) when it did not.

type Gateway = {
  /** Rows the gateway will ever serve for the target. */
  total: number;
  /** Max rows per response, whatever `limit` asked for. */
  cap?: number;
  honorsOffset?: boolean;
  honorsWhere?: boolean;
};

const realFetch = globalThis.fetch;
let calls: URL[] = [];
let baseSeq = 0;

beforeEach(() => { __setWriterForTests(); calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function domainName(i: number): string { return `d${String(i).padStart(5, "0")}.example.com`; }

/** Serve `g.total` domains. DR is scrambled against the alphabet so the two orders differ. */
function installGateway(g: Gateway): string {
  const base = `http://gw${++baseSeq}.test`;
  const dataset = Array.from({ length: g.total }, (_, i) => ({
    domain: domainName(i),
    domain_rating: (i * 37) % 101,
    links_to_target: 1 + (i % 5),
    dofollow_links: i % 2,
    first_seen: "2025-01-01",
  }));
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    calls.push(url);
    const q = url.searchParams;
    const limit = Number(q.get("limit") ?? 1000);
    const offset = g.honorsOffset === false ? 0 : Number(q.get("offset") ?? 0);
    const order = q.get("order_by") ?? "";
    let rows = [...dataset];
    if (order.startsWith("domain:asc")) rows.sort((a, b) => a.domain.localeCompare(b.domain));
    else rows.sort((a, b) => b.domain_rating - a.domain_rating || a.domain.localeCompare(b.domain));
    const where = q.get("where");
    if (where && g.honorsWhere !== false) {
      for (const c of JSON.parse(where).and ?? []) {
        if (c.field === "domain" && c.is[0] === "gt") rows = rows.filter(r => r.domain > c.is[1]);
        if (c.field === "domain_rating" && c.is[0] === "gte") rows = rows.filter(r => r.domain_rating >= c.is[1]);
      }
    }
    rows = rows.slice(offset, offset + Math.min(limit, g.cap ?? limit));
    // Probe calls select only `domain`; honour the projection like a real gateway.
    const select = (q.get("select") ?? "").split(",");
    const out = rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => select.includes(k))));
    return new Response(JSON.stringify({ refdomains: out }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  return base;
}

const pull = (base: string, statsTotal: number, minDr?: number) =>
  fetchBacklinkProfile({ provider: "ahrefs", apiKey: "k", baseUrl: base }, "target.test", {
    minDr, stats: { live_refdomains: statsTotal, live: 9999 },
  });

const refdomainCalls = () => calls.filter(u => u.pathname.endsWith("/refdomains"));

test("honest gateway, small profile: one page is the whole profile", async () => {
  const base = installGateway({ total: 648 });
  const r = await pull(base, 648);
  assert.equal(r.items[0].refDomains.length, 648);
  assert.equal(r.sawEnd, true);
  assert.equal(r.shortfall, undefined);
  assert.equal(refdomainCalls().length, 1, "no confirmation page when the count is already reached");
});

test("the incident: a gateway capping responses at 12 rows no longer ends the pull at 12", async () => {
  const base = installGateway({ total: 648, cap: 12 });
  const r = await pull(base, 648);
  assert.equal(r.items[0].refDomains.length, 648);
  assert.equal(r.sawEnd, true);
  assert.equal(r.shortfall, undefined);
  assert.equal(refdomainCalls().length, 54);
  assert.equal(new Set(r.items[0].refDomains.map(d => d.refDomain)).size, 648);
});

test("a gateway that serves only a sample is reported as a shortfall, never as complete", async () => {
  // Stats say 648, the list endpoint holds 12 and then runs dry.
  const base = installGateway({ total: 12, cap: 12 });
  const r = await pull(base, 648);
  assert.equal(r.items[0].refDomains.length, 12);
  assert.equal(r.sawEnd, false, "12 of 648 must not license marking the other 636 as lost");
  assert.deepEqual(r.shortfall, { pulled: 12, total: 648 });
  assert.equal(r.items[0].refDomainsTotal, 648);
});

test("cap + ignored offset on a profile that fits a page: switches to the cursor and finishes", async () => {
  const base = installGateway({ total: 648, cap: 12, honorsOffset: false });
  const r = await pull(base, 648);
  assert.equal(r.items[0].refDomains.length, 648);
  assert.equal(r.sawEnd, true);
  const first = refdomainCalls().length;
  // The finding is cached: the next refresh goes straight to the cursor and does not re-learn it.
  calls = [];
  const again = await pull(base, 648);
  assert.equal(again.items[0].refDomains.length, 648);
  assert.equal(again.sawEnd, true);
  assert.ok(refdomainCalls().length <= first, "second pull must not cost more than the first");
  assert.ok(refdomainCalls().every(u => u.searchParams.get("where")), "second pull pages by cursor from the start");
});

test("cap + ignored offset + ignored cursor terminates incomplete instead of looping", async () => {
  const base = installGateway({ total: 648, cap: 12, honorsOffset: false, honorsWhere: false });
  const r = await pull(base, 648);
  assert.equal(r.sawEnd, false);
  assert.ok(r.items[0].refDomains.length <= 24);
  assert.ok(refdomainCalls().length <= 6, `stopped after ${refdomainCalls().length} calls`);
});

test("list a few domains shorter than the stats count still ends, via one empty confirmation page", async () => {
  // 640 listed, stats say 648: ordinary drift, well inside tolerance.
  const base = installGateway({ total: 640 });
  const r = await pull(base, 648);
  assert.equal(r.items[0].refDomains.length, 640);
  assert.equal(r.sawEnd, true);
  assert.equal(r.shortfall, undefined);
  assert.equal(refdomainCalls().length, 2);
});

test("large honest profile: offset is probed once and the pull is complete", async () => {
  const base = installGateway({ total: 2500 });
  const r = await pull(base, 2500);
  assert.equal(r.items[0].refDomains.length, 2500);
  assert.equal(r.sawEnd, true);
  assert.equal(refdomainCalls().filter(u => u.searchParams.get("limit") === String(REFDOMAIN_PAGE_SIZE)).length, 3);
});

test("large profile on a capped, cursor-only gateway pages by cursor to the end", async () => {
  const base = installGateway({ total: 1500, cap: 100, honorsOffset: false });
  const r = await pull(base, 1500);
  assert.equal(r.items[0].refDomains.length, 1500);
  assert.equal(r.sawEnd, true);
});

test("a DR-filtered pull is a deliberate subset: never a shortfall, never complete-by-count", async () => {
  const base = installGateway({ total: 648, cap: 12 });
  const r = await pull(base, 648, 50);
  assert.ok(r.items[0].refDomains.length > 0 && r.items[0].refDomains.length < 648);
  assert.ok(r.items[0].refDomains.every(d => d.dr == null || d.dr >= 50));
  assert.equal(r.shortfall, undefined);
  assert.equal(r.sawEnd, true, "end seen by an empty page; the route still refuses to call a filtered run complete");
});

test("a failing page after the first keeps what was paid for and is not an end", async () => {
  const base = `http://gw${++baseSeq}.test`;
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (n === 1) {
      const rows = Array.from({ length: 12 }, (_, i) => ({ domain: domainName(i), domain_rating: 10, links_to_target: 1, dofollow_links: 1, first_seen: "2025-01-01" }));
      return new Response(JSON.stringify({ refdomains: rows }), { status: 200 });
    }
    return new Response("nope", { status: 400 });
  }) as any;
  const r = await pull(base, 648);
  assert.equal(r.items[0].refDomains.length, 12);
  assert.equal(r.sawEnd, false);
  assert.ok(r.error);
});

test("refdomainShortfall: tolerance, filters and unknown totals", () => {
  assert.deepEqual(refdomainShortfall(12, 648), { pulled: 12, total: 648 });
  assert.equal(refdomainShortfall(640, 648), null);          // drift
  assert.equal(refdomainShortfall(590, 648), null);          // within a tenth
  assert.ok(refdomainShortfall(500, 648));                   // beyond it
  assert.equal(refdomainShortfall(6, 10), null);             // tiny profile: 5-domain floor
  assert.ok(refdomainShortfall(3, 10));                      // over half of a tiny profile missing
  assert.ok(refdomainShortfall(0, 40));                      // nothing at all is not drift
  assert.equal(refdomainShortfall(12, 648, 40), null);       // filtered
  assert.equal(refdomainShortfall(12, null), null);
  assert.equal(refdomainShortfall(0, 0), null);
});
