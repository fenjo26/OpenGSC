// N9 — proposal and first-letter generation. Deterministic, LLM-free: every sentence is
// picked from the dictionary in ./i18n.ts, so the output is reproducible and auditable.
//
// THE RULE THIS MODULE ENFORCES (N9 brief §4, written into docs/LEADS.md):
// a proposal contains NO traffic, ranking or revenue forecasts. A crawl of up to 5 pages
// cannot justify a number, and a proposal is a document the client will hold you to.
// NO_FORECAST_MARKERS below is the dictionary the test walks — every marker must stay
// absent from every language's generated text.

import { LEAD_STRINGS } from "./i18n";
import { FINDING_CATEGORIES, type FindingCode, type LeadFinding, type LeadLang } from "./types";
import { topFindings } from "./findings";

/** Markers that must never appear in a generated proposal (checked case-insensitively). */
export const NO_FORECAST_MARKERS = [
  "прогноз", "forecast", "увеличим трафик на", "will increase your traffic",
  "guaranteed rankings", "гарантируем позиции", "top of google", "первые места",
  "x2 traffic", "traffic will grow", "рост трафика на",
  // the same promise in the languages the dictionary speaks
  "prévision", "prevision", "prognose", "预测", "зростання трафіку на",
];

export function containsForecast(text: string): boolean {
  const lower = text.toLowerCase();
  return NO_FORECAST_MARKERS.some(marker => lower.includes(marker));
}

export interface ProposalInput {
  domain: string;
  score: number;
  findings: LeadFinding[];
  lang: LeadLang;
  /** "" → the placeholder inviting the operator to describe the company. */
  aboutCompany: string;
  /** Finding codes the operator ticked; empty = all. */
  include?: string[];
  date?: Date;
}

/** Group findings by category, preserving the audit's severity order inside each group. */
export function groupFindings(findings: LeadFinding[]): Array<{ category: string; findings: LeadFinding[] }> {
  const groups: Array<{ category: string; findings: LeadFinding[] }> = [];
  for (const category of FINDING_CATEGORIES) {
    const inCategory = findings.filter(f => f.category === category);
    if (inCategory.length) groups.push({ category, findings: inCategory });
  }
  // Any category the type system does not know (forward-compat) still gets a section.
  for (const f of findings) {
    if (!FINDING_CATEGORIES.includes(f.category)) {
      const group = groups.find(g => g.category === f.category);
      if (group) group.findings.push(f);
      else groups.push({ category: f.category, findings: [f] });
    }
  }
  return groups;
}

/** The proposal skeleton, filled from the findings dictionary. */
export function generateProposal(input: ProposalInput): string {
  const L = LEAD_STRINGS[input.lang];
  const date = (input.date ?? new Date()).toISOString().slice(0, 10);
  const included = input.include?.length
    ? input.findings.filter(f => input.include!.includes(f.code))
    : input.findings;

  const lines: string[] = [];
  lines.push(`# ${L.proposal.docTitle(input.domain)}`);
  lines.push("");
  lines.push(`_${date}_`);
  lines.push("");
  lines.push(`## ${L.proposal.about}`);
  lines.push(input.aboutCompany.trim() || L.proposal.aboutPlaceholder);
  lines.push("");
  lines.push(`## ${L.proposal.found}`);
  if (!included.length) {
    lines.push(L.proposal.noPromises);
  }
  for (const group of groupFindings(included)) {
    const label = L.proposal.categories[group.category as keyof typeof L.proposal.categories] ?? group.category;
    lines.push("");
    lines.push(`### ${label}`);
    for (const f of group.findings) {
      lines.push(`- **${f.title}**${f.evidence ? ` (${f.evidence})` : ""}. ${LEAD_STRINGS[input.lang].findings[f.code as FindingCode]?.consequence ?? ""}`);
    }
  }
  lines.push("");
  lines.push(`## ${L.proposal.scope}`);
  for (const f of included) {
    lines.push(`- [ ] ${f.title} — ${f.fix}`);
  }
  lines.push("");
  lines.push(`## ${L.proposal.pricing}`);
  lines.push("| # | " + L.proposal.scope + " | $ |");
  lines.push("|---|---|---|");
  included.forEach((f, i) => lines.push(`| ${i + 1} | ${f.title} |  |`));
  lines.push("");
  lines.push(`_${L.proposal.priceNote}_`);
  lines.push("");
  lines.push(`## ${L.proposal.timeline}`);
  lines.push(L.proposal.timelinePlaceholder);
  lines.push("");
  lines.push(`## ${L.proposal.nextStep}`);
  lines.push(L.proposal.nextStepText);
  lines.push("");
  lines.push("---");
  lines.push(`_${L.proposal.noPromises}_`);
  return lines.join("\n");
}

export interface DraftEmail {
  subject: string;
  body: string;
}

