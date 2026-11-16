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
//
// Issue #36: every client-visible string comes from ./i18n (REPORT_L) — one block per
// language, chosen per report (ClientReport.lang), NOT from the browser locale files.
// buildSummary/buildNextSteps/searchDates/clicksSvg default to English so the pure
// helpers stay callable the way the tests always called them.

import type { ReportBranding } from "./branding";
import { DEFAULT_BRANDING } from "./branding";
import type { ReportSectionId } from "./sections";
import { REPORT_FMT_INT, REPORT_HTML_LANG, REPORT_L, type ReportLang, type ReportTpl } from "./i18n";
import { providerLabel } from "@/lib/seo/backlinkProvider";
import type { ReportData } from "./collect";
import { rankSuccessState, rankSuccessStamp } from "@/lib/rankFreshness";

/**
 * "Last found" badge under a rank row — present only when the row carries `foundAt`
 * (older report snapshots predate the key and omit it silently). Same fresh/stale clock
 * as the Positions UI (72h); the copy comes from the report's own locale, not a hardcoded one.
 */
function rankFoundHtml(foundAt: string | null | undefined, L: ReportTpl): string {
  if (foundAt === undefined) return "";
  const state = rankSuccessState(foundAt);
  if (state === "never" || foundAt == null) {
    return badgeHtml(L.rankNeverFound, true);
  }
  return badgeHtml(L.rankFoundAt(rankSuccessStamp(foundAt)), state !== "fresh");
}

function badgeHtml(text: string, warn: boolean): string {
  const style = warn
    ? "color:#B45309;background:rgba(245,158,11,0.16);border:1px solid rgba(245,158,11,0.45);"
    : "color:#64748b;border:1px solid transparent;";
  return `<div style="${style}display:inline-block;margin-top:4px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;line-height:1.35;white-space:normal;">${escapeHtml(text)}</div>`;
}

// ─── small pure helpers ───────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

