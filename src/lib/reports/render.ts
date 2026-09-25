// N8 — the frozen-snapshot renderer. Pure module: data in, HTML string out. No Prisma,
// no React, no network — so the exact HTML a client will receive is unit-testable.
//
// The output is deliberately boring and self-contained:
//   • inline <style>, inline SVG for the chart, logo as a data-URL — one file, no
//     external requests, renders offline and survives the site re-designing itself;
//   • NO <script> of any kind (the snapshot is e-mailed and iframed — executable content
//     there would be a liability with zero benefit for a static document);
//   • print CSS: @page A4, a page break before every section, so "Save as PDF" from a
//     browser produces the same layout the Playwright PDF would;
//   • the only branding voice is the operator's (white-label): OpenGSC is named only
//     when reportBranding.showPoweredBy is on.

import type { ReportBranding } from "./branding";
import { DEFAULT_BRANDING } from "./branding";
import type { ReportSectionId } from "./sections";
import { SECTION_TITLES_EN } from "./sections";
import type { ReportData } from "./collect";

// ─── small pure helpers ───────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const fmtInt = (n: number): string => new Intl.NumberFormat("en-US").format(Math.round(n));

const fmtPct = (n: number | null, digits = 1): string =>
  n == null ? "—" : `${(n * 100).toFixed(digits)}%`;

const fmtDate = (iso: string): string => iso.slice(0, 10);

/** +18 % / −4 % against the previous period; null (no baseline or no value) is "—", never "+0 %". */
export function fmtDeltaPct(current: number | null, previous: number | null): string {
  if (current == null || previous == null || previous === 0) return "—";
  const pct = (current - previous) / previous * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(0)}%`;
}

const signed = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtInt(Math.abs(n))}`;

// ─── deterministic summary ────────────────────────────────────────────────────

export interface SummaryLine { label: string; text: string }
export interface SummaryResult { direction: string | null; win: string | null; priority: string | null }

/**
 * The "AI summary" without the AI: direction, best win and the top priority, read straight
 * off the numbers. Deterministic — the same data always produces the same sentence, which
 * is what a frozen snapshot demands (and a client comparing two months expects). No
 * forecasts: everything said happened inside the period.
 */
