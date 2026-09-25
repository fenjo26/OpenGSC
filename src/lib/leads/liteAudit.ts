// N9 — the PUBLIC lite audit behind the embeddable widget.
//
// Bounds are the security contract of this contour (CONTRACT.md §0.6, N9 brief):
//   • every outbound request goes through the injected fetcher, whose production
//     implementation is `widgetFetch` — safeFetch with `allowPrivate: false` pinned, so
//     the instance-wide OPENGSC_ALLOW_PRIVATE_TARGETS opt-in can never leak in here;
//   • home page + at most 4 more pages, ≤ 2 MB per page, 25 s wall clock overall;
//   • ≤ 30 HEAD requests for broken links on the home page;
//   • no GSC, no owner sites, no API keys — page fetching is the only thing it does.
//
// Page parsing and the rule registry are REUSED from the runtime Site Audit
// (src/lib/audit/pageSignals.ts, rules.ts — import only), so a finding means the same
// thing here as in the operator's own crawl. PSI is deliberately NOT called: the brief
// allowed one query with the owner's key, but CONTRACT §0.6 forbids the public contour
// from reading the owner's keys, and the stricter document wins (see docs/LEADS.md).

import { extractAuditHtml, missingSecurityHeaders, robotsDirectivesConflict, type AuditHtmlSignals } from "@/lib/audit/pageSignals";
import { evaluateAuditPageRules, type AuditPageFacts } from "@/lib/audit/rules";
import { safeFetch, type SafeFetchOptions } from "@/lib/security/safeFetch";
import { META_LIMITS, metaLength } from "@/lib/seo/metaLimits";
import type { FindingCategory, FindingCode, FindingSeverity, LiteAuditReport, RawFinding } from "./types";

export const WIDGET_UA = "Mozilla/5.0 (compatible; OpenGSC-Widget/1.0; +https://opengsc.org)";
export const MAX_PAGES = 5;                // home + 4
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const TOTAL_BUDGET_MS = 25_000;
export const HEAD_CHECK_LIMIT = 30;
const HEAD_BATCH = 5;
const HOPS_LIMIT = 5;

// ─── injectable transport ─────────────────────────────────────────────────────

export interface FetchOutcome {
  ok: boolean;
  status: number;
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  body: string;
}

export type WidgetFetcher = (url: string, options: SafeFetchOptions) => Promise<FetchOutcome>;

/**
 * The production transport. `allowPrivate: false` is written out here, not inherited: this
 * contour is reachable by anonymous visitors, so the SSRF guard must hold even on an
 * instance whose operator enabled private targets for their own audits.
 */
export const widgetFetch: WidgetFetcher = async (url, options) => {
  const res = await safeFetch(url, { ...options, allowPrivate: false });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return {
    ok: res.ok, status: res.status, url: res.url, redirected: res.redirected,
    headers, body: await res.text(),
  };
};

export class LiteAuditError extends Error {
  constructor(public readonly code: "invalid_domain" | "unreachable") { super(code); }
}

export function normalizeAuditDomain(input: string): string {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) throw new LiteAuditError("invalid_domain");
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    throw new LiteAuditError("invalid_domain");
  }
  if (!host.includes(".") || /^[0-9.]+$/.test(host) || host.includes(":")) {
    throw new LiteAuditError("invalid_domain");
  }
  return host;
}

// ─── severities / categories (kept in step with the audit registry) ───────────

const SEVERITY: Record<FindingCode, FindingSeverity> = {
  https_unavailable: "critical",
  http_error: "critical",
  fetch_failed: "critical",
  noindex: "critical",
  broken_links: "critical",
  redirect: "warning",
  redirect_chain: "warning",
  title_missing: "warning", title_too_long: "warning", title_too_short: "warning",
  description_missing: "warning", description_too_long: "warning", description_too_short: "warning",
  h1_missing: "warning", h1_multiple: "warning",
  canonical_missing: "warning",
  viewport_missing: "warning", viewport_not_responsive: "warning",
  jsonld_invalid: "warning",
  security_headers_missing: "warning",
  slow_response: "warning",
  mixed_content: "warning",
  thin_content: "warning",
  images_no_alt: "warning",
  lang_missing: "info",
  open_graph_incomplete: "info",
};

