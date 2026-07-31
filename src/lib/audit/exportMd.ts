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

export function buildAuditMarkdown(
  meta: AuditMeta,
  pages: AuditPage[],
  labelFor: (code: string) => string,
  aiLabels?: AiCrawlLabels,
): string {
  const host = (() => { try { return new URL(meta.siteUrl || "").host; } catch { return meta.siteUrl || "site"; } })();
  const out: string[] = [];

  out.push(`# Site audit — ${host}`, "");
  out.push(`- Crawled: ${meta.pagesCrawled ?? pages.length} pages (limit ${meta.maxPages ?? "—"})`);
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

  out.push("## Summary", "", "| Issue | Code | Pages |", "|---|---|---|");
  for (const [code, list] of ordered) out.push(`| ${esc(labelFor(code))} | \`${code}\` | ${list.length} |`);
  out.push("");

  for (const [code, list] of ordered) {
    out.push(`## ${labelFor(code)} — ${list.length}`, "", `Code: \`${code}\``, "");

    if (code === "broken_links") {
      // The only issue whose detail is a list of its own, so it gets a page → target table.
      out.push("| Page | Broken target |", "|---|---|");
      for (const p of list) {
        for (const target of p.brokenLinks ?? []) out.push(`| ${esc(shortUrl(p.url))} | ${esc(target)} |`);
      }
    } else {
      out.push("| Page | Detail |", "|---|---|");
      for (const p of list) out.push(`| ${esc(shortUrl(p.url))} | ${esc(detailFor(code, p))} |`);
    }
    out.push("");
  }

  out.push("---", "", `Full URLs are relative to ${meta.siteUrl || host}.`, "");
  return out.join("\n");
}
