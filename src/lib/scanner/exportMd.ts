import type { ScanReport } from "./scan";

/**
 * A scan as Markdown, for the same reason the site audit has one: the report is worth keeping, and
 * it is routinely handed to someone (or something) that will act on it. Grouped the way a person
 * reads a competitor — what it is, what it runs on, how big it is, what is wrong with it, and who
 * else it belongs to — rather than in the order the scanner happened to collect it.
 */
export interface ScanRelated { host: string; matches: string[]; strength: "strong" | "weak" }

const esc = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
const row = (label: string, value: unknown) => `| ${label} | ${esc(value) || "—"} |`;

export function buildScanMarkdown(
  report: ScanReport,
  related: ScanRelated[],
  labelFor: (code: string) => string,
): string {
  const out: string[] = [];
  out.push(`# Site scan — ${report.host}`, "");
  out.push(`- URL: ${report.finalUrl}${report.redirected ? ` (redirected from ${report.url})` : ""}`);
  out.push(`- HTTP ${report.httpStatus} · ${report.https ? "HTTPS" : "HTTP only"} · ${report.loadMs} ms · ${Math.round(report.bytes / 1024)} KB`);
  out.push(`- Score: ${report.score}/100`);
  out.push(`- Scanned: ${report.scannedAt.replace("T", " ").slice(0, 16)}`, "");

  if (related.length) {
    out.push("## Probably the same owner", "");
    out.push("An analytics property, tag container or ads publisher id is billed to one person, so a", "match there is strong. Shared nameservers only mean a shared DNS provider — weak.", "");
    out.push("| Domain | Strength | Shared signals |", "|---|---|---|");
    for (const item of related) out.push(`| ${esc(item.host)} | ${item.strength} | ${esc(item.matches.join("; "))} |`);
    out.push("");
  }

  out.push("## Findings", "");
  if (!report.findings.length) out.push("None on this page.", "");
  else {
    out.push("| Severity | Finding | Detail |", "|---|---|---|");
    for (const f of report.findings) out.push(`| ${f.severity} | ${esc(labelFor(f.id))} | ${esc(f.evidence)} |`);
    out.push("");
  }

  if (report.cloaking) {
    out.push("## Googlebot vs browser", "");
    out.push(`Verdict: **${report.cloaking.verdict}** (score ${report.cloaking.score})`, "");
    out.push("| | Googlebot | Browser |", "|---|---|---|");
    out.push(`| HTTP | ${report.cloaking.googlebot.status} | ${report.cloaking.browser.status} |`);
    out.push(`| Final URL | ${esc(report.cloaking.googlebot.finalUrl)} | ${esc(report.cloaking.browser.finalUrl)} |`);
    out.push(`| Title | ${esc(report.cloaking.googlebot.title)} | ${esc(report.cloaking.browser.title)} |`);
    out.push(`| Words | ${report.cloaking.googlebot.words} | ${report.cloaking.browser.words} |`);
    out.push(`| Indexable | ${report.cloaking.googlebot.indexable ? "yes" : "no"} | ${report.cloaking.browser.indexable ? "yes" : "no"} |`);
    out.push("");
    if (report.cloaking.flags.length) out.push(...report.cloaking.flags.map(flag => `- ${flag}`), "");
    if (report.cloaking.redirectChain.length > 1) out.push(`Redirect chain: ${report.cloaking.redirectChain.join(" -> ")}`, "");
  }

  out.push("## Platform", "", "| Field | Value |", "|---|---|");
  out.push(row("CMS", report.platform.cms));
  out.push(row("Framework", report.platform.framework));
  out.push(row("Generator", report.platform.generator));
  out.push(row("Server", report.platform.server));
  out.push(row("X-Powered-By", report.platform.poweredBy));
  out.push(row("Detected stack", report.platform.hints.join(", ")));
  const wp = report.platform.wordpress;
  if (wp) {
    out.push(row("WordPress theme", wp.themes.join(", ")));
    out.push(row("WordPress plugins", wp.plugins.length ? `${wp.plugins.length}: ${wp.plugins.join(", ")}` : ""));
    out.push(row("Exposed usernames", wp.restUsers.join(", ")));
    out.push(row("xmlrpc.php reachable", wp.xmlrpc ? "yes" : "no"));
    out.push(row("readme.html public", wp.readme ? "yes" : "no"));
  }
  out.push("");

  out.push("## Infrastructure", "", "| Field | Value |", "|---|---|");
  out.push(row("IP", report.infra.ips.join(", ")));
  out.push(row("Nameservers", report.infra.nameservers.join(", ")));
  out.push(row("MX", report.infra.mx.join(", ")));
  out.push(row("CDN", report.infra.cdn));
  out.push("");

  out.push("## Scale & crawlability", "", "| Field | Value |", "|---|---|");
  out.push(row("URLs in sitemap", report.scale.sitemapUrls));
  out.push(row("Sitemaps", report.scale.sitemaps.join(", ")));
  out.push(row("Languages", report.scale.languages.join(", ")));
  out.push(row("robots.txt", report.ai.robotsTxt ? "present" : "missing"));
  out.push(row("llms.txt", report.ai.llmsTxt ? "present" : "missing"));
  out.push(row("Blocked AI crawlers", report.ai.blockedBots.join(", ")));
  out.push("");

  out.push("## Homepage", "", "| Field | Value |", "|---|---|");
  out.push(row("Title", `${report.facts.title} (${report.facts.titleLength})`));
  out.push(row("Description", report.facts.metaDescription));
  out.push(row("H1", report.facts.h1Count));
  out.push(row("Words", report.facts.wordCount));
  out.push(row("Canonical", report.facts.canonical));
  out.push(row("Robots", report.facts.robots));
  out.push(row("JSON-LD blocks", report.facts.schemaBlocks));
  out.push(row("Images without alt", report.facts.imagesNoAlt));
  out.push(row("Language", report.facts.language));
  out.push("");

  // The identifiers themselves, last: useful to paste into a search engine or another tool, and
  // uninteresting until the reader has decided the rest of the report is worth acting on.
  const fp = report.fingerprints as Record<string, string[] | string | null>;
  const identifiers = Object.entries(fp)
    .filter(([, value]) => Array.isArray(value) ? value.length : !!value)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
  if (identifiers.length) {
    out.push("## Identifiers found on the page", "", ...identifiers.map(line => `- ${line}`), "");
  }
  return out.join("\n");
}