/** +1 234 / −56 with the language's own digit grouping (render context `fi`). */
const signedOf = (fi: (n: number) => string) => (n: number): string =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${fi(Math.abs(n))}`;

// ─── deterministic summary ────────────────────────────────────────────────────

export interface SummaryLine { label: string; text: string }
export interface SummaryResult { direction: string | null; win: string | null; priority: string | null }

/**
 * The "AI summary" without the AI: direction, best win and the top priority, read straight
 * off the numbers. Deterministic — the same data always produces the same sentence, which
 * is what a frozen snapshot demands (and a client comparing two months expects). No
 * forecasts: everything said happened inside the period.
 */
export function buildSummary(data: ReportData, L: ReportTpl = REPORT_L.en, fi: (n: number) => string = REPORT_FMT_INT.en): SummaryResult {
  const parts: SummaryResult = { direction: null, win: null, priority: null };
  const signed = signedOf(fi);

  const t = data.traffic;
  if (t) {
    const clicks = t.current.clicks;
    const prev = t.previous?.clicks ?? null;
    if (prev != null && prev > 0) {
      const pct = Math.round((clicks - prev) / prev * 100);
      const sign = pct > 0 ? "+" : "−";
      parts.direction = L.dirWithPrev(sign, Math.abs(pct), fi(clicks), fi(prev));
    } else if (clicks > 0) {
      parts.direction = L.dirOnly(fi(clicks));
    }
  }

  if (data.queries) {
    const movers = data.queries.rows.filter(r => r.delta != null && (r.delta ?? 0) !== 0);
    const best = movers.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
    if (best && (best.delta ?? 0) > 0) {
      parts.win = L.bestGrowth(best.key, signed(best.delta ?? 0));
    }
  }

  // Priority: the first problem the data actually shows, in a fixed order an operator can
  // argue with. Only counts that are known (null ≠ 0 is the rule everywhere here).
  const priorities: string[] = [];
  const ix = data.indexing;
  if (ix?.first && ix.latest) {
    const drop = ix.first.indexed - ix.latest.indexed;
    if (drop > 0) priorities.push(L.prioIndexDrop(fi(drop)));
  }
  const pos = data.positions;
  if (pos) {
    const fallen = pos.declined.length;
    if (fallen > 0) {
      const worst = pos.declined[0];
      const tail = worst.position != null ? L.tailNow(worst.position) : L.notFoundTail;
      priorities.push(L.prioKeywordsLost(fi(fallen), worst.keyword, tail));
    }
  }
  const audit = data.audit;
  if (audit) {
    const critical = audit.topIssues.filter(i => i.severity === "critical");
    if (critical.length) priorities.push(L.prioAudit(fi(critical[0].count), critical[0].code.replace(/_/g, " ")));
  }
  const bl = data.backlinks;
  if (bl && bl.lostCount > 0) priorities.push(L.prioBacklinks(fi(bl.lostCount), providerLabel(bl.provider)));
  if (data.uptime?.incidents.length) {
    const last = data.uptime.incidents[0];
    priorities.push(L.prioUptime(fi(data.uptime.incidents.length), fmtDate(last.startedAt), last.cause));
  }
  parts.priority = priorities[0] ?? null;
  return parts;
}

/**
 * The next-steps section, derived the same way: every step names a number from the period.
 * An empty list returns [] and the section is not rendered.
 */
export function buildNextSteps(data: ReportData, L: ReportTpl = REPORT_L.en, fi: (n: number) => string = REPORT_FMT_INT.en): string[] {
  const steps: string[] = [];
  const pos = data.positions;
  if (pos) {
    for (const m of pos.declined.slice(0, 3)) {
      const from = m.prevPosition != null ? `#${m.prevPosition}` : L.trackedWord;
      const to = m.position != null ? `#${m.position}` : L.notFound;
      steps.push(L.stepRecover(m.keyword, m.location ? ` (${m.location})` : "", from, to));
    }
  }
  const ix = data.indexing;
  if (ix?.latest && ix.latest.notIndexed > 0) {
    steps.push(L.stepInspect(fi(ix.latest.notIndexed)));
  }
  const audit = data.audit;
  if (audit) {
    for (const issue of audit.topIssues.filter(i => i.severity === "critical").slice(0, 2)) {
      steps.push(L.stepFix(issue.code.replace(/_/g, " "), fi(issue.count)));
    }
  }
  const q = data.queries;
  if (q) {
    const rising = q.rows.filter(r => (r.delta ?? 0) > 0).sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
    if (rising) steps.push(L.stepDoubleDown(rising.key, fi(rising.delta ?? 0)));
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
export function clicksSvg(points: { date: string; clicks: number }[], accent: string, width = 640, height = 140, L: ReportTpl = REPORT_L.en, fi: (n: number) => string = REPORT_FMT_INT.en): string {
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
    return `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5" fill="${accent}"><title>${escapeHtml(L.svgClickTitle(p.date, fi(p.clicks)))}</title></rect>`;
  }).join("");
  const labelEvery = Math.ceil(points.length / 8);
  const labels = points
    .map((p, i) => i % labelEvery === 0 || i === points.length - 1
      ? `<text x="${x(i).toFixed(1)}" y="${(height - 5).toFixed(1)}" font-size="9" fill="#8a8f98" text-anchor="middle">${escapeHtml(p.date.slice(5))}</text>`
      : "")
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeHtml(L.dailyClicks)}" xmlns="http://www.w3.org/2000/svg">${bars}${labels}</svg>`;
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

/** What a section renderer needs: the language block and the number format that goes with it. */
interface Ctx { L: ReportTpl; fi: (n: number) => string }

function kpi(label: string, value: string, delta?: string): string {
  const d = delta ? `<div class="l" style="margin-top:2px">${escapeHtml(delta)}</div>` : "";
  return `<div class="kpi"><div class="v">${escapeHtml(value)}</div><div class="l">${escapeHtml(label)}</div>${d}</div>`;
}

function deltaSpan(delta: number | null, fi: (n: number) => string): string {
  if (delta == null || delta === 0) return "—";
  const cls = delta > 0 ? "delta-up" : "delta-down";
  return `<span class="${cls}">${signedOf(fi)(delta)}</span>`;
}

function noData(L: ReportTpl, text?: string): string {
  return `<span class="nodata">${escapeHtml(text ?? L.noData)}</span>`;
}

