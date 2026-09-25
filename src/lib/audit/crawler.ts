// Built-in site audit crawler — zero external APIs, zero cost. BFS-walks same-host
// pages from the site root with plain fetch + regex HTML extraction (no headless
// browser: the signals we audit — status codes, titles, meta, canonicals, link graph —
// all live in the raw HTML). Runs as a fire-and-forget job (same pattern as SeoJob):
// POST /api/audit creates the SiteAudit row and calls runAudit() without awaiting it.

import { prisma } from "@/lib/prisma";
import { checkAiCrawlability, fetchRobots } from "@/lib/audit/aiCrawl";
import { safeFetch } from "@/lib/security/safeFetch";
import { extractAuditHtml, missingSecurityHeaders, robotsDirectivesConflict, type AuditHtmlSignals } from "@/lib/audit/pageSignals";
export const AUDIT_PAGE_CEILING = 5000;

import { AUDIT_ACTIONABLE_RULE_IDS, AUDIT_RULE_IDS, AUDIT_SCORING_RULE_IDS, evaluateAuditPageRules, type AuditPageFacts } from "@/lib/audit/rules";
import { compareAuditFindings } from "@/lib/audit/verification";
import { checkHreflangSite, mergeHreflangEntries, normalizeHreflangUrl, parseHreflangLinkHeader, parseHreflangSitemap, type HreflangEntry, type HreflangTargetState } from "@/lib/audit/hreflang";
import { normalizeAuditUrl, pickMainQuery } from "@/lib/audit/queryAlign";
import { isCwvPoor, pickPsiSample, resolvePsiApiKey, runPsiStage } from "@/lib/audit/psi";
import { withCallContext } from "@/lib/providerLog/context";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";

const UA = "Mozilla/5.0 (compatible; OpenGSC-Audit/1.0; +https://opengsc.org)";
const PAGE_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const POLITENESS_DELAY_MS = 150; // per worker, between requests — be a good citizen on the user's own site

// ─── URL normalization ──────────────────────────────────────────────────────────

function normalizeUrl(href: string, base: URL): URL | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Skip obvious non-HTML assets
    if (/\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|json|xml|pdf|zip|gz|mp4|webm|mp3|woff2?|ttf|eot|avif)(\?|$)/i.test(u.pathname)) return null;
    return u;
  } catch { return null; }
}

const sameHost = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

// ─── page fetch ─────────────────────────────────────────────────────────────────

interface PageResult {
  url: string;
  httpStatus: number;
  redirectTo: string | null;
  contentType: string;
  loadMs: number;
  html: string | null;
  /** Decoded HTML size in bytes — html_too_large works only if pages above the limit can still be fetched. */
  htmlBytes: number;
  responseHeaders: Record<string, string>;
  fetchError?: string;
}

async function fetchPage(url: string): Promise<PageResult> {
  const started = Date.now();
  try {
    // manual redirect handling so 301→ chains are visible as issues
    const res = await safeFetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      timeoutMs: PAGE_TIMEOUT_MS,
      // 5 MB (not 2): html_too_large flags decoded HTML above 2 MB, and a fetch that dies at
      // the old cap would turn a "large document" finding into "fetch failed".
      maxBytes: 5 * 1024 * 1024,
    });
    const loadMs = Date.now() - started;
    const contentType = res.headers.get("content-type") ?? "";
    const responseHeaders = Object.fromEntries([
      "content-security-policy", "strict-transport-security", "x-content-type-options",
      "x-frame-options", "referrer-policy", "x-robots-tag", "link",
    ].map(name => [name, res.headers.get(name) ?? ""]));
    if (res.status >= 300 && res.status < 400) {
      return { url, httpStatus: res.status, redirectTo: res.headers.get("location"), contentType, loadMs, html: null, htmlBytes: 0, responseHeaders };
    }
    const isHtml = contentType.includes("html") || contentType === "";
    const html = res.ok && isHtml ? await res.text() : null;
    return { url, httpStatus: res.status, redirectTo: null, contentType, loadMs, html, htmlBytes: html ? Buffer.byteLength(html) : 0, responseHeaders };
  } catch (e: any) {
    return { url, httpStatus: 0, redirectTo: null, contentType: "", loadMs: Date.now() - started, html: null, htmlBytes: 0, responseHeaders: {}, fetchError: String(e?.message ?? e).slice(0, 120) };
  }
}

// ─── issue detection ────────────────────────────────────────────────────────────

export const ISSUE_CODES = AUDIT_RULE_IDS;

// ─── main runner ────────────────────────────────────────────────────────────────

