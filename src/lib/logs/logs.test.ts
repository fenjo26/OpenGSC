import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { parseAccessLine } from "./parse";
import { classifyUserAgent } from "./bots";
import { LogAggregator, logPathKey, type IpVerdict } from "./aggregate";
import { hostnameMatches } from "./verify";
import { summarizeLogFile } from "./file";

const GB = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const line = (ip: string, when: string, req: string, status: number, ua: string) =>
  `${ip} - - [${when} +0300] "${req}" ${status} 1234 "-" "${ua}"`;

test("combined, common and vhost_combined lines parse; garbage does not", () => {
  const a = parseAccessLine(line("66.249.66.1", "18/Oct/2026:10:00:00", "GET /tours/?lang=el HTTP/1.1", 200, GB))!;
  assert.equal(a.ip, "66.249.66.1");
  assert.equal(a.path, "/tours/?lang=el");
  assert.equal(a.status, 200);
  assert.equal(a.time.toISOString(), "2026-10-18T07:00:00.000Z");
  assert.match(a.ua!, /Googlebot/);
  const common = parseAccessLine(`1.2.3.4 - - [18/Oct/2026:10:00:00 +0000] "GET / HTTP/1.1" 404 10`)!;
  assert.equal(common.status, 404);
  assert.equal(common.ua, null);
  const vhost = parseAccessLine(`x.gr:443 2001:db8::1 - - [18/Oct/2026:10:00:00 +0000] "GET https://x.gr/a?b=1 HTTP/2.0" 301 0 "-" "curl/8"`)!;
  assert.equal(vhost.host, "x.gr");
  assert.equal(vhost.ip, "2001:db8::1");
  assert.equal(vhost.path, "/a?b=1");
  for (const bad of ["", "hello world", `1.2.3.4 - - [not a date] "GET / HTTP/1.1" 200 1`, `1.2.3.4 - - [18/Oct/2026:10:00:00 +0000] "\\x16\\x03" 400 0`]) {
    assert.equal(parseAccessLine(bad), null, bad);
  }
});

