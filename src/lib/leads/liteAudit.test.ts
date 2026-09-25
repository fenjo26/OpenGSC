import test from "node:test";
import assert from "node:assert/strict";

// N9 — the lite audit on HTML fixtures, plus the two contracts that make it safe:
// every fetch goes out with allowPrivate: false, and every fetch stays inside the audited
// host's origin.

import { normalizeAuditDomain, runLiteAudit, scoreFromFindings, topFindings, LiteAuditError, type FetchOutcome, type WidgetFetcher } from "./liteAudit";
import type { FindingCode } from "./types";
import type { SafeFetchOptions } from "@/lib/security/safeFetch";

// ─── fixtures ─────────────────────────────────────────────────────────────────

const LOREM = ("Search engine optimization audits examine titles descriptions headings and internal links. "
  + "A good page explains its subject clearly answers the visitor's question and loads quickly on a phone. "
  + "The crawler reads the markup exactly as delivered and compares it against the same rules the operator's "
  + "own site audit uses so a finding means the same thing in both places. ").repeat(4);

/** Titles inside the audit band (50–65 code points) whatever the base text is. */
const fitTitle = (base: string) => (base + " detailed guidance for website owners everywhere").slice(0, 58);

function goodPage(url: string, title: string): string {
  const path = new URL(url).pathname;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${fitTitle(title)}</title>
<meta name="description" content="${"A complete audit-ready description that fits the target band and explains exactly what this page offers to the person reading the snippet in search results.".slice(0, 155)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${title}">
<meta property="og:description" content="open graph description">
<meta property="og:image" content="https://good.example/og.png">
<link rel="canonical" href="${url}">
<script type="application/ld+json">{"@type":"WebPage","name":"${title}","url":"${url}"}</script>
</head>
<body>
<h1>${title}</h1>
<nav><a href="/about">About</a> <a href="/pricing">Pricing</a></nav>
<p>${LOREM}</p>
${path === "/" ? '<a href="/about">more</a> <a href="/pricing">more</a>' : '<a href="/">home</a>'}
</body>
</html>`;
}

const badHome = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<div class="menu"><a href="/dead">Dead link</a></div>
<img src="/logo.png">
<p>short</p>
</body>
</html>`;

const GOOD_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "SAMEORIGIN",
  "strict-transport-security": "max-age=31536000",
};

interface Recorded { url: string; options: SafeFetchOptions }