const CATEGORY: Record<FindingCode, FindingCategory> = {
  https_unavailable: "security",
  http_error: "crawlability",
  fetch_failed: "crawlability",
  redirect: "crawlability",
  redirect_chain: "crawlability",
  noindex: "crawlability",
  title_missing: "metadata", title_too_long: "metadata", title_too_short: "metadata",
  description_missing: "metadata", description_too_long: "metadata", description_too_short: "metadata",
  canonical_missing: "metadata",
  jsonld_invalid: "metadata",
  open_graph_incomplete: "metadata",
  h1_missing: "content", h1_multiple: "content", thin_content: "content", lang_missing: "content",
  images_no_alt: "content",
  broken_links: "links",
  slow_response: "performance",
  viewport_missing: "rendering", viewport_not_responsive: "rendering",
  security_headers_missing: "security", mixed_content: "security",
};

/** Rule ids from the audit registry this contour reports; everything else is ignored. */
const KEPT_RULE_IDS = new Set<string>([
  "http_error", "fetch_failed", "redirect", "redirect_chain",
  "title_missing", "title_too_long", "title_too_short",
  "description_missing", "description_too_long", "description_too_short",
  "h1_missing", "h1_multiple", "noindex", "canonical_missing",
  "thin_content", "images_no_alt", "broken_links", "slow_response",
  "viewport_missing", "viewport_not_responsive", "lang_missing",
  "jsonld_invalid", "open_graph_incomplete", "mixed_content", "security_headers_missing",
]);

// The pure helpers moved to ./findings — client components import them without pulling
// safeFetch (and its node:dns) into the browser bundle. Re-exported here so the existing
// server-side importers (routes, store, the barrel) keep their import paths.
export { SEVERITY_WEIGHT, SEVERITY_RANK, scoreFromFindings, topFindings } from "./findings";
import { scoreFromFindings, topFindings } from "./findings";

// ─── evidence builders (language-neutral: numbers, limits, paths) ─────────────

const path = (url: string): string => {
  try { return new URL(url).pathname || "/"; } catch { return url; }
};
const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const joinPages = (pages: string[]): string => pages.slice(0, 5).join(", ");

// ─── the audit ─────────────────────────────────────────────────────────────────

interface PageCheck {
  url: string;
  status: number;        // 0 = network failure
  loadMs: number;
  https: boolean;
  hops: number;
  signals: AuditHtmlSignals | null;
  headers: Record<string, string>;
}

function looksHtml(url: string): boolean {
  return !/\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|pdf|zip|gz|mp[34]|webm|wav|ogg|woff2?|ttf|eot)(\?|#|$)/i.test(url);
}

/** Options of the bounded fetch below: SafeFetchOptions' subset plus our Accept flavour. */
interface TimedFetchOpts {
  method?: "GET" | "HEAD";
  redirect?: "follow" | "manual";
  timeoutMs?: number;
  maxBytes?: number;
  /** Composed into the Accept header — SafeFetchOptions itself has no headers field. */
  accept?: string;
}

async function timedFetch(fetcher: WidgetFetcher, url: string, deadline: number, opts: TimedFetchOpts = {}): Promise<FetchOutcome> {
  const remaining = deadline - Date.now();
  if (remaining <= 1_500) throw new LiteAuditError("unreachable");
  return fetcher(url, {
    method: opts.method ?? "GET",
    redirect: opts.redirect ?? "follow",
    timeoutMs: Math.min(opts.timeoutMs ?? 8_000, remaining),
    maxBytes: opts.maxBytes ?? PAGE_MAX_BYTES,
    headers: { "User-Agent": WIDGET_UA, Accept: opts.accept ?? "text/html,application/xhtml+xml,*/*" },
    allowPrivate: false, // pinned on every call; tests assert this via the injected fetcher
  });
}

function toPageCheck(outcome: FetchOutcome, started: number, hops: number): PageCheck {
  const contentType = outcome.headers["content-type"] ?? "";
  const html = contentType.includes("html") || !contentType ? outcome.body : "";
  return {
    url: outcome.url,
    status: outcome.status,
    loadMs: Date.now() - started,
    https: outcome.url.startsWith("https:"),
    hops,
    signals: html ? extractAuditHtml(html) : null,
    headers: outcome.headers,
  };
}