/**
 * Link targets that are never real pages and must not be reported as broken.
 *
 * Cloudflare's email obfuscation is the one that matters in practice: it rewrites every `mailto:`
 * into `/cdn-cgi/l/email-protection#<hex>` and answers those with a 403 to anything that isn't a
 * browser running its script. The crawler dutifully recorded a 403 and flagged a broken link on
 * every page carrying a contact address — an entire column of false positives caused by a working
 * anti-spam feature.
 *
 * The rest are the same shape: infrastructure endpoints that exist to be blocked.
 */
const DEFAULT_IGNORE = [
  "/cdn-cgi/",          // Cloudflare internals: email-protection, rocket-loader, challenge paths
  "/wp-admin/",
  "/wp-login.php",
  "/xmlrpc.php",
  "?add-to-cart=",
  "/cart/add",
];

export interface AuditOptions {
  /** extra substrings to skip, one per line or comma separated */
  ignorePatterns?: string[];
  /** turn off the built-in list above (defaults stay on) */
  skipDefaultIgnores?: boolean;
  /** add active sitemap inventory URLs to the crawl frontier; normal BFS remains the default */
  seedFromSitemap?: boolean;
}

const activeAudits = new Set<string>();
const AUDIT_STALE_MS = 5 * 60_000;

export function storedOptions(value?: string | null): AuditOptions | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return {
      ignorePatterns: Array.isArray(parsed?.ignorePatterns) ? parsed.ignorePatterns.map(String) : undefined,
      skipDefaultIgnores: parsed?.skipDefaultIgnores === true,
      seedFromSitemap: parsed?.seedFromSitemap === true,
    };
  } catch { return undefined; }
}

/**
 * Claim and restart free crawler jobs whose heartbeat stopped. The updateMany predicate is the
 * cross-request lock: only one poller can move heartbeatAt out of the stale window. Paid SEO jobs
 * are never resumed automatically because repeating an uncertain provider call could double bill.
 */
export async function recoverStaleAudits(siteId?: string): Promise<number> {
  const store = (prisma as any).siteAudit;
  const cutoff = new Date(Date.now() - AUDIT_STALE_MS);
  let stale: any[] = [];
  try {
    stale = await store.findMany({
      where: {
        ...(siteId ? { siteId } : {}),
        status: "running",
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
      },
      take: 10,
    });
  } catch { return 0; }

  let claimed = 0;
  for (const audit of stale) {
    const result = await store.updateMany({
      where: {
        id: audit.id,
        status: "running",
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
      },
      data: { heartbeatAt: new Date(), stage: "recovering", attempt: { increment: 1 }, error: null },
    }).catch(() => ({ count: 0 }));
    if (!result.count) continue;
    claimed++;
    runAudit(audit.id, storedOptions(audit.options)).catch(error => console.error("[audit] recovery failed:", error));
  }
  return claimed;
}

function buildIgnoreList(opts?: AuditOptions): string[] {
  const custom = (opts?.ignorePatterns ?? [])
    .flatMap(p => String(p).split(/[\n,]/))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return opts?.skipDefaultIgnores ? custom : [...DEFAULT_IGNORE, ...custom];
}

// ─── hreflang source 3: xhtml:link in XML sitemaps ────────────────────────────

const SITEMAP_FETCH_LIMIT = 3;

async function fetchSitemapText(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" },
      redirect: "follow",
      timeoutMs: 15_000,
      maxBytes: 4 * 1024 * 1024,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

/**
 * hreflang sets declared in sitemaps: robots.txt `Sitemap:` lines (falling back to the
 * /sitemap.xml convention), one nesting level of sitemapindex, xhtml:link entries from each
 * document, merged across sitemaps. Best-effort like the whole sitemap source — any failure
 * leaves it absent, and the head/header sources still work without it.
 */
async function loadSitemapHreflangs(root: URL): Promise<Map<string, HreflangEntry[]>> {
  const robots = await fetchRobots(root).catch(() => null);
  const urls = robots?.text
    ? [...robots.text.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)].map(m => m[1])
    : [];
  const candidates = urls.length ? urls.slice(0, SITEMAP_FETCH_LIMIT) : [new URL("/sitemap.xml", root).href];

  const docs: string[] = [];
  for (const url of candidates) {
    const xml = await fetchSitemapText(url);
    if (!xml) continue;
    if (/<sitemapindex/i.test(xml.slice(0, 2000))) {
      for (const child of [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]).slice(0, SITEMAP_FETCH_LIMIT)) {
        const childXml = await fetchSitemapText(child);
        if (childXml) docs.push(childXml);
      }
    } else {
      docs.push(xml);
    }
  }

  const out = new Map<string, HreflangEntry[]>();
  for (const doc of docs) {
    for (const [loc, entries] of parseHreflangSitemap(doc)) {
      out.set(loc, mergeHreflangEntries(out.get(loc) ?? [], entries));
    }
  }
  return out;
}

