import test from "node:test";
import assert from "node:assert/strict";

// N9 — the 15-minute audit cache and the one-time lead tokens.

import { AuditCache, CACHE_TTL_MS, TOKEN_TTL_MS } from "./cache";
import type { LiteAuditReport } from "./types";

const report = (domain: string): LiteAuditReport => ({
  domain,
  finalUrl: `https://${domain}/`,
  https: true,
  score: 72,
  findings: [{
    code: "title_too_long", severity: "warning", category: "metadata",
    evidence: "72 > 65 · /", pages: ["/"],
  }],
  pagesChecked: 3,
  checkedAt: "2026-01-01T00:00:00.000Z",
});

test("a cached domain is served without a second audit, per widget key", () => {
  const now = { v: 1_000_000 };
  const cache = new AuditCache(() => now.v);
  cache.set("wid_a", "example.com", report("example.com"));
  assert.equal(cache.get("wid_a", "example.com")?.score, 72);
  // Another widget key audits the same domain separately.
  assert.equal(cache.get("wid_b", "example.com"), null);
  // www vs bare domain are different keys too.
  assert.equal(cache.get("wid_a", "www.example.com"), null);
});

test("entries expire after the TTL", () => {
  const now = { v: 1_000_000 };
  const cache = new AuditCache(() => now.v);
  cache.set("wid_a", "example.com", report("example.com"));
  now.v += CACHE_TTL_MS + 1;
  assert.equal(cache.get("wid_a", "example.com"), null);
});

test("a lead token is single-use and bound to its cached audit", () => {
  const now = { v: 1_000_000 };
  const cache = new AuditCache(() => now.v);
  cache.set("wid_a", "example.com", report("example.com"));
  const token = cache.issueToken("wid_a", "example.com");
  const first = cache.consumeToken(token);
  assert.equal(first?.domain, "example.com");
  // Replay: refused.
  assert.equal(cache.consumeToken(token), null);
});

test("a token outlives the report cache but dies at its own TTL", () => {
  const now = { v: 1_000_000 };
  const cache = new AuditCache(() => now.v);
  cache.set("wid_a", "example.com", report("example.com"));
  const token = cache.issueToken("wid_a", "example.com");
  now.v += CACHE_TTL_MS + 1; // report gone…
  assert.equal(cache.consumeToken(token), null); // …so the token yields nothing
  cache.set("wid_a", "example.com", report("example.com"));
  const token2 = cache.issueToken("wid_a", "example.com");
  now.v += TOKEN_TTL_MS + 1;
  assert.equal(cache.consumeToken(token2), null);
});

test("a token minted for a domain that was never cached yields nothing", () => {
  const cache = new AuditCache();
  const token = cache.issueToken("wid_a", "never-cached.example");
  assert.equal(cache.consumeToken(token), null);
});
