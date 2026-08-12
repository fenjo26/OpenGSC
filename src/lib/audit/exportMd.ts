// Markdown export of a site audit, written to be handed to a developer or an AI agent.
//
// Grouped BY ISSUE rather than by page, which is the whole point. The on-screen table is page-first
// because you browse it page by page; someone fixing the site works problem by problem — every URL
// missing an H1 in one list, every broken target in one table. A page-first dump would force the
// reader to regroup it themselves before they could act.
//
// Each issue also carries the specific value that triggered it (the status code, the word count,
// the offending title), because "thin_content on /about" is not actionable while "thin_content on
// /about — 84 words" is.

export interface AuditPage {
  url: string; httpStatus: number; redirectTo?: string | null; title?: string;
  metaDescription?: string; h1Count?: number; canonical?: string | null; noindex?: boolean;
  imagesNoAlt?: number; wordCount?: number; loadMs?: number; depth?: number;
  issues?: string[]; brokenLinks?: string[];
  /** Issue code → the value that triggered it, captured during the crawl. */
  evidence?: Record<string, string> | null;
}

export interface AuditSummary {
  healthScore?: number;
  issues?: Record<string, number>;
  [k: string]: unknown;
}

// Mirrors AiCrawlReport in aiCrawl.ts. Duplicated as a local interface (not imported) because this
// module is pure data shaping with no runtime dependency on the crawler — the summary arrives as a
// parsed JSON object over the API boundary, and a structural interface is all that's needed.
export interface AiCrawlSummary {
  robots: { status: "ok" | "missing" | "failed"; present: boolean };
  llmsTxt: { status: "ok" | "missing" | "failed"; present: boolean };
  bots: { token: string; engine: string; status: "allowed" | "blocked" | "unknown" }[];
  blockedCount: number;
  total: number;
}

export interface AiCrawlLabels {
  title: string;
  blocked: string;
  allowed: string;
  unknown: string;
  robotsMissing: string;
  robotsFailed: string;
  llmsMissing: string;
}

export interface AuditMeta {
  siteUrl?: string; startedAt?: string; finishedAt?: string | null;
  pagesCrawled?: number; maxPages?: number; summary?: AuditSummary | null;
}

/** Path only — the host repeats on every line and adds nothing but width. */
const shortUrl = (u: string) => {
  try { return new URL(u).pathname + new URL(u).search || "/"; } catch { return u; }
};

const esc = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

/**
 * The value that actually triggered this issue on this page.
 * Returns raw text — escaping happens once, at the table row. Escaping here as well turned a pipe
 * in a page title into `\\|`, which renders as a stray backslash instead of a pipe.
 */
function detailFor(code: string, p: AuditPage): string {
  switch (code) {
    case "http_error": return `HTTP ${p.httpStatus}`;
    case "fetch_failed": return "no response";
    case "redirect": return `→ ${p.redirectTo || "?"}`;
    case "title_missing": return "no title";
    case "title_too_long": return `${(p.title || "").length} chars`;
    case "title_duplicate": return p.title || "";
    case "description_missing": return "no description";
    case "description_too_long": return `${(p.metaDescription || "").length} chars`;
    case "h1_missing": return "0 H1";
    case "h1_multiple": return `${p.h1Count ?? 0} H1`;
    case "noindex": return "noindex";
    case "canonical_mismatch": return `canonical → ${p.canonical || "?"}`;
    case "thin_content": return `${p.wordCount ?? 0} words`;
    case "images_no_alt": return `${p.imagesNoAlt ?? 0} images`;
    case "slow_response": return `${p.loadMs ?? 0} ms`;
    case "broken_links": return `${(p.brokenLinks ?? []).length} links`;
    case "js_rendered": return "client-rendered";
    default: return "";
  }
}

/** Rows per issue table before the list moves to the appendix. */
const MAX_ROWS = 20;

/**
 * One line per rule on what to actually change.
 *
 * Written for whoever — or whatever — will do the work: the report is routinely handed to an agent,
 * and "Open Graph incomplete" without a fix instruction produces a confident guess rather than a
 * correct edit. Kept in English on purpose: this is developer-facing output, and mixing a localized
 * label with an English code and an English fix reads worse than being consistent about it.
 */
