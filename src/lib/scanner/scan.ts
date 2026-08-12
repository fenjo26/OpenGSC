import "server-only";
import { promises as dns } from "node:dns";
import { extractAuditHtml, missingSecurityHeaders, robotsDirectivesConflict, type AuditHtmlSignals } from "@/lib/audit/pageSignals";
import { evaluateAuditPageRules, type AuditPageFacts } from "@/lib/audit/rules";
import { diffViews, followChain, type CloakingDiff, type ViewResult } from "@/lib/seo/googlebot";
import { safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import { extractFingerprints, flattenFingerprints, type Fingerprints } from "./fingerprints";
import { detectPlatform, wordpressAssets, type PlatformReport } from "./platform";

/**
 * A single-request X-ray of any domain, built for looking at other people's sites.
 *
 * It is not a crawler and does not pretend to be one: one page, plus the handful of well-known
 * paths every site publishes anyway (robots.txt, sitemap, llms.txt). That bound is the design —
 * a competitor has not invited us to walk their site, and everything worth knowing early is
 * visible from the front door.
 *
 * The same rule registry as Site Audit judges the page, so a finding means the same thing whether
 * it came from your own crawl or from a scan of somebody else's homepage.
 */

const UA = "Mozilla/5.0 (compatible; OpenGSC-Scanner/1.0; +https://opengsc.org)";
const HTML_BYTES = 3 * 1024 * 1024;
const PROBE_TIMEOUT = 8_000;

export interface ScanFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  evidence?: string;
}

export interface ScanReport {
  url: string;
  finalUrl: string;
  host: string;
  https: boolean;
  httpStatus: number;
  redirected: boolean;
  loadMs: number;
  bytes: number;
  facts: {
    title: string; titleLength: number; metaDescription: string; h1Count: number;
    wordCount: number; canonical: string | null; robots: string; indexable: boolean | null;
    schemaBlocks: number; imagesNoAlt: number; language: string;
  };
  findings: ScanFinding[];
  score: number;
  platform: PlatformReport & { wordpress?: { themes: string[]; plugins: string[]; restUsers: string[]; xmlrpc: boolean; readme: boolean } };
  infra: { ips: string[]; nameservers: string[]; mx: string[]; cdn: string | null };
  scale: { sitemaps: string[]; sitemapUrls: number | null; languages: string[] };
  ai: { robotsTxt: boolean; llmsTxt: boolean; blockedBots: string[] };
  /**
   * What the site shows Googlebot versus a browser. A doorway that cloaks by User-Agent looks
   * perfectly ordinary to a scanner that only ever identifies as itself, which is exactly the case
   * this fills: the same comparison Googlebot View runs, folded into every scan.
   */
  cloaking: {
    verdict: CloakingDiff["verdict"];
    score: number;
    flags: string[];
    googlebot: { status: number; finalUrl: string; title: string; words: number; indexable: boolean; blocked?: boolean };
    browser: { status: number; finalUrl: string; title: string; words: number; indexable: boolean };
    redirectChain: string[];
  } | null;
  fingerprints: Fingerprints;
  fingerprintKeys: string[];
  scannedAt: string;
}

export function normalizeScanTarget(input: string): URL {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("missing_url");
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  url.hash = "";
  if (!url.hostname.includes(".")) throw new Error("invalid_url");
  return url;
}

export function scanHost(url: URL | string): string {
  const host = (typeof url === "string" ? url : url.hostname).toLowerCase();
  return host.replace(/^www\./, "");
}

async function fetchText(target: string, maxBytes = 512 * 1024): Promise<{ ok: boolean; status: number; text: string; headers: Record<string, string> }> {
  try {
    const res = await safeFetch(target, { headers: { "User-Agent": UA }, redirect: "follow", timeoutMs: PROBE_TIMEOUT, maxBytes });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : "", headers };
  } catch {
    return { ok: false, status: 0, text: "", headers: {} };
  }
}

/** Bot tokens OpenGSC reports on elsewhere, so the two screens agree on what "blocked" means. */
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "PerplexityBot", "ClaudeBot", "Google-Extended", "CCBot", "Bytespider"];