function fixtureFetcher(records: Recorded[]): WidgetFetcher {
  const ok = (url: string, body: string, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }): FetchOutcome =>
    ({ ok: true, status: 200, url, redirected: false, headers, body });

  return async (url, options) => {
    records.push({ url, options });
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "good.example") {
      if (parsed.pathname === "/robots.txt") {
        return ok(url, "User-agent: *\nAllow: /\nSitemap: https://good.example/sitemap.xml\n", { "content-type": "text/plain" });
      }
      if (parsed.pathname === "/sitemap.xml") {
        return ok(url, '<?xml version="1.0"?><urlset><loc>https://good.example/about</loc><loc>https://good.example/pricing</loc></urlset>', { "content-type": "application/xml" });
      }
      if (options.method === "HEAD") return ok(url, "", {});
      if (parsed.pathname === "/") return ok(url, goodPage("https://good.example/", "Good Example Home Page With A Proper Title"), GOOD_HEADERS);
      return ok(url, goodPage(url, "About The Good Example Company Team And Services"), GOOD_HEADERS);
    }
    if (host === "bad.example") {
      // The broken site has no TLS at all: everything over https fails at the socket.
      if (parsed.protocol === "https:") throw new Error("tls unavailable");
      if (parsed.pathname === "/robots.txt") return { ok: false, status: 404, url, redirected: false, headers: {}, body: "" };
      if (parsed.pathname === "/sitemap.xml") return { ok: false, status: 404, url, redirected: false, headers: {}, body: "" };
      if (options.method === "HEAD") return { ok: false, status: parsed.pathname === "/dead" ? 404 : 200, url, redirected: false, headers: {}, body: "" };
      if (parsed.pathname === "/dead") return { ok: false, status: 404, url, redirected: false, headers: {}, body: "" };
      return ok(url, badHome, { "content-type": "text/html; charset=utf-8" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

// ─── score & ordering (pure) ──────────────────────────────────────────────────

test("scoreFromFindings: 100 minus 12/5/1 per distinct finding, floored at 0", () => {
  assert.equal(scoreFromFindings([]), 100);
  assert.equal(scoreFromFindings([
    { code: "http_error", severity: "critical", category: "crawlability", evidence: "", pages: [] },
  ]), 88);
  assert.equal(scoreFromFindings([
    { code: "http_error", severity: "critical", category: "crawlability", evidence: "", pages: [] },
    { code: "title_missing", severity: "warning", category: "metadata", evidence: "", pages: [] },
  ]), 83);
  let score = 100;
  for (let i = 0; i < 20; i++) {
    // `w${i}` is a synthetic code — scoring only ever looks at severity, and the cast keeps
    // the fixture row inside RawFinding without polluting the FindingCode union.
    score = scoreFromFindings([
      ...Array.from({ length: 9 }, () => ({ code: "http_error" as const, severity: "critical" as const, category: "crawlability" as const, evidence: "", pages: [] })),
      { code: `w${i}` as FindingCode, severity: "warning" as const, category: "metadata" as const, evidence: "", pages: [] },
    ]);
  }
  assert.equal(score, 0);
});

test("topFindings orders critical before warning before info, stably", () => {
  const findings = [
    { code: "a", severity: "warning" as const },
    { code: "b", severity: "info" as const },
    { code: "c", severity: "critical" as const },
    { code: "d", severity: "warning" as const },
  ];
  assert.deepEqual(topFindings(findings, 3).map(f => f.code), ["c", "a", "d"]);
});

// ─── domain normalization ─────────────────────────────────────────────────────

test("normalizeAuditDomain accepts domains and pasted URLs, refuses junk and IP literals", () => {
  assert.equal(normalizeAuditDomain("Example.COM"), "example.com");
  assert.equal(normalizeAuditDomain("https://example.com/some/page"), "example.com");
  assert.throws(() => normalizeAuditDomain("localhost"), LiteAuditError);
  assert.throws(() => normalizeAuditDomain("8.8.8.8"), LiteAuditError);
  assert.throws(() => normalizeAuditDomain(""), LiteAuditError);
  assert.throws(() => normalizeAuditDomain("not a domain"), LiteAuditError);
});

// ─── the audit itself ─────────────────────────────────────────────────────────

test("a clean site scores 100 with no findings", async () => {
  const records: Recorded[] = [];
  const report = await runLiteAudit("good.example", { fetcher: fixtureFetcher(records) });
  assert.equal(report.score, 100);
  assert.deepEqual(report.findings, []);
  assert.equal(report.https, true);
  assert.equal(report.pagesChecked, 3); // home + 2 sitemap pages
});

test("every fetch carries allowPrivate: false and stays inside the audited origin", async () => {
  const records: Recorded[] = [];
  await runLiteAudit("good.example", { fetcher: fixtureFetcher(records) });
  assert.ok(records.length >= 6, `expected several fetches, got ${records.length}`);
  for (const record of records) {
    assert.equal(record.options.allowPrivate, false, `${record.url} must be fetched with allowPrivate: false`);
    assert.equal(new URL(record.url).hostname, "good.example");
  }
});

test("a broken site collects the expected findings and a low score", async () => {
  const records: Recorded[] = [];
  const report = await runLiteAudit("bad.example", { fetcher: fixtureFetcher(records) });
  const codes: string[] = report.findings.map(f => f.code);
  for (const expected of ["https_unavailable", "title_missing", "description_missing", "h1_missing", "viewport_missing", "lang_missing", "canonical_missing", "thin_content", "images_no_alt", "broken_links", "http_error", "security_headers_missing"]) {
    assert.ok(codes.includes(expected), `expected ${expected} in [${codes.join(", ")}]`);
  }
  assert.ok(report.score < 40, `score ${report.score} should be well below 40`);
  assert.equal(report.https, false);
  for (const record of records) {
    assert.equal(record.options.allowPrivate, false);
    assert.equal(new URL(record.url).hostname, "bad.example");
  }
});

test("an unreachable site throws unreachable, not a half-report", async () => {
  const fetcher: WidgetFetcher = async () => { throw new Error("network down"); };
  await assert.rejects(() => runLiteAudit("down.example", { fetcher }), (error: unknown) =>
    error instanceof LiteAuditError && error.code === "unreachable");
});

test("evidence is language-neutral: numbers, limits and paths only", async () => {
  const records: Recorded[] = [];
  const report = await runLiteAudit("bad.example", { fetcher: fixtureFetcher(records) });
  const broken = report.findings.find(f => f.code === "broken_links");
  assert.ok(broken);
  assert.match(broken.evidence, /^1 · \/dead/);
  const title = report.findings.find(f => f.code === "title_missing");
  assert.ok(title);
  assert.ok(title.pages.includes("/"));
});