function renderTraffic(data: ReportData, accent: string, { L, fi }: Ctx): string {
  const t = data.traffic!;
  const prev = t.previous;
  // Every KPI carries its "vs prev" line even when there is no baseline — an explicit
  // em dash reads as "nothing to compare against", which is not the same as "+0%".
  const posDelta = t.current.position != null && prev?.position != null
    ? `${t.current.position <= prev.position ? "+" : "−"}${Math.abs(t.current.position - prev.position).toFixed(1)}`
    : "—";
  const kpis = [
    kpi(L.clicks, fi(t.current.clicks), L.vsPrev(fmtDeltaPct(t.current.clicks, prev?.clicks ?? null))),
    kpi(L.impressions, fi(t.current.impressions), L.vsPrev(fmtDeltaPct(t.current.impressions, prev?.impressions ?? null))),
    kpi(L.ctr, fmtPct(t.current.ctr), L.vsPrev(fmtDeltaPct(t.current.ctr, prev?.ctr ?? null))),
    kpi(L.avgPosition, t.current.position == null ? "—" : t.current.position.toFixed(1), L.vsPrev(posDelta)),
  ].join("");
  const chart = clicksSvg(t.series, accent, 640, 140, L, fi);
  return `<div class="kpis">${kpis}</div>${chart}`;
}

/** The Search Console dates a GSC section covers, when they differ from the header's period:
 *  GSC data lags ~2 days, so these sections end earlier — exactly like the dashboard (issue #27). */
export function searchDates(data: ReportData, L: ReportTpl = REPORT_L.en): string {
  const { searchFrom, searchTo, from, to } = data.window;
  if (!searchFrom || !searchTo || (searchFrom === from && searchTo === to)) return "";
  return `<p class="meta">${escapeHtml(L.gscDates(fmtDate(searchFrom), fmtDate(searchTo)))}</p>`;
}

function renderRows(rows: { key: string; clicks: number; impressions: number; delta: number | null }[], keyHeader: string, { L, fi }: Ctx): string {
  const body = rows.map(r => `<tr><td>${escapeHtml(r.key)}</td><td class="num">${fi(r.clicks)}</td><td class="num">${fi(r.impressions)}</td><td class="num">${deltaSpan(r.delta, fi)}</td></tr>`).join("");
  return `<table><thead><tr><th>${escapeHtml(keyHeader)}</th><th class="num">${escapeHtml(L.clicks)}</th><th class="num">${escapeHtml(L.impressions)}</th><th class="num">${escapeHtml(L.change)}</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderPositions(data: ReportData, ctx: Ctx): string {
  const { L, fi } = ctx;
  const p = data.positions!;
  const checkedLine = p.checked == null
    ? `<p class="meta">${escapeHtml(L.notCheckedYet)}</p>`
    : "";
  const kpis = [
    kpi(L.top3, fi(p.top3)),
    kpi(L.top10, fi(p.top10)),
  ].join("");
  const moveTable = (title: string, moves: { keyword: string; location: string; position: number | null; change: number | null; foundAt?: string | null }[]) => {
    if (!moves.length) return "";
    const rows = moves.map(m => `<tr><td>${escapeHtml(m.keyword)}${m.location ? ` <span class="meta">· ${escapeHtml(m.location)}</span>` : ""}${rankFoundHtml(m.foundAt, L)}</td><td class="num">${m.position == null ? "—" : `#${m.position}`}</td><td class="num">${deltaSpan(m.change, fi)}</td></tr>`).join("");
    return `<h4>${escapeHtml(title)}</h4><table><thead><tr><th>${escapeHtml(L.keyword)}</th><th class="num">${escapeHtml(L.positionCol)}</th><th class="num">${escapeHtml(L.change)}</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  return `${checkedLine}<div class="kpis">${kpis}</div>${moveTable(L.improved, p.improved)}${moveTable(L.declined, p.declined)}`;
}