function blockedBots(robotsTxt: string): string[] {
  const blocked: string[] = [];
  const blocks = robotsTxt.split(/\n(?=\s*user-agent:)/i);
  for (const bot of AI_BOTS) {
    const block = blocks.find(b => new RegExp(`user-agent:\\s*${bot}\\b`, "i").test(b));
    const wildcard = blocks.find(b => /user-agent:\s*\*/i.test(b));
    const scope = block ?? wildcard;
    if (scope && /disallow:\s*\/\s*$/im.test(scope)) blocked.push(bot);
  }
  return blocked;
}

async function infrastructure(hostname: string) {
  const settle = async <T>(work: Promise<T>, fallback: T): Promise<T> => work.catch(() => fallback);
  const [ips, ipv6, ns, mx] = await Promise.all([
    settle(dns.resolve4(hostname), [] as string[]),
    settle(dns.resolve6(hostname), [] as string[]),
    settle(dns.resolveNs(hostname), [] as string[]),
    settle(dns.resolveMx(hostname), [] as { exchange: string; priority: number }[]),
  ]);
  return {
    ips: [...ips, ...ipv6].slice(0, 6),
    nameservers: ns.map(n => n.toLowerCase()).slice(0, 6),
    mx: mx.sort((a, b) => a.priority - b.priority).map(m => m.exchange.toLowerCase()).slice(0, 4),
  };
}

function cdnFrom(headers: Record<string, string>): string | null {
  if (headers["cf-ray"] || /cloudflare/i.test(headers["server"] ?? "")) return "Cloudflare";
  if (headers["x-vercel-id"]) return "Vercel";
  if (headers["x-amz-cf-id"]) return "CloudFront";
  if (/fastly/i.test(headers["x-served-by"] ?? headers["via"] ?? "")) return "Fastly";
  if (headers["x-nf-request-id"]) return "Netlify";
  return null;
}

function scoreFrom(findings: ScanFinding[]): number {
  const weight = { critical: 12, warning: 5, info: 1 } as const;
  const penalty = findings.reduce((total, f) => total + weight[f.severity], 0);
  return Math.max(0, 100 - Math.min(100, penalty));
}

const SEVERITY: Record<string, ScanFinding["severity"]> = {
  http_error: "critical", fetch_failed: "critical", redirect_loop: "critical", noindex: "critical",
  mixed_content: "critical", canonical_invalid: "critical", robots_conflict: "critical",
  title_missing: "warning", description_missing: "warning", h1_missing: "warning",
  redirect_chain: "warning", canonical_missing: "warning", canonical_mismatch: "warning",
  security_headers_missing: "warning", viewport_missing: "warning", thin_content: "warning",
  jsonld_invalid: "warning", slow_response: "warning",
};