const FIXES: Record<string, string> = {
  http_error: "Return 200 for pages that should exist, or remove the internal links pointing at them.",
  fetch_failed: "The server did not respond — check availability, DNS and firewall rules for crawlers.",
  redirect: "Point internal links at the final URL so no hop is needed.",
  redirect_chain: "Collapse the chain to a single 301 from the original URL to the final one.",
  redirect_loop: "Two rules are fighting each other; keep one and delete the other.",
  title_missing: "Add a unique <title> describing the page's specific intent.",
  title_too_long: "Trim to roughly 60 characters so it is not truncated in search results.",
  title_duplicate: "Two pages claim the same title; differentiate them or consolidate the pages.",
  description_missing: "Add a meta description; without one Google writes its own from the page.",
  description_too_long: "Trim to roughly 155 characters.",
  h1_missing: "Add a single H1 stating what the page is about.",
  h1_multiple: "Keep one H1 and demote the rest to H2.",
  noindex: "If this page should rank, remove the noindex directive from the meta robots tag or X-Robots-Tag header.",
  robots_conflict: "The robots directives contradict each other (e.g. index and noindex); keep one.",
  canonical_missing: "Add a self-referencing canonical link.",
  canonical_invalid: "The canonical URL is malformed or relative; use an absolute, resolvable URL.",
  canonical_mismatch: "The canonical points elsewhere, so this page is asking not to be indexed. Confirm that is intended.",
  thin_content: "Either expand the page to answer its query, or consolidate it into a stronger one.",
  images_no_alt: "Add descriptive alt text; empty alt is correct only for decorative images.",
  broken_links: "Update or remove the links whose targets return 4xx/5xx.",
  orphan_sitemap_page: "The page is in the sitemap but nothing links to it internally. Link it from a relevant page.",
  slow_response: "Server response time is high — check caching, database queries and hosting.",
  js_rendered: "Key content appears only after JavaScript runs; server-render it so crawlers see it without executing scripts.",
  viewport_missing: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.",
  lang_missing: "Set the lang attribute on <html> so search engines and screen readers know the language.",
  jsonld_invalid: "A JSON-LD block does not parse; validate it and fix the syntax.",
  organization_schema_incomplete: "Complete the Organization schema (name, url, logo, sameAs) — it feeds knowledge panels and AI answers.",
  open_graph_incomplete: "Add the missing Open Graph tags to the shared layout: og:title, og:description and an absolute og:image URL.",
  twitter_card_incomplete: "Add twitter:card (summary_large_image) plus twitter:title and twitter:description, usually in the same layout as Open Graph.",
  mixed_content: "Assets are loaded over http:// on an https:// page; switch them to https or protocol-relative URLs.",
  security_headers_missing: "Add the missing response headers at the web server or CDN level.",
};

/** Stored evidence when the crawl captured it, otherwise whatever can be derived from the row. */
function evidenceFor(code: string, p: AuditPage): string {
  return p.evidence?.[code] || detailFor(code, p);
}