export async function runAudit(auditId: string, opts?: AuditOptions): Promise<void> {
  if (activeAudits.has(auditId)) return;
  activeAudits.add(auditId);
  try {
    const audit = await prisma.siteAudit.findUnique({ where: { id: auditId }, include: { site: true } });
    if (!audit) return;
    await prisma.siteAuditPage.deleteMany({ where: { auditId } });
    await (prisma as any).siteAudit.update({
      where: { id: auditId },
      data: { status: "running", stage: "crawl", progress: 0, pagesCrawled: 0, heartbeatAt: new Date(), finishedAt: null, error: null },
    });
    const rootUrl = audit.site.url.startsWith("http") ? audit.site.url : `https://${audit.site.url.replace(/^sc-domain:/, "")}`;
    const root = new URL(rootUrl);
    // A hard stop, not a setting anyone should have to think about. Asking "how many pages?" before
    // a crawl is asking a question the user cannot answer — they do not know how big the site is,
    // and guessing low silently truncates the audit into a half-truth. The default now covers whole
    // sites; the number survives only as a safety rail against an accidental crawl of something
    // enormous, and the report says plainly whether it was reached.
    const maxPages = Math.min(AUDIT_PAGE_CEILING, Math.max(10, audit.maxPages || AUDIT_PAGE_CEILING));

    // AI Crawlability is a site-wide check (robots.txt + /llms.txt), independent of which pages get
    // crawled. Started before the BFS loop so its two requests overlap with the page crawl rather
    // than serialising after it, and awaited only where its result is consumed (the summary below).
    const aiCrawlPromise = checkAiCrawlability(root).catch(() => null);
    // The sitemap hreflang source overlaps the same way: robots.txt + up to 3+3 sitemap fetches
    // run while pages crawl, and the result is consumed in the second pass.
    const sitemapHreflangPromise = loadSitemapHreflangs(root).catch(() => new Map<string, HreflangEntry[]>());

    // Applied at link-collection time, so an ignored URL is neither crawled nor counted as a
    // broken target. Filtering only at the reporting end would still spend crawl budget on it.
    const ignore = buildIgnoreList(opts);
    const isIgnored = (href: string) => {
      const h = href.toLowerCase();
      return ignore.some(p => h.includes(p));
    };

    type QItem = { url: string; depth: number };
    const queue: QItem[] = [{ url: root.href, depth: 0 }];
    const seen = new Set<string>([root.href]);
    const sitemapSeeds = new Set<string>();
    if (opts?.seedFromSitemap) {
      const inventory = await prisma.sitemapUrl.findMany({
        where: { siteId: audit.siteId, inventoryStatus: { not: "missing" } },
        orderBy: { lastSeenAt: "desc" },
        take: Math.max(0, maxPages - 1),
        select: { url: true },
      });
      for (const row of inventory) {
        const seed = normalizeUrl(row.url, root);
        if (!seed || !sameHost(seed, root) || isIgnored(seed.href) || seen.has(seed.href)) continue;
        seen.add(seed.href);
        sitemapSeeds.add(seed.href);
        queue.push({ url: seed.href, depth: 1 });
      }
    }
    const results = new Map<string, PageResult & { depth: number; ex?: AuditHtmlSignals; internalTargets?: string[] }>();

    let crawled = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && crawled < maxPages) {
        const item = queue.shift();
        if (!item) break;
        crawled++;
        const page = await fetchPage(item.url);
        const entry: any = { ...page, depth: item.depth };
        if (page.html) {
          const ex = extractAuditHtml(page.html);
          entry.ex = ex;
          entry.internalTargets = [];
          for (const href of ex.hrefs) {
            const u = normalizeUrl(href, new URL(item.url));
            if (!u) continue;
            if (isIgnored(u.href)) continue;
            if (sameHost(u, root)) {
              entry.internalTargets.push(u.href);
              if (!seen.has(u.href) && seen.size < maxPages * 3) {
                seen.add(u.href);
                queue.push({ url: u.href, depth: item.depth + 1 });
              }
            }
          }
        } else if (page.redirectTo) {
          // Follow the redirect target as part of the crawl so chains are mapped.
          const u = normalizeUrl(page.redirectTo, new URL(item.url));
          if (u && sameHost(u, root) && !seen.has(u.href)) {
            seen.add(u.href);
            queue.push({ url: u.href, depth: item.depth });
          }
        }
        results.set(item.url, entry);
        if (crawled % 10 === 0) {
          await (prisma as any).siteAudit.update({
            where: { id: auditId },
            data: { pagesCrawled: crawled, progress: Math.min(74, Math.round((crawled / maxPages) * 75)), heartbeatAt: new Date() },
          }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, POLITENESS_DELAY_MS));
      }
    });
    await Promise.all(workers);

    await (prisma as any).siteAudit.update({ where: { id: auditId }, data: { stage: "analyze", progress: 78, heartbeatAt: new Date() } }).catch(() => {});

    // ── second pass: issues (needs the full crawl map for broken links & duplicate titles)
    const statusOf = new Map<string, number>();
    for (const [url, r] of results) statusOf.set(url, r.httpStatus);
    const titleCount = new Map<string, number>();
    for (const r of results.values()) {
      const t = r.ex?.title?.toLowerCase().trim();
      if (t) titleCount.set(t, (titleCount.get(t) ?? 0) + 1);
    }
    const inboundLinks = new Map<string, number>();
    for (const [source, result] of results) {
      for (const target of new Set(result.internalTargets ?? [])) {
        if (target === source) continue;
        inboundLinks.set(target, (inboundLinks.get(target) ?? 0) + 1);
      }
    }

    const issueTotals: Record<string, number> = {};
    const bump = (code: string) => { issueTotals[code] = (issueTotals[code] ?? 0) + 1; };

    const redirectTrace = (start: string): { hops: number; loop: boolean } => {
      const visited = new Set<string>();
      let current = start;
      let hops = 0;
      while (hops <= 10) {
        if (visited.has(current)) return { hops, loop: true };
        visited.add(current);
        const page = results.get(current);
        if (!page?.redirectTo || page.httpStatus < 300 || page.httpStatus >= 400) break;
        const next = normalizeUrl(page.redirectTo, new URL(current));
        if (!next || !sameHost(next, root)) break;
        current = next.href;
        hops++;
      }
      return { hops, loop: false };
    };

    // hreflang sets: head links + Link header (per page) + sitemap xhtml:link (site-wide),
    // then the cross-page reciprocity checks over the whole crawl in the same pass that
    // already computes titleDuplicate / internalInboundLinks.
    const sitemapHreflang = await sitemapHreflangPromise;
    const sitemapHreflangByNorm = new Map<string, HreflangEntry[]>();
    for (const [loc, entries] of sitemapHreflang) {
      const key = normalizeHreflangUrl(loc);
      if (key) sitemapHreflangByNorm.set(key, mergeHreflangEntries(sitemapHreflangByNorm.get(key) ?? [], entries));
    }
    const hreflangEntriesByUrl = new Map<string, HreflangEntry[]>();
    for (const [url, r] of results) {
      const headerEntries = parseHreflangLinkHeader(r.responseHeaders["link"] ?? "");
      const fromSitemap = sitemapHreflangByNorm.get(normalizeHreflangUrl(url)) ?? [];
      const merged = mergeHreflangEntries(r.ex?.hreflang ?? [], headerEntries, fromSitemap);
      if (merged.length) hreflangEntriesByUrl.set(url, merged);
    }

    // Per-page facts the target checks need: indexability and canonical status of every crawled
    // page, computed once here and reused by both the target rules and the hreflang checks.
    const noindexOf = new Map<string, boolean>();
    const canonicalAbs = new Map<string, string | null>();
    for (const [url, r] of results) {
      const robots = [r.ex?.robots ?? "", r.responseHeaders["x-robots-tag"] ?? ""].filter(Boolean).join(", ").toLowerCase();
      noindexOf.set(url, /(^|[\s,;:])noindex(?=$|[\s,;])/i.test(robots));
      canonicalAbs.set(url, r.ex?.canonical ? new URL(r.ex.canonical, url).href : null);
    }
    const hreflangTargetStates = new Map<string, HreflangTargetState>();
    for (const [url, r] of results) {
      hreflangTargetStates.set(normalizeHreflangUrl(url), {
        httpStatus: r.httpStatus,
        noindex: noindexOf.get(url) ?? false,
        canonical: canonicalAbs.get(url) ?? null,
      });
    }
    const hreflangFindings = checkHreflangSite(
      [...hreflangEntriesByUrl].map(([url, entries]) => ({
        url,
        htmlLang: results.get(url)?.ex?.htmlLang ?? "",
        entries,
      })),
      hreflangTargetStates,
    );

    // Main GSC query per page: ONE grouped query for the whole audit (url+query sums over 28 d,
    // web search type only), then the per-page maximum with an impressions floor is picked in
    // memory. No DailyMetric rows → empty map → title_query_mismatch simply stays silent.
    const mainQueryByNorm = new Map<string, { query: string; impressions: number }>();
    {
      type GroupedQuery = { url: string; query: string; _sum: { impressions: number | null } };
      const grouped: GroupedQuery[] = await prisma.dailyMetric.groupBy({
        by: ["url", "query"],
        where: {
          siteId: audit.siteId,
          date: { gte: new Date(Date.now() - 28 * 86_400_000) },
          searchType: "web",
          query: { not: "" },
          url: { not: "" },
        },
        _sum: { impressions: true },
        orderBy: { _sum: { impressions: "desc" } },
        take: 20_000,
      }).catch(() => [] as GroupedQuery[]);
      for (const row of grouped) {
        const key = normalizeAuditUrl(String(row.url));
        if (!key) continue;
        const candidate = { query: String(row.query), impressions: Number(row._sum?.impressions ?? 0) };
        const current = mainQueryByNorm.get(key);
        if (!current || candidate.impressions > current.impressions) mainQueryByNorm.set(key, candidate);
      }
    }

    const rows: any[] = [];
    for (const [url, r] of results) {
      const broken: string[] = [];
      const redirectLinks: string[] = [];
      if (r.ex) {
        for (const target of new Set(r.internalTargets ?? [])) {
          const st = statusOf.get(target);
          if (st === undefined) continue;
          if (st >= 400 || st === 0) broken.push(target);
          else if (st >= 300 && st < 400) redirectLinks.push(target);
        }
      }

      const redirect = redirectTrace(url);
      const robots = [r.ex?.robots ?? "", r.responseHeaders["x-robots-tag"] ?? ""]
        .filter(Boolean).join(", ").toLowerCase();
      let canonicalInvalid = false;
      let canonicalMismatch = false;
      if (r.ex?.canonical) {
        try {
          const canonicalUrl = new URL(r.ex.canonical, url);
          const here = new URL(url);
          canonicalMismatch = canonicalUrl.href.replace(/\/$/, "") !== here.href.replace(/\/$/, "");
        } catch { canonicalInvalid = true; }
      }
      const jsRendered = !!r.ex && r.ex.wordCount < 30 && r.ex.hrefs.length <= 1 && (r.ex.spaMarker || r.ex.hasLargeScript);
      // Redirect targets from the start URL keep depth 0, so the final homepage still receives
      // site-scope header/schema checks when http→https or apex→www is configured correctly.
      const isRoot = r.depth === 0;
      const hreflangPage = hreflangFindings.get(url);
      const mainQuery = mainQueryByNorm.get(normalizeAuditUrl(url)) ?? null;
      // pickMainQuery applies the ≥ 20 impressions floor — the threshold lives in one place.
      const mainQueryMeetsFloor = mainQuery ? pickMainQuery([mainQuery]) : null;
      const facts: AuditPageFacts = {
        hasHtml: !!r.ex,
        isRoot,
        isHttps: new URL(url).protocol === "https:",
        httpStatus: r.httpStatus,
        loadMs: r.loadMs,
        redirectHops: redirect.hops,
        redirectLoop: redirect.loop,
        title: r.ex?.title ?? "",
        titleDuplicate: !!r.ex?.title && (titleCount.get(r.ex.title.toLowerCase().trim()) ?? 0) > 1,
        metaDescription: r.ex?.metaDesc ?? "",
        robots,
        robotsConflict: robotsDirectivesConflict(robots),
        canonical: r.ex?.canonical?.trim() || null,
        canonicalInvalid,
        canonicalMismatch,
        h1Count: r.ex?.h1Count ?? 0,
        h1Text: r.ex?.h1Text ?? "",
        wordCount: r.ex?.wordCount ?? 0,
        imagesNoAlt: r.ex?.imagesNoAlt ?? 0,
        brokenLinkCount: broken.length,
        jsRendered,
        viewportPresent: r.ex?.viewportPresent ?? false,
        viewportResponsive: r.ex?.viewportResponsive ?? false,
        htmlLang: r.ex?.htmlLang ?? "",
        hreflangInvalid: hreflangPage?.invalid ?? [],
        hreflangNoReturn: hreflangPage?.noReturn ?? [],
        hreflangSelfMissing: hreflangPage?.selfMissing ?? false,
        hreflangTargetBad: hreflangPage?.targetBad ?? [],
        hreflangXDefaultMissing: hreflangPage?.xDefaultMissing ?? false,
        langHreflangMismatch: hreflangPage?.langMismatch ?? "",
        internalRedirectLinks: redirectLinks,
        imagesNoDimensions: r.ex?.imagesNoDimensions ?? 0,
        htmlBytes: r.htmlBytes,
        mainQuery: mainQueryMeetsFloor,
        cwvPoor: null, // filled by the PSI stage below, after the crawl
        jsonLdInvalid: r.ex?.jsonLdInvalid ?? 0,
        organizationSchemaIncomplete: r.ex?.organizationSchemaIncomplete ?? false,
        openGraphMissing: r.ex?.openGraphMissing.length ?? 0,
        twitterCardIncomplete: r.ex?.twitterCardIncomplete ?? false,
        mixedContentCount: r.ex?.mixedContentUrls.length ?? 0,
        missingSecurityHeaders: isRoot && r.ex ? missingSecurityHeaders(r.responseHeaders, new URL(url).protocol === "https:").length : 0,
        sitemapSeeded: sitemapSeeds.has(url),
        internalInboundLinks: inboundLinks.get(url) ?? 0,
      };
      const issues = evaluateAuditPageRules(facts);
      for (const code of issues) bump(code);
      // The facts above are booleans and counts, which is all a rule needs to fire — but a report
      // reader (or an agent asked to fix the site) needs the value behind the verdict. It is
      // captured here, while the parsed page is still in scope, and never recomputed later.
      const evidence = buildEvidence(issues, {
        facts,
        signals: r.ex,
        securityHeaders: isRoot && r.ex ? missingSecurityHeaders(r.responseHeaders, new URL(url).protocol === "https:") : [],
        redirectTo: r.redirectTo,
        brokenLinks: broken,
        internalRedirectLinks: redirectLinks.slice(0, 5),
      });
      // Context the audit's meta-fit suggestions need per page (H1 text, page language, main
      // query) but which has no column of its own. Keys are prefixed "_" and every reader of
      // evidence skips them; they ride along because the row must stay self-sufficient.
      if (r.ex?.h1Text) evidence._h1 = r.ex.h1Text;
      if (r.ex?.htmlLang) evidence._lang = r.ex.htmlLang;
      if (mainQueryMeetsFloor) evidence._q = `${mainQueryMeetsFloor.query}\u001F${mainQueryMeetsFloor.impressions}`;
      rows.push({
        auditId,
        url,
        httpStatus: r.httpStatus,
        redirectTo: r.redirectTo,
        contentType: r.contentType.split(";")[0],
        title: r.ex?.title?.slice(0, 300) ?? "",
        metaDescription: r.ex?.metaDesc?.slice(0, 400) ?? "",
        h1Count: r.ex?.h1Count ?? 0,
        canonical: r.ex?.canonical ?? null,
        noindex: noindexOf.get(url) ?? false,
        internalLinks: new Set(r.internalTargets ?? []).size,
        externalLinks: r.ex ? Math.max(0, r.ex.hrefs.length - (r.internalTargets?.length ?? 0)) : 0,
        imagesNoAlt: r.ex?.imagesNoAlt ?? 0,
        wordCount: r.ex?.wordCount ?? 0,
        loadMs: r.loadMs,
        depth: r.depth,
        // Arrays in memory so the PSI stage can append cwv_poor before persisting.
        issues,
        evidence,
        brokenLinks: broken.slice(0, 50),
      });
    }

    // ── PageSpeed sample — after the crawl, and never holding the audit.
    //
    // No key → status "unavailable" (a UI message, not an error). Slow or failed requests →
    // item errors and status "partial"; the audit still completes.
    let psi: { status: string; items: unknown[] } | null = null;
    {
      const heartbeat = () => (prisma as any).siteAudit
        .update({ where: { id: auditId }, data: { stage: "psi", heartbeatAt: new Date() } })
        .catch(() => {});
      const captureBodies = await resolveCaptureBodies(audit.site.userId).catch(() => false);
      // withCallContext so the provider-log rows carry whose PSI quota this was.
      await withCallContext({ userId: audit.site.userId, feature: "site-audit-psi", captureBodies }, async () => {
        const psiKey = await resolvePsiApiKey(audit.site.userId);
        if (!psiKey) {
          psi = { status: "unavailable", items: [] };
          return;
        }
        const sample = pickPsiSample([...results].map(([url, r]) => ({
          url,
          depth: r.depth,
          httpStatus: r.httpStatus,
          hasHtml: !!r.ex,
          noindex: noindexOf.get(url) ?? false,
          internalInboundLinks: inboundLinks.get(url) ?? 0,
        })));
        const summary = await runPsiStage(psiKey, sample, heartbeat);
        psi = summary;
        const byUrl = new Map(rows.map(row => [row.url, row]));
        for (const item of summary.items) {
          if (item.error || !isCwvPoor(item)) continue;
          const row = byUrl.get(item.url);
          if (!row || row.issues.includes("cwv_poor")) continue;
          row.issues.push("cwv_poor");
          bump("cwv_poor");
          const parts = [
            item.lcp != null ? `LCP ${(item.lcp / 1000).toFixed(1)} s` : null,
            item.inp != null ? `INP ${Math.round(item.inp)} ms` : null,
            item.cls != null ? `CLS ${item.cls.toFixed(2)}` : null,
          ].filter(Boolean);
          row.evidence.cwv_poor = `${parts.join(" · ")} (${item.source})`;
        }
      }).catch(() => {
        // The stage must not take the audit down with it — an unknown PSI is "partial".
        psi = { status: "partial", items: [] };
      });
    }

    await (prisma as any).siteAudit.update({ where: { id: auditId }, data: { stage: "persist", progress: 90, heartbeatAt: new Date() } }).catch(() => {});

    // Rows carried arrays so the PSI stage could append findings; they become JSON only here,
    // at the storage boundary.
    const storedRows = rows.map(row => ({
      ...row,
      issues: row.issues.length ? JSON.stringify(row.issues) : null,
      evidence: Object.keys(row.evidence).length ? JSON.stringify(row.evidence) : null,
      brokenLinks: row.brokenLinks.length ? JSON.stringify(row.brokenLinks) : null,
    }));
    // createMany is not supported for SQLite pre-Prisma5-style in all setups — chunked create is fine here.
    for (let i = 0; i < storedRows.length; i += 50) {
      await prisma.siteAuditPage.createMany({ data: storedRows.slice(i, i + 50) });
    }

    const pagesWithFindings = rows.filter(row => row.issues.length).length;
    const pagesWithIssues = rows.filter(row => row.issues.some((issue: string) => AUDIT_ACTIONABLE_RULE_IDS.has(issue))).length;
    // Informational and useful-but-non-universal checks remain visible without destabilizing the
    // established health score. Older audits keep the score already stored with them.
    const pagesWithScoredIssues = rows.filter(row => {
      return row.issues.some((issue: string) => AUDIT_SCORING_RULE_IDS.has(issue));
    }).length;
    // Awaited here, at the only point its result is used: the summary. By now the crawl has run
    // its course, so a slow robots/llms fetch (or one that already resolved) costs no extra latency.
    // The catch above already nulls a failed check, so a network error here never fails the audit.
    const aiCrawlability = await aiCrawlPromise;
    let verification = null;
    if ((audit as any).baselineAuditId) {
      const baseline = await prisma.siteAudit.findFirst({
        where: { id: (audit as any).baselineAuditId, siteId: audit.siteId, status: "completed" },
        select: { id: true, summary: true },
      });
      if (baseline) {
        const baselinePages = await prisma.siteAuditPage.findMany({ where: { auditId: baseline.id } });
        // Which rules the baseline could possibly know: stored in its own summary at write time.
        // For audits older than that field, the issue totals are the best available hint — a
        // finding under a rule the baseline never saw is a new check, not a regression.
        let baselineRuleIds: Set<string> | undefined;
        try {
          const baselineSummary = baseline.summary ? JSON.parse(baseline.summary) : null;
          if (Array.isArray(baselineSummary?.ruleIds)) baselineRuleIds = new Set(baselineSummary.ruleIds);
          else if (baselineSummary?.issues && typeof baselineSummary.issues === "object") {
            baselineRuleIds = new Set(Object.keys(baselineSummary.issues));
          }
        } catch { /* legacy row — verification falls back to strict comparison */ }
        verification = compareAuditFindings(
          baseline.id,
          baselinePages.map(page => ({ url: page.url, httpStatus: page.httpStatus, issues: page.issues ? JSON.parse(page.issues) : [] })),
          rows.map(row => ({ url: row.url, httpStatus: row.httpStatus, issues: row.issues })),
          baselineRuleIds,
        );
      }
    }
    await prisma.siteAudit.update({
      where: { id: auditId },
      data: {
        status: "completed",
        stage: "completed",
        progress: 100,
        heartbeatAt: new Date(),
        finishedAt: new Date(),
        pagesCrawled: rows.length,
        summary: JSON.stringify({
          pages: rows.length,
          pagesWithIssues,
          pagesWithFindings,
          pagesWithScoredIssues,
          healthScore: rows.length ? Math.round(100 * (1 - pagesWithScoredIssues / rows.length)) : 0,
          issues: issueTotals,
          avgLoadMs: rows.length ? Math.round(rows.reduce((s, r) => s + r.loadMs, 0) / rows.length) : 0,
          // The rule registry this audit ran with, so a future comparison can tell "the rule did
          // not exist in the baseline" from "the problem appeared".
          ruleIds: AUDIT_RULE_IDS,
          // PSI sample (site-wide, not per-page). Absent only for audits that predate the stage.
          ...(psi ? { psi } : {}),
          // Site-wide (not per-page), so it lives in the summary rather than as a row issue. Old
          // audits predating this field simply have no key, and the UI renders nothing for them.
          ...(aiCrawlability ? { aiCrawlability } : {}),
          ...(opts?.seedFromSitemap ? {
            sitemapSeeds: sitemapSeeds.size,
            orphanPages: issueTotals.orphan_sitemap_page ?? 0,
          } : {}),
        }),
        verification: verification ? JSON.stringify(verification) : null,
      },
    });
  } catch (e: any) {
    await prisma.siteAudit.update({
      where: { id: auditId },
      data: { status: "error", stage: "error", heartbeatAt: new Date(), finishedAt: new Date(), error: String(e?.message ?? e).slice(0, 500) },
    }).catch(() => {});
  } finally {
    activeAudits.delete(auditId);
  }
}