export function buildSummary(data: ReportData): SummaryResult {
  const parts: SummaryResult = { direction: null, win: null, priority: null };

  const t = data.traffic;
  if (t) {
    const clicks = t.current.clicks;
    const prev = t.previous?.clicks ?? null;
    if (prev != null && prev > 0) {
      const pct = Math.round((clicks - prev) / prev * 100);
      const sign = pct > 0 ? "+" : "−";
      parts.direction = `Clicks ${sign}${Math.abs(pct)}% vs the previous period (${fmtInt(clicks)} vs ${fmtInt(prev)}).`;
    } else if (clicks > 0) {
      parts.direction = `${fmtInt(clicks)} clicks this period.`;
    }
  }

  if (data.queries) {
    const movers = data.queries.rows.filter(r => r.delta != null && (r.delta ?? 0) !== 0);
    const best = movers.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
    if (best && (best.delta ?? 0) > 0) {
      parts.win = `Best growth — “${best.key}” (${signed(best.delta ?? 0)} clicks).`;
    }
  }

  // Priority: the first problem the data actually shows, in a fixed order an operator can
  // argue with. Only counts that are known (null ≠ 0 is the rule everywhere here).
  const priorities: string[] = [];
  const ix = data.indexing;
  if (ix?.first && ix.latest) {
    const drop = ix.first.indexed - ix.latest.indexed;
    if (drop > 0) priorities.push(`${fmtInt(drop)} page(s) dropped out of the Google index during the period.`);
  }
  const pos = data.positions;
  if (pos) {
    const fallen = pos.declined.length;
    if (fallen > 0) {
      const worst = pos.declined[0];
      priorities.push(`${fallen} tracked keyword(s) lost positions — “${worst.keyword}” ${worst.position != null ? `now #${worst.position}` : "no longer found"}.`);
    }
  }
  const audit = data.audit;
  if (audit) {
    const critical = audit.topIssues.filter(i => i.severity === "critical");
    if (critical.length) priorities.push(`Audit: ${fmtInt(critical[0].count)} page(s) with “${critical[0].code.replace(/_/g, " ")}”.`);
  }
  const bl = data.backlinks;
  if (bl && bl.lostCount > 0) priorities.push(`${fmtInt(bl.lostCount)} backlink(s) currently marked lost.`);
  if (data.uptime?.incidents.length) {
    const last = data.uptime.incidents[0];
    priorities.push(`Uptime: ${data.uptime.incidents.length} incident(s), latest ${fmtDate(last.startedAt)} (${last.cause}).`);
  }
  parts.priority = priorities[0] ?? null;
  return parts;
}

/**
 * The next-steps section, derived the same way: every step names a number from the period.
 * An empty list returns [] and the section is not rendered.
 */
export function buildNextSteps(data: ReportData): string[] {
  const steps: string[] = [];
  const pos = data.positions;
  if (pos) {
    for (const m of pos.declined.slice(0, 3)) {
      steps.push(`Recover “${m.keyword}”${m.location ? ` (${m.location})` : ""} — ${m.prevPosition != null ? `#${m.prevPosition}` : "tracked"} → ${m.position != null ? `#${m.position}` : "not found"}.`);
    }
  }
  const ix = data.indexing;
  if (ix?.latest && ix.latest.notIndexed > 0) {
    steps.push(`Inspect the ${fmtInt(ix.latest.notIndexed)} page(s) Google reports as not indexed.`);
  }
  const audit = data.audit;
  if (audit) {
    for (const issue of audit.topIssues.filter(i => i.severity === "critical").slice(0, 2)) {
      steps.push(`Fix “${issue.code.replace(/_/g, " ")}” on ${fmtInt(issue.count)} page(s).`);
    }
  }
  const q = data.queries;
  if (q) {
    const rising = q.rows.filter(r => (r.delta ?? 0) > 0).sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
    if (rising) steps.push(`Double down on “${rising.key}” (+${fmtInt(rising.delta ?? 0)} clicks).`);
  }
  return steps.slice(0, 6);
}

// ─── markdown (operator notes) → safe HTML ────────────────────────────────────

/**
 * A deliberately small subset: paragraphs, ## / ### headings, - lists, **bold**, *italic*,
 * [text](https://…) links. The text is HTML-escaped FIRST and only then do the markers
 * turn into tags, so nothing a client pastes into "What we did" can ever become markup.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  const inline = (s: string): string => escapeHtml(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer nofollow" target="_blank">$1</a>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length + 1; // ## → h3: the section already owns h2
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      if (!inList) { closeList(); out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*•]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

// ─── the clicks chart (inline SVG, no JS) ─────────────────────────────────────

/** Column chart of daily clicks. Pure string building — deterministic, printable, scriptless. */
export function clicksSvg(points: { date: string; clicks: number }[], accent: string, width = 640, height = 140): string {
  if (!points.length) return "";
  const pad = { top: 8, right: 4, bottom: 18, left: 4 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...points.map(p => p.clicks));
  const step = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const barW = Math.max(1.5, Math.min(18, step * 0.62));
  const x = (i: number) => pad.left + (points.length > 1 ? i * step : innerW / 2);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  const bars = points.map((p, i) => {
    const top = y(p.clicks);
    const h = pad.top + innerH - top;
    if (p.clicks <= 0) {
      return `<line x1="${(x(i) - barW / 2).toFixed(1)}" y1="${(pad.top + innerH).toFixed(1)}" x2="${(x(i) + barW / 2).toFixed(1)}" y2="${(pad.top + innerH).toFixed(1)}" stroke="#c8ccd4" stroke-width="2" stroke-linecap="round"/>`;
    }
    return `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5" fill="${accent}"><title>${escapeHtml(p.date)}: ${fmtInt(p.clicks)} clicks</title></rect>`;
  }).join("");
  const labelEvery = Math.ceil(points.length / 8);
  const labels = points
    .map((p, i) => i % labelEvery === 0 || i === points.length - 1
      ? `<text x="${x(i).toFixed(1)}" y="${(height - 5).toFixed(1)}" font-size="9" fill="#8a8f98" text-anchor="middle">${escapeHtml(p.date.slice(5))}</text>`
      : "")
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Daily clicks" xmlns="http://www.w3.org/2000/svg">${bars}${labels}</svg>`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

function css(accent: string): string {
  return `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2328; background: #fff; }
.wrap { max-width: 780px; margin: 0 auto; padding: 28px 32px 40px; }
header.rpt { border-bottom: 3px solid ${accent}; padding-bottom: 18px; margin-bottom: 8px; display: flex; align-items: flex-start; gap: 16px; }
header.rpt img.logo { max-height: 56px; max-width: 220px; }
header.rpt h1 { font-size: 22px; margin: 0 0 4px; }
.meta { color: #6a7079; font-size: 12px; }
.section { border-top: 1px solid #e6e8eb; padding: 18px 0 22px; }
.section:first-of-type { border-top: 0; }
h2 { font-size: 16px; margin: 0 0 12px; color: ${accent}; }
h3, h4 { font-size: 14px; margin: 14px 0 6px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0; }
th { text-align: left; font-weight: 600; color: #6a7079; border-bottom: 1px solid #d8dbe0; padding: 5px 8px 5px 0; }
td { border-bottom: 1px solid #eef0f3; padding: 5px 8px 5px 0; vertical-align: top; }
td.num, th.num { text-align: right; }
.delta-up { color: #1a7f37; font-weight: 600; }
.delta-down { color: #c62828; font-weight: 600; }
.kpis { display: flex; gap: 12px; flex-wrap: wrap; margin: 10px 0; }
.kpi { flex: 1 1 130px; border: 1px solid #e6e8eb; border-radius: 8px; padding: 10px 12px; }
.kpi .v { font-size: 20px; font-weight: 700; }
.kpi .l { font-size: 11px; color: #6a7079; text-transform: uppercase; letter-spacing: 0.03em; }
.nodata { display: inline-block; border: 1px dashed #c8ccd4; border-radius: 6px; color: #6a7079; font-size: 12px; padding: 4px 10px; }
.pill { display: inline-block; border-radius: 10px; font-size: 11px; font-weight: 600; padding: 2px 9px; vertical-align: 1px; }
.pill.critical { background: #fdecea; color: #b71c1c; }
.pill.warning { background: #fff4e0; color: #8d5b00; }
.pill.info { background: #e8f0fe; color: #1a56b8; }
.summary-lines p { margin: 4px 0; font-size: 14.5px; }
ul.steps { margin: 6px 0; padding-left: 20px; }
ul.steps li { margin: 4px 0; }
blockquote.review { border-left: 3px solid ${accent}; margin: 8px 0; padding: 2px 0 2px 12px; color: #3c4046; }
.stars { color: ${accent}; letter-spacing: 1px; }
footer.rpt { border-top: 1px solid #e6e8eb; margin-top: 26px; padding-top: 14px; color: #6a7079; font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
a { color: ${accent}; }
@page { size: A4; margin: 14mm 12mm; }
@media print {
  .section { break-before: page; page-break-before: always; }
  .section.first { break-before: auto; page-break-before: auto; }
  header.rpt { display: block; }
}
`.trim();
}

// ─── section renderers ────────────────────────────────────────────────────────

function kpi(label: string, value: string, delta?: string): string {
  const d = delta ? `<div class="l" style="margin-top:2px">${escapeHtml(delta)}</div>` : "";
  return `<div class="kpi"><div class="v">${escapeHtml(value)}</div><div class="l">${escapeHtml(label)}</div>${d}</div>`;
}

function deltaSpan(delta: number | null): string {
  if (delta == null || delta === 0) return "—";
  const cls = delta > 0 ? "delta-up" : "delta-down";
  return `<span class="${cls}">${signed(delta)}</span>`;
}

function noData(text = "No data for this period"): string {
  return `<span class="nodata">${escapeHtml(text)}</span>`;
}

function renderTraffic(data: ReportData, accent: string): string {
  const t = data.traffic!;
  const prev = t.previous;
  // Every KPI carries its "vs prev" line even when there is no baseline — an explicit
  // em dash reads as "nothing to compare against", which is not the same as "+0%".
  const posDelta = t.current.position != null && prev?.position != null
    ? `${t.current.position <= prev.position ? "+" : "−"}${Math.abs(t.current.position - prev.position).toFixed(1)}`
    : "—";
  const kpis = [
    kpi("Clicks", fmtInt(t.current.clicks), `vs prev: ${fmtDeltaPct(t.current.clicks, prev?.clicks ?? null)}`),
    kpi("Impressions", fmtInt(t.current.impressions), `vs prev: ${fmtDeltaPct(t.current.impressions, prev?.impressions ?? null)}`),
    kpi("CTR", fmtPct(t.current.ctr), `vs prev: ${fmtDeltaPct(t.current.ctr, prev?.ctr ?? null)}`),
    kpi("Avg position", t.current.position == null ? "—" : t.current.position.toFixed(1), `vs prev: ${posDelta}`),
  ].join("");
  const chart = clicksSvg(t.series, accent);
  return `<div class="kpis">${kpis}</div>${chart}`;
}

function renderRows(rows: { key: string; clicks: number; impressions: number; delta: number | null }[], keyHeader: string): string {
  const body = rows.map(r => `<tr><td>${escapeHtml(r.key)}</td><td class="num">${fmtInt(r.clicks)}</td><td class="num">${fmtInt(r.impressions)}</td><td class="num">${deltaSpan(r.delta)}</td></tr>`).join("");
  return `<table><thead><tr><th>${escapeHtml(keyHeader)}</th><th class="num">Clicks</th><th class="num">Impressions</th><th class="num">Change</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderPositions(data: ReportData): string {
  const p = data.positions!;
  const checkedLine = p.checked == null
    ? `<p class="meta">Rank tracker has not checked these keywords yet.</p>`
    : "";
  const kpis = [
    kpi("Top 3", fmtInt(p.top3)),
    kpi("Top 10", fmtInt(p.top10)),
  ].join("");
  const moveTable = (title: string, moves: { keyword: string; location: string; position: number | null; change: number | null }[]) => {
    if (!moves.length) return "";
    const rows = moves.map(m => `<tr><td>${escapeHtml(m.keyword)}${m.location ? ` <span class="meta">· ${escapeHtml(m.location)}</span>` : ""}</td><td class="num">${m.position == null ? "—" : `#${m.position}`}</td><td class="num">${deltaSpan(m.change)}</td></tr>`).join("");
    return `<h4>${escapeHtml(title)}</h4><table><thead><tr><th>Keyword</th><th class="num">Position</th><th class="num">Change</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  return `${checkedLine}<div class="kpis">${kpis}</div>${moveTable("Improved", p.improved)}${moveTable("Declined", p.declined)}`;
}

function renderLocal(data: ReportData): string {
  const l = data.local!;
  const rows = l.keywords.map(k => `<tr><td>${escapeHtml(k.keyword)}</td><td>${escapeHtml(k.location)}</td><td class="num">${k.position == null ? "—" : `#${k.position}`}</td><td class="num">${k.localPack == null ? "—" : `#${k.localPack} in pack`}</td></tr>`).join("");
  const table = rows
    ? `<table><thead><tr><th>Keyword</th><th>Location</th><th class="num">Organic</th><th class="num">Map pack</th></tr></thead><tbody>${rows}</tbody></table>`
    : noData("No location-tracked keywords yet");
  const nap = l.nap
    ? `<h4>Citation status (NAP)</h4><p>${l.nap.map(n => `<span class="pill ${n.status === "consistent" ? "info" : n.status === "mismatch" ? "warning" : ""}">${escapeHtml(n.status)}: ${fmtInt(n.count)}</span>`).join(" ")}</p>`
    : "";
  return `${table}${nap}<p class="meta">${fmtInt(l.inPack)} keyword(s) inside the map pack (places 1–3).</p>`;
}

function renderIndexing(data: ReportData): string {
  const ix = data.indexing!;
  const latest = ix.latest;
  if (!latest) return noData();
  const first = ix.first;
  const indexedDelta = first ? `${latest.indexed - first.indexed >= 0 ? "+" : "−"}${fmtInt(Math.abs(latest.indexed - first.indexed))} since ${fmtDate(first.day)}` : undefined;
  const kpis = [
    kpi("Indexed", fmtInt(latest.indexed), indexedDelta),
    kpi("Not indexed", fmtInt(latest.notIndexed)),
    kpi("Not inspected", fmtInt(latest.unknown)),
    kpi("Sitemap URLs", fmtInt(latest.total)),
  ].join("");
  return `<div class="kpis">${kpis}</div><p class="meta">As of ${fmtDate(latest.day)}.</p>`;
}

function renderAudit(data: ReportData): string {
  const a = data.audit!;
  const kpis = [
    kpi("Health score", a.healthScore == null ? "—" : `${fmtInt(a.healthScore)}/100`),
    kpi("Pages crawled", a.pages == null ? "—" : fmtInt(a.pages)),
    kpi("Pages with issues", a.pagesWithIssues == null ? "—" : fmtInt(a.pagesWithIssues)),
  ].join("");
  const issues = a.topIssues.length
    ? `<table><thead><tr><th>Issue</th><th>Severity</th><th class="num">Pages</th></tr></thead><tbody>${a.topIssues.map(i => `<tr><td>${escapeHtml(i.code.replace(/_/g, " "))}</td><td><span class="pill ${i.severity}">${i.severity}</span></td><td class="num">${fmtInt(i.count)}</td></tr>`).join("")}</tbody></table>`
    : noData("No issues recorded");
  const cwv = a.cwv.length
    ? `<h4>Core Web Vitals (sample of ${a.cwv.length})</h4><table><thead><tr><th>Page</th><th class="num">LCP, s</th><th class="num">INP, ms</th><th class="num">CLS</th><th class="num">Perf.</th></tr></thead><tbody>${a.cwv.map(c => `<tr><td>${escapeHtml(shortUrl(c.url))}</td><td class="num">${c.lcp == null ? "—" : (c.lcp / 1000).toFixed(2)}</td><td class="num">${c.inp == null ? "—" : fmtInt(c.inp)}</td><td class="num">${c.cls == null ? "—" : c.cls.toFixed(2)}</td><td class="num">${c.score == null ? "—" : fmtInt(c.score)}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<div class="kpis">${kpis}</div><p class="meta">Last audit: ${fmtDate(a.startedAt.slice(0, 10))}.</p>${issues}${cwv}`;
}

function shortUrl(u: string): string {
  try { const url = new URL(u); return url.pathname + (url.search ? url.search : "") || "/"; } catch { return u.slice(0, 60); }
}

function renderUptime(data: ReportData): string {
  const u = data.uptime!;
  const kpis = [
    kpi("Uptime", u.uptimePct == null ? "—" : `${u.uptimePct.toFixed(2)}%`),
    kpi("Incidents", fmtInt(u.incidents.length)),
  ].join("");
  const incidents = u.incidents.length
    ? `<table><thead><tr><th>Started</th><th>Cause</th><th class="num">Duration</th></tr></thead><tbody>${u.incidents.map(i => `<tr><td>${escapeHtml(fmtDate(i.startedAt))}</td><td>${escapeHtml(i.cause)}${i.detail ? ` <span class="meta">· ${escapeHtml(i.detail.slice(0, 80))}</span>` : ""}</td><td class="num">${i.durationMs == null ? "ongoing" : `${Math.round(i.durationMs / 60000)} min`}</td></tr>`).join("")}</tbody></table>`
    : "<p>No incidents in this period.</p>";
  return `<div class="kpis">${kpis}</div><p class="meta">Monitored URL: ${escapeHtml(u.url)}</p>${incidents}`;
}

function renderBacklinks(data: ReportData): string {
  const b = data.backlinks!;
  const kpis = [
    kpi("New links", fmtInt(b.newCount)),
    kpi("Lost links", fmtInt(b.lostCount)),
    kpi("Avg DR of donors", b.avgDr == null ? "—" : b.avgDr.toFixed(1)),
  ].join("");
  const top = b.topNew.length
    ? `<table><thead><tr><th>New link from</th><th class="num">DR</th><th>Anchor</th></tr></thead><tbody>${b.topNew.map(r => `<tr><td>${escapeHtml(r.domainFrom || r.urlFrom.slice(0, 60))}</td><td class="num">${r.dr == null ? "—" : r.dr.toFixed(0)}</td><td>${escapeHtml(r.anchor.slice(0, 60)) || "—"}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<div class="kpis">${kpis}</div>${top}`;
}

function renderAi(data: ReportData): string {
  const a = data.ai!;
  const kpis = [
    kpi("Mention share", fmtPct(a.ourShare)),
    kpi("Citation share", fmtPct(a.citationShare)),
    kpi("Answers analysed", fmtInt(a.answers)),
  ].join("");
  const top = a.topCited.length
    ? `<table><thead><tr><th>Domain</th><th class="num">Citations</th></tr></thead><tbody>${a.topCited.map(c => `<tr${c.isUs ? ' style="font-weight:600"' : ""}><td>${escapeHtml(c.domain)}${c.isUs ? " ←" : ""}</td><td class="num">${fmtInt(c.citations)}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<div class="kpis">${kpis}</div><p class="meta">${fmtInt(a.questions)} tracked question(s), last ${a.windowDays} days.</p>${top}`;
}

function renderReviews(data: ReportData): string {
  const r = data.reviews!;
  const kpis = [
    kpi("New reviews", fmtInt(r.count)),
    kpi("Average rating", r.avgRating == null ? "—" : `${r.avgRating.toFixed(1)} / 5`),
  ].join("");
  const latest = r.latest.length
    ? r.latest.map(rv => `<blockquote class="review"><div class="stars">${"★".repeat(Math.max(0, Math.min(5, rv.rating)))}${"☆".repeat(Math.max(0, 5 - rv.rating))}</div> <strong>${escapeHtml(rv.author || "Anonymous")}</strong> · ${escapeHtml(fmtDate(rv.createTime))}<br>${escapeHtml(rv.comment)}</blockquote>`).join("")
    : "";
  return `<div class="kpis">${kpis}</div>${latest}`;
}

// ─── the document ─────────────────────────────────────────────────────────────

export interface RenderInput {
  title: string;
  sections: ReportSectionId[];
  data: ReportData;
  branding?: ReportBranding | null;
  notes?: string;
  generatedAt?: string; // ISO — the snapshot moment; defaults to a fixed epoch only in tests
}

export function renderReportHTML(input: RenderInput): string {
  const b = { ...DEFAULT_BRANDING, ...(input.branding ?? {}) };
  const accent = b.accentColor || DEFAULT_BRANDING.accentColor;
  const d = input.data;
  const generated = input.generatedAt ?? new Date().toISOString();

  const summary = buildSummary(d);
  const steps = buildNextSteps(d);
  const notes = (input.notes ?? "").trim();

  const header = `
<header class="rpt">
  ${b.logoDataUrl ? `<img class="logo" src="${b.logoDataUrl.startsWith("data:") ? b.logoDataUrl : ""}" alt="${escapeHtml(b.companyName || "logo")}"/>` : ""}
  <div>
    <h1>${escapeHtml(input.title)}</h1>
    <div class="meta">${escapeHtml(d.siteDomain)} · ${fmtDate(d.window.from)} — ${fmtDate(d.window.to)} (${d.window.days} days)</div>
    ${b.companyName ? `<div class="meta">${escapeHtml(b.companyName)}${b.website ? ` · <a href="${escapeHtml(b.website)}">${escapeHtml(b.website.replace(/^https?:\/\//, ""))}</a>` : ""}</div>` : ""}
  </div>
</header>`;

  const bodies: string[] = [];
  let first = true;
  for (const id of input.sections) {
    let body: string;
    switch (id) {
      case "summary": {
        const lines = [
          summary.direction ? `<p>${escapeHtml(summary.direction)}</p>` : "",
          summary.win ? `<p>${escapeHtml(summary.win)}</p>` : "",
          summary.priority ? `<p><strong>Priority:</strong> ${escapeHtml(summary.priority)}</p>` : "",
        ].filter(Boolean).join("");
        body = `<div class="summary-lines">${lines || noData()}</div>`;
        break;
      }
      case "traffic": body = d.traffic ? renderTraffic(d, accent) : noData(); break;
      case "queries": body = d.queries ? renderRows(d.queries.rows, "Query") : noData(); break;
      case "pages": body = d.pages ? renderRows(d.pages.rows, "Page") : noData(); break;
      case "positions": body = d.positions ? renderPositions(d) : noData(); break;
      case "local_positions": body = d.local ? renderLocal(d) : noData(); break;
      case "indexing": body = d.indexing ? renderIndexing(d) : noData(); break;
      case "audit": body = d.audit ? renderAudit(d) : noData(); break;
      case "uptime": body = d.uptime ? renderUptime(d) : noData(); break;
      case "backlinks": body = d.backlinks ? renderBacklinks(d) : noData(); break;
      case "ai_visibility": body = d.ai ? renderAi(d) : noData(); break;
      case "reviews": body = d.reviews ? renderReviews(d) : noData(); break;
      case "work_done": body = notes ? markdownToHtml(notes) : noData("No notes for this period"); break;
      case "next_steps": body = steps.length ? `<ul class="steps">${steps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : noData(); break;
      default: body = "";
    }
    if (!body) continue;
    bodies.push(`<section class="section${first ? " first" : ""}"><h2>${escapeHtml(SECTION_TITLES_EN[id])}</h2>${body}</section>`);
    first = false;
  }

  const poweredBy = b.showPoweredBy
    ? `Made with <a href="https://opengsc.com" rel="noopener noreferrer" target="_blank">OpenGSC</a>`
    : "";
  const footer = `
<footer class="rpt">
  <div>${escapeHtml(b.footer)}</div>
  <div>${poweredBy}${poweredBy ? " · " : ""}Generated ${fmtDate(generated)}</div>
</footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(input.title)} — ${escapeHtml(d.siteDomain)}</title>
<style>${css(accent)}</style>
</head>
<body>
<div class="wrap">
${header}
${bodies.join("\n")}
${footer}
</div>
</body>
</html>`;
}