function renderLocal(data: ReportData, { L, fi }: Ctx): string {
  const l = data.local!;
  const rows = l.keywords.map(k => `<tr><td>${escapeHtml(k.keyword)}${rankFoundHtml(k.foundAt, L)}</td><td>${escapeHtml(k.location)}</td><td class="num">${k.position == null ? "—" : `#${k.position}`}</td><td class="num">${k.localPack == null ? "—" : escapeHtml(L.inPack(k.localPack))}</td></tr>`).join("");
  const table = rows
    ? `<table><thead><tr><th>${escapeHtml(L.keyword)}</th><th>${escapeHtml(L.location)}</th><th class="num">${escapeHtml(L.organic)}</th><th class="num">${escapeHtml(L.mapPack)}</th></tr></thead><tbody>${rows}</tbody></table>`
    : noData(L, L.noLocalKw);
  const nap = l.nap
    ? `<h4>${escapeHtml(L.napStatus)}</h4><p>${l.nap.map(n => `<span class="pill ${n.status === "consistent" ? "info" : n.status === "mismatch" ? "warning" : ""}">${escapeHtml(n.status)}: ${fi(n.count)}</span>`).join(" ")}</p>`
    : "";
  return `${table}${nap}<p class="meta">${escapeHtml(L.inPackSummary(fi(l.inPack)))}</p>`;
}

function renderIndexing(data: ReportData, { L, fi }: Ctx): string {
  const ix = data.indexing!;
  const latest = ix.latest;
  if (!latest) return noData(L);
  const first = ix.first;
  const indexedDelta = first ? L.sinceDelta(latest.indexed - first.indexed >= 0 ? "+" : "−", fi(Math.abs(latest.indexed - first.indexed)), fmtDate(first.day)) : undefined;
  const kpis = [
    kpi(L.indexed, fi(latest.indexed), indexedDelta),
    kpi(L.notIndexed, fi(latest.notIndexed)),
    kpi(L.notInspected, fi(latest.unknown)),
    kpi(L.sitemapUrls, fi(latest.total)),
  ].join("");
  return `<div class="kpis">${kpis}</div><p class="meta">${escapeHtml(L.asOf(fmtDate(latest.day)))}</p>`;
}

function renderAudit(data: ReportData, { L, fi }: Ctx): string {
  const a = data.audit!;
  const kpis = [
    kpi(L.healthScore, a.healthScore == null ? "—" : `${fi(a.healthScore)}/100`),
    kpi(L.pagesCrawled, a.pages == null ? "—" : fi(a.pages)),
    kpi(L.pagesWithIssues, a.pagesWithIssues == null ? "—" : fi(a.pagesWithIssues)),
  ].join("");
  const issues = a.topIssues.length
    ? `<table><thead><tr><th>${escapeHtml(L.issue)}</th><th>${escapeHtml(L.severity)}</th><th class="num">${escapeHtml(L.pages)}</th></tr></thead><tbody>${a.topIssues.map(i => `<tr><td>${escapeHtml(i.code.replace(/_/g, " "))}</td><td><span class="pill ${i.severity}">${i.severity}</span></td><td class="num">${fi(i.count)}</td></tr>`).join("")}</tbody></table>`
    : noData(L, L.noIssues);
  const cwv = a.cwv.length
    ? `<h4>${escapeHtml(L.cwvTitle(fi(a.cwv.length)))}</h4><table><thead><tr><th>${escapeHtml(L.page)}</th><th class="num">${escapeHtml(L.lcp)}</th><th class="num">${escapeHtml(L.inp)}</th><th class="num">${escapeHtml(L.cls)}</th><th class="num">${escapeHtml(L.perf)}</th></tr></thead><tbody>${a.cwv.map(c => `<tr><td>${escapeHtml(shortUrl(c.url))}</td><td class="num">${c.lcp == null ? "—" : (c.lcp / 1000).toFixed(2)}</td><td class="num">${c.inp == null ? "—" : fi(c.inp)}</td><td class="num">${c.cls == null ? "—" : c.cls.toFixed(2)}</td><td class="num">${c.score == null ? "—" : fi(c.score)}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<div class="kpis">${kpis}</div><p class="meta">${escapeHtml(L.lastAudit(fmtDate(a.startedAt.slice(0, 10))))}</p>${issues}${cwv}`;
}

function shortUrl(u: string): string {
  try { const url = new URL(u); return url.pathname + (url.search ? url.search : "") || "/"; } catch { return u.slice(0, 60); }
}

function renderUptime(data: ReportData, { L, fi }: Ctx): string {
  const u = data.uptime!;
  const kpis = [
    kpi(L.uptime, u.uptimePct == null ? "—" : `${u.uptimePct.toFixed(2)}%`),
    kpi(L.incidents, fi(u.incidents.length)),
  ].join("");
  const incidents = u.incidents.length
    ? `<table><thead><tr><th>${escapeHtml(L.started)}</th><th>${escapeHtml(L.cause)}</th><th class="num">${escapeHtml(L.duration)}</th></tr></thead><tbody>${u.incidents.map(i => `<tr><td>${escapeHtml(fmtDate(i.startedAt))}</td><td>${escapeHtml(i.cause)}${i.detail ? ` <span class="meta">· ${escapeHtml(i.detail.slice(0, 80))}</span>` : ""}</td><td class="num">${i.durationMs == null ? escapeHtml(L.ongoing) : escapeHtml(L.minutes(Math.round(i.durationMs / 60000)))}</td></tr>`).join("")}</tbody></table>`
    : `<p>${escapeHtml(L.noIncidents)}</p>`;
  return `<div class="kpis">${kpis}</div><p class="meta">${escapeHtml(L.monitoredUrl(u.url))}</p>${incidents}`;
}

function renderBacklinks(data: ReportData, { L, fi }: Ctx): string {
  const b = data.backlinks!;
  const kpis = [
    kpi(L.newLinks, fi(b.newCount)),
    kpi(L.lostLinks, fi(b.lostCount)),
    // Only for a provider that stores a per-link DR (issue #29): DataForSEO's rank is a different
    // metric and is not stored per link, so the KPI is left out instead of showing a dead "—".
    ...(b.drLabel ? [kpi(L.avgDrNew(b.drLabel), b.avgDr == null ? "—" : b.avgDr.toFixed(1))] : []),
  ].join("");
  const drCol = b.drLabel ? `<th class="num">${escapeHtml(b.drLabel)}</th>` : "";
  const top = b.topNew.length
    ? `<table><thead><tr><th>${escapeHtml(L.newLinkFrom)}</th>${drCol}<th>${escapeHtml(L.anchor)}</th></tr></thead><tbody>${b.topNew.map(r => `<tr><td>${escapeHtml(r.domainFrom || r.urlFrom.slice(0, 60))}</td>${b.drLabel ? `<td class="num">${r.dr == null ? "—" : r.dr.toFixed(0)}</td>` : ""}<td>${escapeHtml(r.anchor.slice(0, 60)) || "—"}</td></tr>`).join("")}</tbody></table>`
    : "";
  const src = `<p class="meta">${escapeHtml(L.blSource(providerLabel(b.provider)))}</p>`;
  return `<div class="kpis">${kpis}</div>${src}${top}`;
}

function renderAi(data: ReportData, { L, fi }: Ctx): string {
  const a = data.ai!;
  const kpis = [
    kpi(L.mentionShare, fmtPct(a.ourShare)),
    kpi(L.citationShare, fmtPct(a.citationShare)),
    kpi(L.answersAnalysed, fi(a.answers)),
  ].join("");
  const top = a.topCited.length
    ? `<table><thead><tr><th>${escapeHtml(L.domain)}</th><th class="num">${escapeHtml(L.citations)}</th></tr></thead><tbody>${a.topCited.map(c => `<tr${c.isUs ? ' style="font-weight:600"' : ""}><td>${escapeHtml(c.domain)}${c.isUs ? " ←" : ""}</td><td class="num">${fi(c.citations)}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<div class="kpis">${kpis}</div><p class="meta">${escapeHtml(L.trackedQuestions(fi(a.questions), a.windowDays))}</p>${top}`;
}

function renderReviews(data: ReportData, { L, fi }: Ctx): string {
  const r = data.reviews!;
  const kpis = [
    kpi(L.newReviews, fi(r.count)),
    kpi(L.avgRating, r.avgRating == null ? "—" : L.ratingOf5(r.avgRating.toFixed(1))),
  ].join("");
  const latest = r.latest.length
    ? r.latest.map(rv => `<blockquote class="review"><div class="stars">${"★".repeat(Math.max(0, Math.min(5, rv.rating)))}${"☆".repeat(Math.max(0, 5 - rv.rating))}</div> <strong>${escapeHtml(rv.author || L.anonymous)}</strong> · ${escapeHtml(fmtDate(rv.createTime))}<br>${escapeHtml(rv.comment)}</blockquote>`).join("")
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
  lang?: ReportLang;    // issue #36 — the report's own language, "en" when unset
}

export function renderReportHTML(input: RenderInput): string {
  const b = { ...DEFAULT_BRANDING, ...(input.branding ?? {}) };
  const accent = b.accentColor || DEFAULT_BRANDING.accentColor;
  const d = input.data;
  const generated = input.generatedAt ?? new Date().toISOString();
  const lang: ReportLang = input.lang ?? "en";
  const L = REPORT_L[lang];
  const fi = REPORT_FMT_INT[lang];

  const summary = buildSummary(d, L, fi);
  const steps = buildNextSteps(d, L, fi);
  const notes = (input.notes ?? "").trim();
  const ctx: Ctx = { L, fi };

  const header = `
<header class="rpt">
  ${b.logoDataUrl ? `<img class="logo" src="${b.logoDataUrl.startsWith("data:") ? b.logoDataUrl : ""}" alt="${escapeHtml(b.companyName || L.logoAlt)}"/>` : ""}
  <div>
    <h1>${escapeHtml(input.title)}</h1>
    <div class="meta">${escapeHtml(d.siteDomain)} · ${fmtDate(d.window.from)} — ${fmtDate(d.window.to)} ${escapeHtml(L.daysPeriod(d.window.days))}</div>
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
          summary.priority ? `<p><strong>${escapeHtml(L.priorityLabel)}</strong> ${escapeHtml(summary.priority)}</p>` : "",
        ].filter(Boolean).join("");
        body = `<div class="summary-lines">${lines || noData(L)}</div>`;
        break;
      }
      case "traffic": body = d.traffic ? renderTraffic(d, accent, ctx) + searchDates(d, L) : noData(L); break;
      case "queries": body = d.queries ? renderRows(d.queries.rows, L.query, ctx) + searchDates(d, L) : noData(L); break;
      case "pages": body = d.pages ? renderRows(d.pages.rows, L.page, ctx) + searchDates(d, L) : noData(L); break;
      case "positions": body = d.positions ? renderPositions(d, ctx) : noData(L); break;
      case "local_positions": body = d.local ? renderLocal(d, ctx) : noData(L); break;
      case "indexing": body = d.indexing ? renderIndexing(d, ctx) : noData(L); break;
      case "audit": body = d.audit ? renderAudit(d, ctx) : noData(L); break;
      case "uptime": body = d.uptime ? renderUptime(d, ctx) : noData(L); break;
      case "backlinks": body = d.backlinks ? renderBacklinks(d, ctx) : noData(L); break;
      case "ai_visibility": body = d.ai ? renderAi(d, ctx) : noData(L); break;
      case "reviews": body = d.reviews ? renderReviews(d, ctx) : noData(L); break;
      case "work_done": body = notes ? markdownToHtml(notes) : noData(L, L.noNotes); break;
      case "next_steps": body = steps.length ? `<ul class="steps">${steps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : noData(L); break;
      default: body = "";
    }
    if (!body) continue;
    bodies.push(`<section class="section${first ? " first" : ""}"><h2>${escapeHtml(L.sectionTitles[id])}</h2>${body}</section>`);
    first = false;
  }

  const poweredBy = b.showPoweredBy
    ? L.madeWith('<a href="https://opengsc.com" rel="noopener noreferrer" target="_blank">OpenGSC</a>')
    : "";
  const footer = `
<footer class="rpt">
  <div>${escapeHtml(b.footer)}</div>
  <div>${poweredBy}${poweredBy ? " · " : ""}${escapeHtml(L.generatedAt(fmtDate(generated)))}</div>
</footer>`;

  return `<!doctype html>
<html lang="${REPORT_HTML_LANG[lang]}">
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