/** Home page with manual redirect following, so the chain itself is observable. */
async function fetchHome(fetcher: WidgetFetcher, startUrl: string, deadline: number): Promise<PageCheck> {
  const started = Date.now();
  const visited = new Set<string>();
  let current = startUrl;
  let hops = 0;
  while (true) {
    if (visited.has(current)) throw new LiteAuditError("unreachable"); // loop — safeFetch would loop too
    visited.add(current);
    let outcome: FetchOutcome;
    try {
      // Hop pages are fetched small: a 3xx body is junk, and the byte cap doubles as a cheap
      // guard while we are only interested in the status and the Location header.
      outcome = await timedFetch(fetcher, current, deadline, { redirect: "manual", maxBytes: 64 * 1024 });
    } catch {
      throw new LiteAuditError("unreachable");
    }
    const location = outcome.headers["location"];
    const isRedirect = outcome.status >= 300 && outcome.status < 400 && outcome.status !== 304 && Boolean(location);
    if (!isRedirect) {
      // The final target deserves the full page budget — the hop-sized cap above must not
      // truncate a real page, so it is fetched once more at full size.
      if (hops > 0) {
        try {
          outcome = await timedFetch(fetcher, current, deadline);
        } catch { /* keep the small-fetch version rather than failing the audit */ }
      }
      return toPageCheck(outcome, started, hops);
    }
    hops++;
    if (hops > HOPS_LIMIT) throw new LiteAuditError("unreachable");
    try {
      current = new URL(location!, current).href;
    } catch {
      throw new LiteAuditError("unreachable");
    }
  }
}

/** Up to 4 URLs: the sitemap (robots.txt → sitemap.xml, one index level deep) else main-menu links. */
async function pickExtraPages(
  fetcher: WidgetFetcher, home: PageCheck, homeUrl: URL, deadline: number,
): Promise<string[]> {
  const origin = homeUrl.origin;
  const candidates: string[] = [];

  const robots = await timedFetch(fetcher, `${origin}/robots.txt`, deadline, { timeoutMs: 5_000, maxBytes: 128 * 1024, accept: "text/plain,*/*" })
    .catch(() => null);
  const sitemapLines = robots && robots.ok
    ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]).slice(0, 3)
    : [];
  const sitemapUrls = sitemapLines.length ? sitemapLines : [`${origin}/sitemap.xml`];

  for (const sitemapUrl of sitemapUrls) {
    if (candidates.length) break;
    let doc = await timedFetch(fetcher, sitemapUrl, deadline, { timeoutMs: 8_000, maxBytes: 1024 * 1024, accept: "application/xml,text/xml,*/*" }).catch(() => null);
    if (!doc || !doc.ok) continue;
    // A sitemap index: go one level into the first child.
    if (/<sitemapindex/i.test(doc.body.slice(0, 2000))) {
      const child = doc.body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
      if (!child) continue;
      doc = await timedFetch(fetcher, child, deadline, { timeoutMs: 8_000, maxBytes: 1024 * 1024, accept: "application/xml,text/xml,*/*" }).catch(() => null);
      if (!doc || !doc.ok) continue;
    }
    const homePath = `${homeUrl.pathname}${homeUrl.search}`;
    for (const match of doc.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      if (candidates.length >= MAX_PAGES - 1) break;
      try {
        const url = new URL(match[1]);
        if (url.origin !== origin) continue;
        if (`${url.pathname}${url.search}` === homePath) continue;
        if (!looksHtml(url.pathname)) continue;
        candidates.push(url.href);
      } catch { /* malformed <loc> — skip it */ }
    }
  }

  if (!candidates.length) {
    // Main menu / internal links off the home page.
    const homePath = `${homeUrl.pathname}${homeUrl.search}`;
    for (const href of home.signals?.hrefs ?? []) {
      if (candidates.length >= MAX_PAGES - 1) break;
      let url: URL;
      try {
        url = new URL(href, home.url);
      } catch { continue; }
      if (url.origin !== origin) continue;
      if (`${url.pathname}${url.search}` === homePath) continue;
      if (!looksHtml(url.pathname)) continue;
      candidates.push(url.href);
    }
  }
  return [...new Set(candidates)].slice(0, MAX_PAGES - 1);
}