export async function runScan(input: string): Promise<ScanReport> {
  const requested = normalizeScanTarget(input);
  const started = Date.now();

  let response;
  let https = true;
  try {
    response = await safeFetch(requested, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, redirect: "follow", timeoutMs: 15_000, maxBytes: HTML_BYTES });
  } catch (error) {
    // A site that refuses https is a finding, not a dead end — retry once over http and say so.
    const fallback = new URL(requested); fallback.protocol = "http:";
    https = false;
    try {
      response = await safeFetch(fallback, { headers: { "User-Agent": UA }, redirect: "follow", timeoutMs: 15_000, maxBytes: HTML_BYTES });
    } catch {
      throw new Error(error instanceof SafeFetchError ? error.code : "unreachable");
    }
  }

  const loadMs = Date.now() - started;
  const finalUrl = new URL(response.url);
  https = https && finalUrl.protocol === "https:";
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  const html = (headers["content-type"] ?? "").includes("html") || !headers["content-type"] ? await response.text() : "";
  const signals: AuditHtmlSignals | null = html ? extractAuditHtml(html) : null;

  const origin = finalUrl.origin;
  const [robots, llms, platformProbes] = await Promise.all([
    fetchText(`${origin}/robots.txt`, 256 * 1024),
    fetchText(`${origin}/llms.txt`, 128 * 1024),
    // Only asked for when the page already looks like WordPress, so an unrelated site is not probed
    // with paths that mean nothing to it.
    /wp-content|wp-includes|wp-json/i.test(html)
      ? Promise.all([
          fetchText(`${origin}/wp-json/wp/v2/users`, 64 * 1024),
          fetchText(`${origin}/xmlrpc.php`, 8 * 1024),
          fetchText(`${origin}/readme.html`, 32 * 1024),
        ])
      : Promise.resolve(null),
  ]);

  const sitemaps = [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]).slice(0, 5);
  const primarySitemap = sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sitemapBody = await fetchText(primarySitemap, 2 * 1024 * 1024);
  const sitemapUrls = sitemapBody.ok ? (sitemapBody.text.match(/<loc>/g) ?? []).length : null;

  const robotsMeta = [signals?.robots ?? "", headers["x-robots-tag"] ?? ""].filter(Boolean).join(", ").toLowerCase();
  const security = missingSecurityHeaders(headers, https);
  const canonical = signals?.canonical?.trim() || null;

  const facts: AuditPageFacts = {
    hasHtml: !!signals, isRoot: true, isHttps: https, httpStatus: response.status, loadMs,
    redirectHops: response.redirected ? 1 : 0, redirectLoop: false,
    title: signals?.title ?? "", titleDuplicate: false, metaDescription: signals?.metaDesc ?? "",
    robots: robotsMeta, robotsConflict: robotsDirectivesConflict(robotsMeta),
    canonical, canonicalInvalid: !!canonical && !/^https?:\/\//i.test(canonical),
    canonicalMismatch: !!canonical && (() => { try { return new URL(canonical).href.replace(/\/$/, "") !== finalUrl.href.replace(/\/$/, ""); } catch { return false; } })(),
    h1Count: signals?.h1Count ?? 0, wordCount: signals?.wordCount ?? 0, imagesNoAlt: signals?.imagesNoAlt ?? 0,
    brokenLinkCount: 0, jsRendered: false,
    viewportPresent: signals?.viewportPresent ?? false, htmlLang: signals?.htmlLang ?? "",
    jsonLdInvalid: signals?.jsonLdInvalid ?? 0,
    organizationSchemaIncomplete: signals?.organizationSchemaIncomplete ?? false,
    openGraphMissing: signals?.openGraphMissing.length ?? 0,
    twitterCardIncomplete: signals?.twitterCardIncomplete ?? false,
    mixedContentCount: signals?.mixedContentUrls.length ?? 0,
    missingSecurityHeaders: security.length,
    sitemapSeeded: false, internalInboundLinks: 1,
  };

  const findings: ScanFinding[] = evaluateAuditPageRules(facts).map(id => ({
    id,
    severity: SEVERITY[id] ?? "info",
    evidence: id === "security_headers_missing" ? security.join(", ")
      : id === "open_graph_incomplete" ? (signals?.openGraphMissing ?? []).join(", ")
      : id === "twitter_card_incomplete" ? (signals?.twitterCardMissing ?? []).join(", ")
      : id === "mixed_content" ? (signals?.mixedContentUrls ?? []).slice(0, 3).join(", ")
      : id === "thin_content" ? `${facts.wordCount} words`
      : id === "slow_response" ? `${loadMs} ms`
      : undefined,
  }));

  if (!https) findings.unshift({ id: "https_unavailable", severity: "critical" });
  if (!robots.ok) findings.push({ id: "robots_txt_missing", severity: "warning" });
  if (!sitemapBody.ok) findings.push({ id: "sitemap_missing", severity: "warning", evidence: primarySitemap });

  const wpProbes = platformProbes;
  let wordpress: ScanReport["platform"]["wordpress"];
  if (wpProbes) {
    const [users, xmlrpc, readme] = wpProbes;
    const restUsers: string[] = users.ok
      ? [...users.text.matchAll(/"slug"\s*:\s*"([^"]{1,40})"/g)].map(m => m[1]).slice(0, 10)
      : [];
    wordpress = { ...wordpressAssets(html), restUsers, xmlrpc: xmlrpc.status === 405 || xmlrpc.ok, readme: readme.ok };
    if (restUsers.length) findings.push({ id: "wp_users_exposed", severity: "warning", evidence: restUsers.join(", ") });
    if (wordpress.xmlrpc) findings.push({ id: "wp_xmlrpc_open", severity: "info" });
    if (wordpress.readme) findings.push({ id: "wp_readme_public", severity: "info" });
  }

  const infra = await infrastructure(finalUrl.hostname);
  const cdn = cdnFrom(headers);

  // Two more fetches: one as Googlebot Smartphone carrying a Google referer, one as a plain
  // browser. A UA-cloaked doorway serves different content to each, and comparing them is the only
  // way to see it from outside. Failures here degrade the scan rather than fail it — plenty of
  // sites simply block anything claiming to be a bot, which is itself worth reporting.
  let cloaking: ScanReport["cloaking"] = null;
  try {
    const [asGooglebot, asBrowser] = await Promise.all([
      followChain(finalUrl.href, "gbMobile", { referer: true }),
      followChain(finalUrl.href, "chrome"),
    ]);
    if (asGooglebot.ok || asBrowser.ok) {
      const diff = diffViews(asGooglebot, asBrowser);
      const view = (v: ViewResult) => ({
        status: v.finalStatus, finalUrl: v.finalUrl, title: v.signals.title ?? "",
        words: v.wordCount, indexable: v.signals.indexable,
      });
      cloaking = {
        verdict: diff.verdict, score: diff.score, flags: diff.flags,
        googlebot: { ...view(asGooglebot), blocked: asGooglebot.blocked },
        browser: view(asBrowser),
        redirectChain: asGooglebot.hops.map(hop => `${hop.status} ${hop.url}`).slice(0, 10),
      };
      if (diff.verdict === "cloaking") findings.unshift({ id: "cloaking_detected", severity: "critical", evidence: diff.flags.slice(0, 4).join("; ") });
      else if (diff.verdict === "suspicious") findings.push({ id: "cloaking_suspected", severity: "warning", evidence: diff.flags.slice(0, 4).join("; ") });
      if (asGooglebot.blocked) findings.push({ id: "googlebot_blocked", severity: "warning", evidence: `HTTP ${asGooglebot.finalStatus}` });
    }
  } catch { /* the comparison is an enrichment, not a precondition */ }
  const fingerprints = extractFingerprints(html);
  const languages = [...new Set((html.match(/hreflang=["']([a-z-]{2,7})["']/gi) ?? [])
    .map(m => m.replace(/.*=["']/, "").replace(/["']/, "").toLowerCase()))].slice(0, 12);

  return {
    url: requested.href,
    finalUrl: finalUrl.href,
    host: scanHost(finalUrl),
    https,
    httpStatus: response.status,
    redirected: response.redirected,
    loadMs,
    bytes: response.byteLength,
    facts: {
      title: facts.title, titleLength: facts.title.length, metaDescription: facts.metaDescription,
      h1Count: facts.h1Count, wordCount: facts.wordCount, canonical, robots: robotsMeta,
      indexable: signals ? !/noindex/.test(robotsMeta) : null,
      schemaBlocks: signals?.jsonLdCount ?? 0, imagesNoAlt: facts.imagesNoAlt, language: facts.htmlLang,
    },
    findings,
    score: scoreFrom(findings),
    platform: { ...detectPlatform(html, headers), ...(wordpress ? { wordpress } : {}) },
    infra: { ...infra, cdn },
    scale: { sitemaps: sitemaps.length ? sitemaps : [primarySitemap], sitemapUrls, languages },
    ai: { robotsTxt: robots.ok, llmsTxt: llms.ok, blockedBots: robots.ok ? blockedBots(robots.text) : [] },
    cloaking,
    fingerprints,
    fingerprintKeys: flattenFingerprints(fingerprints, { ns: infra.nameservers, ips: infra.ips, behindCdn: !!cdn }),
    scannedAt: new Date().toISOString(),
  };
}