/** The deterministic first letter: greeting, the 3 worst problems in plain words, a call offer. */
export function generateDraftEmail(input: {
  domain: string;
  score: number;
  findings: LeadFinding[];
  lang: LeadLang;
  leadName: string;
  /** Operator's custom template from the widget settings; "" = the built-in one. */
  template?: string;
}): DraftEmail {
  const L = LEAD_STRINGS[input.lang];
  const top = topFindings(input.findings, 3);
  const issues = top.map(f => `- ${f.title}${f.evidence ? ` (${f.evidence})` : ""}`).join("\n");

  if (input.template && input.template.trim()) {
    const fill = (s: string) => s
      .replaceAll("{name}", input.leadName || "")
      .replaceAll("{domain}", input.domain)
      .replaceAll("{score}", String(input.score))
      .replaceAll("{issues}", issues);
    const subject = fill(L.letter.subject(input.domain));
    return { subject, body: fill(input.template) };
  }

  const body = [
    L.letter.greeting(input.leadName),
    "",
    L.letter.intro(input.domain, input.score),
    issues,
    "",
    L.letter.offer,
    "",
    L.letter.closing,
  ].join("\n");
  return { subject: L.letter.subject(input.domain), body };
}

/** mailto: URL for the "Write" button (the operator edits the draft in their mail client). */
export function mailtoUrl(to: string, draft: DraftEmail): string {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
}

// ─── branded HTML export ──────────────────────────────────────────────────────

/** The white-label look (N8's User.reportBranding JSON, read tolerantly — only read). */
export interface ProposalBranding {
  companyName: string;
  logoUrl: string;
  accentColor: string;
  footerText: string;
}

export function parseBranding(raw: string | null | undefined): ProposalBranding {
  const base: ProposalBranding = { companyName: "", logoUrl: "", accentColor: "#3B82F6", footerText: "" };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pick = (key: string): string => (typeof parsed[key] === "string" ? (parsed[key] as string).slice(0, 300) : "");
    // The logo is the one field that may legitimately be huge: N8 stores it as a base64
    // data-URL (≤ 200 KiB decoded). Anything else stays capped; a logo must be a data-URL
    // or https, and neither kind ever gets past a broken 300-char cut.
    const rawLogo = typeof parsed.logoDataUrl === "string" ? parsed.logoDataUrl : (pick("logoUrl") || pick("logo"));
    const logoOk = (v: string): boolean => v.startsWith("data:image/") || /^https:\/\//i.test(v);
    const logoUrl = logoOk(rawLogo) ? rawLogo.slice(0, 300_000) : "";
    return {
      companyName: pick("companyName") || pick("company") || pick("name"),
      logoUrl,
      accentColor: /^#[0-9a-fA-F]{6}$/.test(pick("accentColor")) ? pick("accentColor") : base.accentColor,
      footerText: pick("footerText") || pick("footer"),
    };
  } catch {
    return base;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Minimal markdown → HTML for the proposal subset (headings, lists, bold, italics, tables). */
export function proposalToHtml(markdown: string, branding: ProposalBranding, title: string): string {
  const escape = escapeHtml;
  const inline = (s: string): string => escape(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)_([^_]+)_/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = markdown.split("\n");
  const html: string[] = [];
  let inList = false;
  let inTable = false;
  const closeList = () => { if (inList) { html.push("</ul>"); inList = false; } };
  const closeTable = () => { if (inTable) { html.push("</tbody></table>"); inTable = false; } };

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList(); closeTable();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*-\s+\[[ xX]\]\s+/.test(line) || /^\s*-\s+/.test(line)) {
      closeTable();
      if (!inList) { html.push("<ul>"); inList = true; }
      const checked = /\[x\]/i.test(line);
      const text = line.replace(/^\s*-\s+(\[[ xX]\]\s+)?/, "");
      html.push(`<li>${checked ? "☑ " : "☐ "}${inline(text)}</li>`);
      continue;
    }
    if (/^\|/.test(line)) {
      if (/^\|[\s:-]+\|/.test(line)) continue; // table separator row
      if (!inTable) { closeList(); html.push("<table><tbody>"); inTable = true; }
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      html.push(`<tr>${cells.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`);
      continue;
    }
    closeList(); closeTable();
    if (line.trim() === "") continue;
    if (line.trim() === "---") { html.push("<hr>"); continue; }
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();

  const logo = branding.logoUrl
    ? `<img src="${escape(branding.logoUrl)}" alt="${escape(branding.companyName)}" style="max-height:44px;vertical-align:middle">`
    : "";
  const company = branding.companyName ? `<span style="font-weight:700;font-size:15px">${escape(branding.companyName)}</span>` : "";
  const header = logo || company
    ? `<div style="margin-bottom:26px;display:flex;align-items:center;gap:12px">${logo}${company}</div>`
    : "";
  const footer = branding.footerText
    ? `<div style="margin-top:44px;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">${escape(branding.footerText)}</div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; max-width: 760px; margin: 0 auto; padding: 40px 20px; line-height: 1.55; }
  h1 { font-size: 26px; border-bottom: 3px solid ${branding.accentColor}; padding-bottom: 8px; }
  h2 { font-size: 19px; margin-top: 32px; color: #111827; }
  h3 { font-size: 15px; color: #374151; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  td { border: 1px solid #e5e7eb; padding: 7px 10px; font-size: 13px; }
  ul { padding-left: 20px; } li { margin: 5px 0; }
  @media print { body { padding: 10mm; } }
</style>
</head>
<body>
${header}
${html.join("\n")}
${footer}
</body>
</html>`;
}
