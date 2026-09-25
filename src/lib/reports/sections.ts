// N8 — the section vocabulary of a client report. Pure module: no Prisma, no React.
//
// A report is an ordered list of section ids (ClientReport.sections, JSON array). The
// templates below are the default sets the constructor starts from; the operator can then
// tick sections off/on. Order follows REPORT_SECTION_IDS — the id list is the single
// source of the rendering order, so a hand-edited sections array still renders in a
// stable, readable sequence no matter how it was stored.

export const REPORT_SECTION_IDS = [
  "summary",
  "traffic",
  "queries",
  "pages",
  "positions",
  "local_positions",
  "indexing",
  "audit",
  "uptime",
  "backlinks",
  "ai_visibility",
  "reviews",
  "work_done",
  "next_steps",
] as const;

export type ReportSectionId = (typeof REPORT_SECTION_IDS)[number];

export type ReportTemplateId = "executive" | "detailed" | "technical" | "local";

export const REPORT_TEMPLATE_IDS: ReportTemplateId[] = ["executive", "detailed", "technical", "local"];

/** Template → the default section set (N8 brief §2). */
export const REPORT_TEMPLATES: Record<ReportTemplateId, ReportSectionId[]> = {
  // Summary, traffic, best queries, positions, the operator's notes.
  executive: ["summary", "traffic", "queries", "positions", "work_done"],
  // Everything executive has, plus pages, indexing, backlinks and uptime.
  detailed: ["summary", "traffic", "queries", "positions", "work_done", "pages", "indexing", "backlinks", "uptime"],
  // Audit (health score, top issues and the Core Web Vitals sample it carries), indexing, uptime.
  technical: ["audit", "indexing", "uptime"],
  // Local positions (organic + map pack + the NAP citation status block), GBP reviews.
  local: ["local_positions", "reviews"],
};

/**
 * UI i18n key of one section. The keys are extra (not in the N0 table) — they are listed
 * in the N8 report for R's locale pass; until then t() shows the key itself.
 */
export function sectionLabelKey(id: ReportSectionId): string {
  return `repSection_${id}`;
}

/**
 * Built-in English titles. The frozen snapshot must never depend on locale files the
 * instance may not have shipped keys for, so the HTML renderer speaks these directly and
 * only the dashboard UI goes through t().
 */
export const SECTION_TITLES_EN: Record<ReportSectionId, string> = {
  summary: "Summary",
  traffic: "Traffic",
  queries: "Top queries",
  pages: "Top pages",
  positions: "Positions",
  local_positions: "Local visibility",
  indexing: "Indexing",
  audit: "Site audit",
  uptime: "Uptime",
  backlinks: "Backlinks",
  ai_visibility: "AI visibility",
  reviews: "Reviews",
  work_done: "What we did",
  next_steps: "Next steps",
};

/** Parse an unknown JSON value into a valid ordered section list; [] when nothing valid. */
export function parseSections(raw: unknown): ReportSectionId[] {
  const list = Array.isArray(raw) ? raw : [];
  const set = new Set(list.filter((s): s is ReportSectionId =>
    typeof s === "string" && (REPORT_SECTION_IDS as readonly string[]).includes(s)));
  // Canonical order: REPORT_SECTION_IDS order, not the stored order.
  return REPORT_SECTION_IDS.filter(id => set.has(id));
}

export function parseTemplate(raw: unknown): ReportTemplateId {
  const v = String(raw ?? "");
  return (REPORT_TEMPLATE_IDS as string[]).includes(v) ? (v as ReportTemplateId) : "executive";
}