function sameSiteLinks(home: PageCheck): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const href of home.signals?.hrefs ?? []) {
    if (out.length >= HEAD_CHECK_LIMIT) break;
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, home.url);
      url.hash = "";
    } catch { continue; }
    if (url.origin !== new URL(home.url).origin) continue;
    if (url.href === home.url) continue;
    if (!looksHtml(url.pathname)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url.href);
  }
  return out;
}

/** ≤ 30 HEADs on the home page's links; broken = 404/410 or network-dead. */
async function findBrokenLinks(fetcher: WidgetFetcher, home: PageCheck, deadline: number): Promise<string[]> {
  const links = sameSiteLinks(home);
  const broken: string[] = [];
  for (let i = 0; i < links.length; i += HEAD_BATCH) {
    if (deadline - Date.now() <= 2_000) break;
    const batch = links.slice(i, i + HEAD_BATCH);
    const results = await Promise.allSettled(batch.map(url =>
      timedFetch(fetcher, url, deadline, { method: "HEAD", timeoutMs: 5_000, maxBytes: 64 * 1024 }),
    ));
    results.forEach((result, j) => {
      const url = batch[j];
      if (result.status === "rejected") { broken.push(url); return; }
      const status = result.value.status;
      if (status === 404 || status === 410) broken.push(url);
    });
  }
  return broken;
}

function factsFor(page: PageCheck, isRoot: boolean, brokenCount: number, missingHeaders: number): AuditPageFacts {
  const s = page.signals;
  const canonical = s?.canonical?.trim() || null;
  let canonicalInvalid = false;
  let canonicalMismatch = false;
  try {
    if (canonical) {
      const cu = new URL(canonical);
      canonicalInvalid = !/^https?:$/.test(cu.protocol);
      canonicalMismatch = `${cu.origin}${cu.pathname}`.replace(/\/+$/, "") !== `${new URL(page.url).origin}${new URL(page.url).pathname}`.replace(/\/+$/, "");
    }
  } catch { canonicalInvalid = true; }
  const robotsMeta = [s?.robots ?? "", page.headers["x-robots-tag"] ?? ""].filter(Boolean).join(", ").toLowerCase();
  return {
    hasHtml: !!s,
    isRoot,
    isHttps: page.https,
    httpStatus: page.status,
    loadMs: page.loadMs,
    redirectHops: page.hops,
    redirectLoop: false,
    title: s?.title ?? "",
    titleDuplicate: false,
    metaDescription: s?.metaDesc ?? "",
    robots: robotsMeta,
    robotsConflict: robotsDirectivesConflict(robotsMeta),
    canonical,
    canonicalInvalid,
    canonicalMismatch,
    h1Count: s?.h1Count ?? 0,
    h1Text: s?.h1Text ?? "",
    wordCount: s?.wordCount ?? 0,
    imagesNoAlt: s?.imagesNoAlt ?? 0,
    brokenLinkCount: isRoot ? brokenCount : 0,
    jsRendered: false,
    viewportPresent: s?.viewportPresent ?? false,
    viewportResponsive: s ? s.viewportResponsive : undefined,
    htmlLang: s?.htmlLang ?? "",
    imagesNoDimensions: s?.imagesNoDimensions ?? 0,
    jsonLdInvalid: s?.jsonLdInvalid ?? 0,
    organizationSchemaIncomplete: s?.organizationSchemaIncomplete ?? false,
    openGraphMissing: s?.openGraphMissing.length ?? 0,
    twitterCardIncomplete: s?.twitterCardIncomplete ?? false,
    mixedContentCount: s?.mixedContentUrls.length ?? 0,
    missingSecurityHeaders: isRoot ? missingHeaders : 0,
    sitemapSeeded: false,
    internalInboundLinks: 1,
  };
}

