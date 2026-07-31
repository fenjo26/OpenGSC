// Built-in site audit crawler — zero external APIs, zero cost. BFS-walks same-host
// pages from the site root with plain fetch + regex HTML extraction (no headless
// browser: the signals we audit — status codes, titles, meta, canonicals, link graph —
// all live in the raw HTML). Runs as a fire-and-forget job (same pattern as SeoJob):
// POST /api/audit creates the SiteAudit row and calls runAudit() without awaiting it.

import { prisma } from "@/lib/prisma";
import { checkAiCrawlability } from "@/lib/audit/aiCrawl";

const UA = "Mozilla/5.0 (compatible; OpenGSC-Audit/1.0; +https://opengsc.org)";
const PAGE_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const POLITENESS_DELAY_MS = 150; // per worker, between requests — be a good citizen on the user's own site

// ─── HTML extraction (regex — fine for the signals we need) ─────────────────────

const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (s: string) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

function extract(html: string) {
  const head = html.slice(0, 200_000);
  const title = decode(strip(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
  const metaDesc = decode(
    head.match(/<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)?.[1] ??
    head.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i)?.[1] ?? "");
  const robots = (
    head.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    head.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']robots["']/i)?.[1] ?? "").toLowerCase();
  const canonical = head.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1]
    ?? head.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)?.[1] ?? null;
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;

  const hrefs: string[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) hrefs.push(m[1]);

  const imgTags = html.match(/<img\s[^>]*>/gi) ?? [];
  const imagesNoAlt = imgTags.filter(t => !/\salt=["'][^"']+["']/i.test(t)).length;

  // Word count over body text with scripts/styles removed — a thin-content signal, not prose analytics.
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  const wordCount = strip(body).split(/\s+/).filter(w => w.length > 1).length;

  // Client-side render detection. The crawler fetches raw HTML only (no headless browser — see
  // ARCHITECTURE.md §7), so a SPA that mounts content via JS shows up as an empty shell here, and
  // every content-based signal below (word count, H1 presence) would be a lie about the rendered
  // page. These two flags feed the js_rendered issue in the second pass; detecting them here, on the
  // original html before script-stripping, is the only point where the evidence still exists.
  const spaMarker = /\bid=["']?(root|__next|__nuxt|app)["']?/i.test(html) || /data-reactroot|data-react-helmet/i.test(html);
  // A large inline/bundled script is the other half of the signal: near-empty static HTML with a
  // 50KB+ payload is the universal shape of a JS-bundled app shell. Measured on the raw html (the
  // body above has already had every <script> removed), summing all script tag contents.
  const hasLargeScript = (html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [])
    .reduce((sum, tag) => sum + tag.length, 0) > 50_000;

  return { title, metaDesc, robots, canonical, h1Count, hrefs, imagesNoAlt, wordCount, spaMarker, hasLargeScript };
}

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
  fetchError?: string;
}

async function fetchPage(url: string): Promise<PageResult> {
  const started = Date.now();
  try {
    // manual redirect handling so 301→ chains are visible as issues
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    const loadMs = Date.now() - started;
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status >= 300 && res.status < 400) {
      return { url, httpStatus: res.status, redirectTo: res.headers.get("location"), contentType, loadMs, html: null };
    }
    const isHtml = contentType.includes("html") || contentType === "";
    const html = res.ok && isHtml ? await res.text() : null;
    return { url, httpStatus: res.status, redirectTo: null, contentType, loadMs, html };
  } catch (e: any) {
    return { url, httpStatus: 0, redirectTo: null, contentType: "", loadMs: Date.now() - started, html: null, fetchError: String(e?.message ?? e).slice(0, 120) };
  }
}

// ─── issue detection ────────────────────────────────────────────────────────────

export const ISSUE_CODES = [
  "http_error", "fetch_failed", "redirect", "title_missing", "title_too_long", "title_duplicate",
  "description_missing", "description_too_long", "h1_missing", "h1_multiple", "noindex",
  "canonical_mismatch", "thin_content", "images_no_alt", "broken_links", "slow_response",
  "js_rendered",
] as const;

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
}

function buildIgnoreList(opts?: AuditOptions): string[] {
  const custom = (opts?.ignorePatterns ?? [])
    .flatMap(p => String(p).split(/[\n,]/))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return opts?.skipDefaultIgnores ? custom : [...DEFAULT_IGNORE, ...custom];
}