export function buildAuditMarkdown(
  meta: AuditMeta,
  pages: AuditPage[],
  labelFor: (code: string) => string,
  aiLabels?: AiCrawlLabels,
): string {
  const host = (() => { try { return new URL(meta.siteUrl || "").host; } catch { return meta.siteUrl || "site"; } })();
  const out: string[] = [];

  out.push(`# Site audit — ${host}`, "");
  // "210 pages (limit 500)" leaves the reader to work out whether the crawl finished or gave up.
  const hitLimit = meta.maxPages != null && (meta.pagesCrawled ?? 0) >= meta.maxPages;
  out.push(hitLimit
    ? `- Crawled: ${meta.pagesCrawled} pages — stopped at the ${meta.maxPages}-page limit, so the site may have more`
    : `- Crawled: ${meta.pagesCrawled ?? pages.length} pages (the whole site as far as the crawler could reach it)`);
  if (meta.finishedAt) out.push(`- Finished: ${new Date(meta.finishedAt).toISOString().replace("T", " ").slice(0, 16)}`);
  if (meta.summary?.healthScore != null) out.push(`- Health score: ${meta.summary.healthScore}/100`);
  out.push("");

  // AI Crawlability — site-wide section, emitted before the page-level issues so a reader skimming
  // the top of the report sees the "are we even crawlable by AI?" verdict first. Only rendered when
  // the audit actually ran the check (older audits have no key) and labels were supplied.
  const ai = meta.summary?.aiCrawlability as AiCrawlSummary | undefined;
  if (ai && aiLabels) {
    out.push(`## ${aiLabels.title}`, "");
    out.push(`- robots.txt: ${ai.robots.present ? "present" : ai.robots.status === "failed" ? aiLabels.robotsFailed : aiLabels.robotsMissing}`);
    out.push(`- /llms.txt: ${ai.llmsTxt.present ? "present" : aiLabels.llmsMissing}`);
    out.push(`- Blocked AI crawlers: ${ai.blockedCount} of ${ai.total}`, "");
    out.push("| Engine | Token | Status |", "|---|---|---|");
    for (const b of ai.bots) {
      const status = b.status === "blocked" ? aiLabels.blocked : b.status === "allowed" ? aiLabels.allowed : aiLabels.unknown;
      out.push(`| ${esc(b.engine)} | \`${b.token}\` | ${status} |`);
    }
    out.push("");
  }


  // Group pages by issue code, preserving crawl order within each group.
  const byIssue = new Map<string, AuditPage[]>();
  for (const p of pages) {
    for (const code of p.issues ?? []) {
      const arr = byIssue.get(code) ?? [];
      arr.push(p);
      byIssue.set(code, arr);
    }
  }

  if (byIssue.size === 0) {
    out.push("No issues found.", "");
    return out.join("\n");
  }

  // Most frequent first — that is the order the work should be done in.
  const ordered = [...byIssue.entries()].sort((a, b) => b[1].length - a[1].length);
  const crawled = meta.pagesCrawled ?? pages.length;

  // A finding on nearly every page is one template problem, not hundreds of page problems. Saying
  // so changes what the reader does with it: edit one layout file instead of opening 210 pages, and
  // an agent handed this report stops planning 210 separate edits.
  const isSiteWide = (count: number) => crawled >= 5 && count >= Math.ceil(crawled * 0.8);

  out.push("## Summary", "", "| Issue | Code | Pages | Scope |", "|---|---|---|---|");
  for (const [code, list] of ordered) {
    out.push(`| ${esc(labelFor(code))} | \`${code}\` | ${list.length} | ${isSiteWide(list.length) ? "site-wide (template)" : "specific pages"} |`);
  }
  out.push("");
  out.push(
    `> Health score counts critical and warning findings only, which is why a score can stay high`,
    `> while informational findings affect every page.`,
    "",
  );

  for (const [code, list] of ordered) {
    const siteWide = isSiteWide(list.length);
    out.push(`## ${labelFor(code)} — ${list.length}${siteWide ? " (site-wide)" : ""}`, "", `Code: \`${code}\``, "");

    const fix = FIXES[code];
    if (fix) out.push(`Fix: ${fix}`, "");
    if (siteWide) {
      out.push(
        `Affects ${list.length} of ${crawled} crawled pages, so it almost certainly lives in a shared`,
        `template or layout rather than in the individual pages. Fix it once there and re-run the audit.`,
        "",
      );
    }

    if (code === "broken_links") {
      // The only issue whose detail is a list of its own, so it gets a page → target table.
      out.push("| Page | Broken target |", "|---|---|");
      let printed = 0;
      for (const p of list) {
        for (const target of p.brokenLinks ?? []) {
          if (printed++ >= MAX_ROWS) break;
          out.push(`| ${esc(shortUrl(p.url))} | ${esc(target)} |`);
        }
        if (printed >= MAX_ROWS) break;
      }
      if (printed >= MAX_ROWS) out.push(`| … | more targets omitted |`);
      out.push("");
      continue;
    }

    // For a site-wide finding the evidence is the same everywhere, so one example carries it and the
    // rest of the list is noise. For a scattered one every row matters — up to a readable ceiling.
    const shown = siteWide ? list.slice(0, 3) : list.slice(0, MAX_ROWS);
    out.push("| Page | Detail |", "|---|---|");
    for (const p of shown) out.push(`| ${esc(shortUrl(p.url))} | ${esc(evidenceFor(code, p))} |`);
    out.push("");
    if (list.length > shown.length) {
      out.push(`${list.length - shown.length} more page(s) with the same finding — see the appendix.`, "");
    }
  }

  // The appendix exists for findings scattered across a subset of pages, where knowing exactly
  // which ones is the work. A site-wide finding is on everything by definition, so printing the
  // same two hundred paths again — once per template issue — pads the file without adding a fact.
  const overflow = ordered.filter(([, list]) => !isSiteWide(list.length) && list.length > MAX_ROWS);
  const siteWideCodes = ordered.filter(([, list]) => isSiteWide(list.length));
  if (overflow.length || siteWideCodes.length) {
    out.push("## Appendix — affected pages", "");
    for (const [code, list] of siteWideCodes) {
      out.push(`- \`${code}\`: all ${list.length} crawled pages${list.length < crawled ? ` (of ${crawled})` : ""}.`);
    }
    if (siteWideCodes.length) out.push("");
    for (const [code, list] of overflow) {
      out.push(`### \`${code}\` (${list.length})`, "");
      out.push(list.map(p => shortUrl(p.url)).join("\n"), "");
    }
  }

  out.push("---", "", `Full URLs are relative to ${meta.siteUrl || host}.`, "");
  return out.join("\n");
}