function evidenceFor(code: FindingCode, ctx: {
  home: PageCheck; pages: Array<{ url: string; status: number; signals: AuditHtmlSignals | null; loadMs: number }>;
  broken: string[]; missingHeaders: string[]; https: boolean;
}): string {
  const htmlPages = ctx.pages.filter(p => p.signals);
  const pathsOf = (pred: (p: { url: string; signals: AuditHtmlSignals | null }) => boolean) =>
    htmlPages.filter(pred).map(p => path(p.url));
  switch (code) {
    case "https_unavailable": return "http://" + new URL(ctx.home.url).host;
    case "http_error": return ctx.pages
      .filter(p => p.status >= 400).map(p => `${p.status} · ${path(p.url)}`).slice(0, 4).join(", ") || String(ctx.home.status);
    case "fetch_failed": return joinPages(ctx.pages.filter(p => p.status === 0).map(p => path(p.url)));
    case "redirect": return `→ ${short(new URL(ctx.home.url).host + path(ctx.home.url), 60)}`;
    case "redirect_chain": return `${ctx.home.hops} → ${short(new URL(ctx.home.url).host + path(ctx.home.url), 60)}`;
    case "title_missing": return joinPages(pathsOf(p => !p.signals!.title)) || "/";
    case "title_too_long": {
      const over = htmlPages.filter(p => metaLength(p.signals!.title) > META_LIMITS.title.auditMax);
      return over.length ? `${metaLength(over[0].signals!.title)} > ${META_LIMITS.title.auditMax} · ${joinPages(over.map(p => path(p.url)))}` : "";
    }
    case "title_too_short": {
      const under = htmlPages.filter(p => p.signals!.title && metaLength(p.signals!.title) < META_LIMITS.title.auditMin);
      return under.length ? `${metaLength(under[0].signals!.title)} < ${META_LIMITS.title.auditMin} · ${joinPages(under.map(p => path(p.url)))}` : "";
    }
    case "description_missing": return joinPages(pathsOf(p => !p.signals!.metaDesc)) || "/";
    case "description_too_long": {
      const over = htmlPages.filter(p => metaLength(p.signals!.metaDesc) > META_LIMITS.description.auditMax);
      return over.length ? `${metaLength(over[0].signals!.metaDesc)} > ${META_LIMITS.description.auditMax} · ${joinPages(over.map(p => path(p.url)))}` : "";
    }
    case "description_too_short": {
      const under = htmlPages.filter(p => p.signals!.metaDesc && metaLength(p.signals!.metaDesc) < META_LIMITS.description.auditMin);
      return under.length ? `${metaLength(under[0].signals!.metaDesc)} < ${META_LIMITS.description.auditMin} · ${joinPages(under.map(p => path(p.url)))}` : "";
    }
    case "h1_missing": return joinPages(pathsOf(p => p.signals!.h1Count === 0)) || "/";
    case "h1_multiple": {
      const multi = htmlPages.filter(p => p.signals!.h1Count > 1);
      return multi.length ? `${multi[0].signals!.h1Count} H1 · ${joinPages(multi.map(p => path(p.url)))}` : "";
    }
    case "noindex": return joinPages(pathsOf(p => /(^|[\s,;:])noindex(?=$|[\s,;])/i.test(p.signals!.robots))) || "/";
    case "canonical_missing": return joinPages(pathsOf(p => !p.signals!.canonical)) || "/";
    case "viewport_missing": return joinPages(pathsOf(p => !p.signals!.viewportPresent)) || "/";
    case "viewport_not_responsive": {
      const bad = htmlPages.filter(p => p.signals!.viewportContent);
      return bad.length ? `${short(bad[0].signals!.viewportContent, 40)} · ${joinPages(bad.map(p => path(p.url)))}` : "";
    }
    case "lang_missing": return joinPages(pathsOf(p => !p.signals!.htmlLang)) || "/";
    case "jsonld_invalid": {
      const invalid = htmlPages.filter(p => p.signals!.jsonLdInvalid > 0);
      return invalid.length ? `${invalid.reduce((n, p) => n + p.signals!.jsonLdInvalid, 0)} · ${joinPages(invalid.map(p => path(p.url)))}` : "";
    }
    case "open_graph_incomplete": {
      const missing = new Set<string>();
      htmlPages.forEach(p => p.signals!.openGraphMissing.forEach(k => missing.add(k)));
      return [...missing].slice(0, 4).join(", ");
    }
    case "security_headers_missing": return ctx.missingHeaders.slice(0, 4).join(", ");
    case "slow_response": return `${ctx.home.loadMs} ms`;
    case "broken_links": return `${ctx.broken.length} · ${ctx.broken.slice(0, 4).map(u => short(path(u), 40)).join(", ")}`;
    case "mixed_content": {
      const urls = htmlPages.flatMap(p => p.signals!.mixedContentUrls);
      return urls.length ? `${urls.length} · ${urls.slice(0, 2).map(u => short(u, 50)).join(", ")}` : "";
    }
    case "thin_content": {
      const thin = htmlPages.filter(p => p.signals!.wordCount < 150);
      return thin.length ? `${thin[0].signals!.wordCount} words · ${joinPages(thin.map(p => path(p.url)))}` : "";
    }
    case "images_no_alt": {
      const withImages = htmlPages.filter(p => p.signals!.imagesNoAlt > 0);
      return withImages.length ? `${withImages.reduce((n, p) => n + p.signals!.imagesNoAlt, 0)} · ${joinPages(withImages.map(p => path(p.url)))}` : "";
    }
  }
}