/**
 * The value that triggered each finding on one page.
 *
 * Deliberately short strings rather than structured objects: they are read by humans in a table and
 * by language models in a Markdown report, and both do better with "og:image, og:type" than with a
 * nested shape they have to interpret. Anything absent here simply has no useful detail to give —
 * "no title" adds nothing to the rule name.
 */
function buildEvidence(
  issues: string[],
  ctx: {
    facts: AuditPageFacts;
    signals: { openGraphMissing?: string[]; twitterCardMissing?: string[]; mixedContentUrls?: string[]; jsonLdInvalid?: number; htmlLang?: string; canonical?: string | null; viewportContent?: string } | null | undefined;
    securityHeaders: string[];
    redirectTo?: string | null;
    brokenLinks: string[];
    internalRedirectLinks?: string[];
  },
): Record<string, string> {
  const { facts, signals } = ctx;
  const list = (values: string[] | undefined, max = 4) => {
    const items = (values ?? []).filter(Boolean);
    if (!items.length) return "";
    const head = items.slice(0, max).join(", ");
    return items.length > max ? `${head} +${items.length - max}` : head;
  };
  const map: Record<string, string> = {
    http_error: `HTTP ${facts.httpStatus}`,
    fetch_failed: "no response",
    redirect: ctx.redirectTo ? `-> ${ctx.redirectTo}` : "",
    redirect_chain: `${facts.redirectHops} hops`,
    redirect_loop: "loop",
    title_too_long: `${facts.title.length} chars: ${facts.title.slice(0, 80)}`,
    title_too_short: `${facts.title.length} chars: ${facts.title.slice(0, 80)}`,
    title_duplicate: facts.title.slice(0, 90),
    description_too_long: `${facts.metaDescription.length} chars`,
    description_too_short: `${facts.metaDescription.length} chars: ${facts.metaDescription.slice(0, 80)}`,
    h1_multiple: `${facts.h1Count} H1`,
    noindex: facts.robots || "noindex",
    robots_conflict: facts.robots,
    canonical_invalid: `canonical: ${facts.canonical ?? "?"}`,
    canonical_mismatch: `canonical -> ${facts.canonical ?? "?"}`,
    thin_content: `${facts.wordCount} words`,
    images_no_alt: `${facts.imagesNoAlt} images`,
    broken_links: list(ctx.brokenLinks, 3),
    slow_response: `${facts.loadMs} ms`,
    lang_missing: facts.htmlLang ? `lang="${facts.htmlLang}"` : "no lang attribute",
    jsonld_invalid: `${facts.jsonLdInvalid} invalid block(s)`,
    open_graph_incomplete: list(signals?.openGraphMissing) || `${facts.openGraphMissing} missing`,
    twitter_card_incomplete: list(signals?.twitterCardMissing),
    mixed_content: list(signals?.mixedContentUrls, 3),
    security_headers_missing: list(ctx.securityHeaders, 6),
    orphan_sitemap_page: "in sitemap, no internal links",
    hreflang_invalid: (facts.hreflangInvalid ?? []).join("; "),
    hreflang_no_return: (facts.hreflangNoReturn ?? []).join("; "),
    hreflang_self_missing: "hreflang set does not include this page",
    hreflang_target_bad: (facts.hreflangTargetBad ?? []).join("; "),
    hreflang_x_default_missing: "≥ 2 languages, no x-default",
    lang_hreflang_mismatch: facts.langHreflangMismatch ?? "",
    viewport_not_responsive: signals?.viewportContent ? `viewport: ${signals.viewportContent}` : "viewport is fixed-width or blocks zoom",
    images_no_dimensions: `${facts.imagesNoDimensions ?? 0} images`,
    internal_redirect_links: list(ctx.internalRedirectLinks, 5),
    html_too_large: `${((facts.htmlBytes ?? 0) / (1024 * 1024)).toFixed(1)} MB HTML`,
    // "query \u001F impressions" — the UI interpolates the localized auditEvidenceQuery template,
    // the Markdown export renders its own English line.
    title_query_mismatch: facts.mainQuery ? `${facts.mainQuery.query}\u001F${facts.mainQuery.impressions}` : "",
  };
  const out: Record<string, string> = {};
  for (const code of issues) {
    const value = map[code];
    if (value) out[code] = value.slice(0, 240);
  }
  return out;
}