export async function runAudit(auditId: string, opts?: AuditOptions): Promise<void> {
  const audit = await prisma.siteAudit.findUnique({ where: { id: auditId }, include: { site: true } });
  if (!audit) return;
  try {
    const rootUrl = audit.site.url.startsWith("http") ? audit.site.url : `https://${audit.site.url.replace(/^sc-domain:/, "")}`;
    const root = new URL(rootUrl);
    const maxPages = Math.min(500, Math.max(10, audit.maxPages));

    // AI Crawlability is a site-wide check (robots.txt + /llms.txt), independent of which pages get
    // crawled. Started before the BFS loop so its two requests overlap with the page crawl rather
    // than serialising after it, and awaited only where its result is consumed (the summary below).
    const aiCrawlPromise = checkAiCrawlability(root).catch(() => null);

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
    const results = new Map<string, PageResult & { depth: number; ex?: ReturnType<typeof extract>; internalTargets?: string[] }>();

    let crawled = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && crawled < maxPages) {
        const item = queue.shift();
        if (!item) break;
        crawled++;
        const page = await fetchPage(item.url);
        const entry: any = { ...page, depth: item.depth };
        if (page.html) {
          const ex = extract(page.html);
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
          await prisma.siteAudit.update({ where: { id: auditId }, data: { pagesCrawled: crawled } }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, POLITENESS_DELAY_MS));
      }
    });
    await Promise.all(workers);

    // ── second pass: issues (needs the full crawl map for broken links & duplicate titles)
    const statusOf = new Map<string, number>();
    for (const [url, r] of results) statusOf.set(url, r.httpStatus);
    const titleCount = new Map<string, number>();
    for (const r of results.values()) {
      const t = r.ex?.title?.toLowerCase().trim();
      if (t) titleCount.set(t, (titleCount.get(t) ?? 0) + 1);
    }

    const issueTotals: Record<string, number> = {};
    const bump = (code: string) => { issueTotals[code] = (issueTotals[code] ?? 0) + 1; };

    const rows: any[] = [];
    for (const [url, r] of results) {
      const issues: string[] = [];
      const broken: string[] = [];
      if (r.httpStatus === 0) issues.push("fetch_failed");
      else if (r.httpStatus >= 400) issues.push("http_error");
      else if (r.httpStatus >= 300) issues.push("redirect");
      if (r.loadMs > 3000) issues.push("slow_response");
      if (r.ex) {
        const { title, metaDesc, robots, canonical, h1Count, imagesNoAlt, wordCount, spaMarker, hasLargeScript, hrefs } = r.ex;
        if (!title) issues.push("title_missing");
        else {
          if (title.length > 65) issues.push("title_too_long");
          if ((titleCount.get(title.toLowerCase().trim()) ?? 0) > 1) issues.push("title_duplicate");
        }
        if (!metaDesc) issues.push("description_missing");
        else if (metaDesc.length > 165) issues.push("description_too_long");
        // Client-side render detection — three signals together, never one. A near-empty text body
        // with no navigation links AND a SPA marker or large bundle is the shape of an unrendered JS
        // app shell, not a thin static page. Requiring all three keeps false positives off the many
        // static sites that happen to ship analytics scripts or a small framework bootstrapper.
        const jsRendered = wordCount < 30 && hrefs.length <= 1 && (spaMarker || hasLargeScript);
        if (jsRendered) {
          issues.push("js_rendered");
        } else {
          // h1_missing and thin_content are suppressed on a JS-rendered shell because they describe
          // the (empty) raw HTML, not the rendered DOM — flagging them would send the user to "fix"
          // content that exists, just not in the bytes the crawler received.
          if (h1Count === 0) issues.push("h1_missing");
          if (h1Count > 1) issues.push("h1_multiple");
          if (wordCount < 150) issues.push("thin_content");
        }
        if (/noindex/.test(robots)) issues.push("noindex");
        if (canonical) {
          try {
            const c = new URL(canonical, url);
            const here = new URL(url);
            if (c.href.replace(/\/$/, "") !== here.href.replace(/\/$/, "")) issues.push("canonical_mismatch");
          } catch { /* malformed canonical — ignore */ }
        }
        if (imagesNoAlt > 0) issues.push("images_no_alt");
        for (const target of new Set(r.internalTargets ?? [])) {
          const st = statusOf.get(target);
          if (st !== undefined && (st >= 400 || st === 0)) broken.push(target);
        }
        if (broken.length) issues.push("broken_links");
      }
      for (const code of issues) bump(code);
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
        noindex: /noindex/.test(r.ex?.robots ?? ""),
        internalLinks: new Set(r.internalTargets ?? []).size,
        externalLinks: r.ex ? r.ex.hrefs.length - (r.internalTargets?.length ?? 0) : 0,
        imagesNoAlt: r.ex?.imagesNoAlt ?? 0,
        wordCount: r.ex?.wordCount ?? 0,
        loadMs: r.loadMs,
        depth: r.depth,
        issues: issues.length ? JSON.stringify(issues) : null,
        brokenLinks: broken.length ? JSON.stringify(broken.slice(0, 50)) : null,
      });
    }

    // createMany is not supported for SQLite pre-Prisma5-style in all setups — chunked create is fine here.
    for (let i = 0; i < rows.length; i += 50) {
      await prisma.siteAuditPage.createMany({ data: rows.slice(i, i + 50) });
    }

    const pagesWithIssues = rows.filter(r => r.issues).length;
    // Awaited here, at the only point its result is used: the summary. By now the crawl has run
    // its course, so a slow robots/llms fetch (or one that already resolved) costs no extra latency.
    // The catch above already nulls a failed check, so a network error here never fails the audit.
    const aiCrawlability = await aiCrawlPromise;
    await prisma.siteAudit.update({
      where: { id: auditId },
      data: {
        status: "completed",
        finishedAt: new Date(),
        pagesCrawled: rows.length,
        summary: JSON.stringify({
          pages: rows.length,
          pagesWithIssues,
          healthScore: rows.length ? Math.round(100 * (1 - pagesWithIssues / rows.length)) : 0,
          issues: issueTotals,
          avgLoadMs: rows.length ? Math.round(rows.reduce((s, r) => s + r.loadMs, 0) / rows.length) : 0,
          // Site-wide (not per-page), so it lives in the summary rather than as a row issue. Old
          // audits predating this field simply have no key, and the UI renders nothing for them.
          ...(aiCrawlability ? { aiCrawlability } : {}),
        }),
      },
    });
  } catch (e: any) {
    await prisma.siteAudit.update({
      where: { id: auditId },
      data: { status: "error", finishedAt: new Date(), error: String(e?.message ?? e).slice(0, 500) },
    }).catch(() => {});
  }
}