export async function runLiteAudit(
  domainInput: string,
  opts: { fetcher?: WidgetFetcher } = {},
): Promise<LiteAuditReport> {
  const fetcher = opts.fetcher ?? widgetFetch;
  const host = normalizeAuditDomain(domainInput);
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  // Home page over https, one fallback to http — a site that cannot do TLS is itself a finding.
  let home: PageCheck;
  let https = true;
  try {
    home = await fetchHome(fetcher, `https://${host}/`, deadline);
  } catch (error) {
    if (!(error instanceof LiteAuditError)) throw error;
    https = false;
    home = await fetchHome(fetcher, `http://${host}/`, deadline); // both fail → LiteAuditError("unreachable")
  }
  if (home.status === 0) throw new LiteAuditError("unreachable");

  const homeUrl = new URL(home.url);
  const extraUrls = await pickExtraPages(fetcher, home, homeUrl, deadline).catch(() => [] as string[]);
  const extras: PageCheck[] = [];
  await Promise.allSettled(extraUrls.map(async url => {
    const started = Date.now();
    try {
      const outcome = await timedFetch(fetcher, url, deadline);
      extras.push(toPageCheck(outcome, started, outcome.redirected ? 1 : 0));
    } catch {
      extras.push({ url, status: 0, loadMs: Date.now() - started, https: url.startsWith("https:"), hops: 0, signals: null, headers: {} });
    }
  }));

  const missingHeaders = missingSecurityHeaders(home.headers, home.https);
  const broken = home.signals ? await findBrokenLinks(fetcher, home, deadline).catch(() => [] as string[]) : [];

  const pages = [home, ...extras];
  // Findings aggregate by code across pages: one row per problem, evidence carries the pages.
  const order: FindingCode[] = [];
  const byCode = new Map<FindingCode, Set<string>>();
  const add = (code: FindingCode, pageUrl: string) => {
    if (!byCode.has(code)) { byCode.set(code, new Set()); order.push(code); }
    if (pageUrl) byCode.get(code)!.add(path(pageUrl));
  };

  pages.forEach((page, index) => {
    const facts = factsFor(page, index === 0, broken.length, missingHeaders.length);
    for (const id of evaluateAuditPageRules(facts)) {
      if (!KEPT_RULE_IDS.has(id)) continue;
      add(id as FindingCode, page.url);
    }
    if (index > 0 && page.status >= 400) add("http_error", page.url);
    if (index > 0 && page.status === 0) add("fetch_failed", page.url);
  });
  // Manual redirect following lands on the FINAL status, so the registry's own redirect rules
  // never see a 3xx — the chain is reported from the hop counter instead.
  if (home.hops >= 1) add("redirect", home.url);
  if (home.hops > 1) add("redirect_chain", home.url);
  if (!https || !home.https) add("https_unavailable", "");

  const ctx = {
    home, pages: pages.map(p => ({ url: p.url, status: p.status, signals: p.signals, loadMs: p.loadMs })),
    broken, missingHeaders, https: home.https,
  };
  const findings: RawFinding[] = order.map(code => ({
    code,
    severity: SEVERITY[code],
    category: CATEGORY[code],
    evidence: evidenceFor(code, ctx),
    pages: [...(byCode.get(code) ?? [])].slice(0, 10),
  }));
  const sorted = topFindings(findings, findings.length);

  return {
    domain: host,
    finalUrl: home.url,
    https: home.https,
    score: scoreFromFindings(sorted),
    findings: sorted,
    pagesChecked: pages.length,
    checkedAt: new Date().toISOString(),
  };
}