test("user agents map to the family they claim", () => {
  assert.equal(classifyUserAgent(GB)?.id, "google");
  assert.equal(classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0)")?.id, "bing");
  assert.equal(classifyUserAgent("Mozilla/5.0 (compatible; YandexBot/3.0)")?.id, "yandex");
  assert.equal(classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36; compatible; GPTBot/1.2")?.kind, "ai");
  assert.equal(classifyUserAgent("ClaudeBot/1.0")?.id, "claude");
  assert.equal(classifyUserAgent("Mozilla/5.0 (compatible; AhrefsBot/7.0)")?.kind, "seo");
  assert.equal(classifyUserAgent("python-requests/2.31")?.id, "other");
  assert.equal(classifyUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36"), null);
  assert.equal(classifyUserAgent(null), null);
});

test("reverse-DNS hostnames must end in the crawler's own domain", () => {
  assert.equal(hostnameMatches("crawl-66-249-66-1.googlebot.com.", ["googlebot.com", "google.com"]), true);
  assert.equal(hostnameMatches("rate-limited-proxy-66-249-90-77.google.com", ["googlebot.com", "google.com"]), true);
  assert.equal(hostnameMatches("googlebot.com.evil.net", ["googlebot.com"]), false);
  assert.equal(hostnameMatches("notgooglebot.com", ["googlebot.com"]), false);
});

test("fake Googlebots drop out of every Googlebot figure; unknowns stay in", () => {
  const agg = new LogAggregator();
  const day = (d: number) => `${String(d).padStart(2, "0")}/Oct/2026:12:00:00`;
  for (let d = 1; d <= 8; d++) agg.add(parseAccessLine(line("66.249.66.1", day(d), "GET /tours HTTP/1.1", 200, GB)));
  agg.add(parseAccessLine(line("66.249.66.1", day(8), "GET /old HTTP/1.1", 404, GB)));
  agg.add(parseAccessLine(line("66.249.66.2", day(8), "GET /tours/ HTTP/1.1", 200, GB)));
  for (let i = 0; i < 5; i++) agg.add(parseAccessLine(line("5.6.7.8", day(3), "GET /wp-login.php HTTP/1.1", 404, GB)));
  agg.add(parseAccessLine(line("9.9.9.9", day(4), "GET / HTTP/1.1", 200, "Mozilla/5.0 Chrome/120")));
  agg.add(parseAccessLine(line("9.9.9.10", day(4), "GET /robots.txt HTTP/1.1", 200, "GPTBot/1.2")));
  agg.add(null);

  assert.deepEqual(agg.ipsToVerify().map(x => x.ip), ["66.249.66.1", "5.6.7.8", "66.249.66.2"]);
  const verdicts = new Map<string, IpVerdict>([["66.249.66.1", "verified"], ["5.6.7.8", "fake"]]);
  const s = agg.finalize(verdicts);
  assert.equal(s.lines, 18);
  assert.equal(s.skipped, 1);
  assert.equal(s.humanHits, 1);
  assert.equal(s.days, 8);
  const google = s.families.find(f => f.id === "google")!;
  assert.deepEqual([google.hits, google.verified, google.fake, google.unverified], [15, 9, 5, 1]);
  assert.equal(s.google.hits, 10);
  assert.equal(s.google.statuses["4xx"], 1, "the fake bot's 404s are not Googlebot's");
  assert.equal(s.google.paths["/tours"], 8);
  assert.equal(s.google.paths["/tours/"], 1);
  assert.equal(s.google.paths["/wp-login.php"], undefined);
  assert.deepEqual(s.google.errorPaths, [{ path: "/old", hits: 1, status: 404 }]);
  assert.deepEqual(s.fakeIps, [{ ip: "5.6.7.8", family: "google", hits: 5 }]);
  assert.equal(s.families.find(f => f.id === "gptbot")?.hits, 1);
  assert.equal(s.families[0].kind, "search");
});

test("log path keys match the audit's view of a URL", () => {
  assert.equal(logPathKey("/tours/"), "/tours");
  assert.equal(logPathKey("/"), "/");
  assert.equal(logPathKey("/a/?x=1"), "/a?x=1");
  assert.equal(logPathKey("https://x.gr/a/b/"), "/a/b");
  assert.equal(logPathKey("/%CF%84%CE%B1%CE%BE%CE%AF"), "/ταξί");
});

test("a gzip log file streams through the same pipeline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ogsc-log-"));
  const file = path.join(dir, "access.log.gz");
  const body = [
    line("66.249.66.1", "20/Oct/2026:09:00:00", "GET / HTTP/1.1", 200, GB),
    line("66.249.66.1", "21/Oct/2026:09:00:00", "GET /contact HTTP/1.1", 301, GB),
    "garbage line",
  ].join("\n");
  fs.writeFileSync(file, zlib.gzipSync(body));
  const summary = await summarizeLogFile(file, async ips => ({ verdicts: new Map(ips.map(i => [i.ip, "verified" as IpVerdict])), dnsAvailable: true }));
  assert.equal(summary.parsed, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.google.hits, 2);
  assert.equal(summary.google.statuses["3xx"], 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit: an indexable page Googlebot never requested is flagged only when the log can tell", async () => {
  const { evaluateAuditPageRules, AUDIT_RULE_BY_ID } = await import("@/lib/audit/rules");
  const base = {
    hasHtml: true, isRoot: false, isHttps: true, httpStatus: 200, loadMs: 120, redirectHops: 0, redirectLoop: false,
    title: "A useful page title long enough to pass every metadata check", titleDuplicate: false,
    metaDescription: "A concise description of this useful page, long enough to sit inside the healthy 150 to 165 character band without ever triggering a metadata length rule.",
    robots: "index, follow", robotsConflict: false, canonical: "https://x.gr/a", canonicalInvalid: false, canonicalMismatch: false,
    h1Count: 1, h1Text: "A useful page", wordCount: 500, imagesNoAlt: 0, brokenLinkCount: 0, jsRendered: false,
    viewportPresent: true, viewportResponsive: true, htmlLang: "en", jsonLdInvalid: 0, organizationSchemaIncomplete: false,
    openGraphMissing: 0, twitterCardIncomplete: false, mixedContentCount: 0, missingSecurityHeaders: 0,
    sitemapSeeded: false, internalInboundLinks: 2,
  };
  assert.deepEqual(evaluateAuditPageRules({ ...base, googlebotVisits: 0 }), ["no_googlebot_visits"]);
  assert.deepEqual(evaluateAuditPageRules({ ...base, googlebotVisits: 3 }), []);
  assert.deepEqual(evaluateAuditPageRules({ ...base }), [], "no usable log, no verdict");
  assert.deepEqual(evaluateAuditPageRules({ ...base, googlebotVisits: 0, robots: "noindex" }).includes("no_googlebot_visits"), false);
  assert.equal(AUDIT_RULE_BY_ID.get("no_googlebot_visits")?.affectsScore, false);
});

test("with DNS unavailable, nothing is called fake", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ogsc-log-"));
  const file = path.join(dir, "access.log");
  fs.writeFileSync(file, line("66.249.66.1", "20/Oct/2026:09:00:00", "GET / HTTP/1.1", 200, GB));
  const summary = await summarizeLogFile(file, async () => ({ verdicts: new Map(), dnsAvailable: false }));
  assert.equal(summary.dnsAvailable, false);
  assert.equal(summary.google.hits, 1);
  assert.equal(summary.families.find(f => f.id === "google")?.unverified, 1);
  assert.equal(summary.fakeIps.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
