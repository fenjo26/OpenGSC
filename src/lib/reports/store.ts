// N8 — the only reports module the API routes talk to. CRUD, share tokens, snapshot
// creation and the send pipeline live here; the scheduler reuses the same functions so a
// manual "Send now" and the nightly tick produce byte-identical runs.
//
// The ClientReport* models are reached through the untyped accessor (drops/store
// convention): instances that pulled the code but have not run `prisma db push` answer
// notMigrated instead of crashing on a missing table at import time.

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { instanceUrl } from "@/lib/notify/channels";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang, type NotifyLang } from "@/lib/notifyI18n";
import { DEFAULT_BRANDING, parseBranding, type ReportBranding } from "./branding";
import { parseSections, parseTemplate, REPORT_TEMPLATES, type ReportSectionId, type ReportTemplateId } from "./sections";
import { nextSendAt, parseRecipients, validSendDay, type ReportSchedule } from "./schedule";
import { collectReportData, reportWindow, type ReportData } from "./collect";
import { buildSummary, renderReportHTML } from "./render";
import { renderReportPdf } from "./pdf";
import { buildReportEmail, isSmtpConfigured, sendReportEmail } from "./mail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
const db = prisma as any;

/** One row of a table that may predate the pushed schema — every field is read defensively. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client predates the schema
type Row = Record<string, any>;

/** True when the failure is "table does not exist", not a real error (drops/store pattern). */
export function reportsSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /ClientReport(?:Run)?\s.*(?:does not exist|no such table)/i.test(String(value?.message ?? "")) ||
    /column.*reportBranding.*does not exist/i.test(String(value?.message ?? ""))
  );
}

export const PERIOD_DAYS = [7, 30, 90] as const;

// ─── read ─────────────────────────────────────────────────────────────────────

export interface ReportRow {
  id: string;
  siteId: string;
  siteDomain: string;
  title: string;
  template: string;
  sections: ReportSectionId[];
  periodDays: number;
  schedule: string;
  sendDay: number;
  recipients: string[];
  notes: string;
  shareToken: string | null;
  lastSentAt: string | null;
  nextSendAt: string | null;
  createdAt: string;
  runs: { id: string; createdAt: string; periodFrom: string; periodTo: string; hasPdf: boolean; sentTo: string | null; error: string | null }[];
}

function domainOf(site: { siteId: string; url: string | null }): string {
  const raw = site.siteId.startsWith("sc-domain:") ? site.siteId.slice("sc-domain:".length) : (site.url || site.siteId);
  return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

function toRow(r: Row, runs: Row[] = []): ReportRow {
  return {
    id: String(r.id),
    siteId: String(r.siteId),
    siteDomain: r.site ? domainOf(r.site) : String(r.siteId),
    title: String(r.title ?? ""),
    template: parseTemplate(r.template),
    sections: parseSections(JSON.parse(r.sections ?? "[]")),
    periodDays: Number(r.periodDays) || 30,
    schedule: String(r.schedule ?? "off"),
    sendDay: Number(r.sendDay) || 1,
    recipients: parseRecipients(r.recipients).to,
    notes: String(r.notes ?? ""),
    shareToken: r.shareToken ?? null,
    lastSentAt: r.lastSentAt ? new Date(r.lastSentAt).toISOString() : null,
    nextSendAt: r.nextSendAt ? new Date(r.nextSendAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    runs: runs.map(run => ({
      id: String(run.id),
      createdAt: new Date(run.createdAt).toISOString(),
      periodFrom: new Date(run.periodFrom).toISOString().slice(0, 10),
      periodTo: new Date(run.periodTo).toISOString().slice(0, 10),
      hasPdf: Boolean(run.pdfPath),
      sentTo: run.sentTo ?? null,
      error: run.error ?? null,
    })),
  };
}

export async function listReports(userId: string): Promise<ReportRow[]> {
  const rows: Row[] = await db.clientReport.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { site: { select: { siteId: true, url: true } }, runs: { orderBy: { createdAt: "desc" }, take: 30 } },
  });
  return rows.map(r => toRow(r, r.runs ?? []));
}

/** Site picker for the constructor — db only, no Google round-trip (/api/gsc/sites calls one). */
export async function listSiteOptions(userId: string): Promise<{ id: string; domain: string }[]> {
  const sites: { id: string; siteId: string; url: string | null }[] = await db.site.findMany({
    where: { userId },
    select: { id: true, siteId: true, url: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  return sites.map(s => ({ id: s.id, domain: domainOf(s) }));
}

export async function getReport(userId: string, id: string): Promise<ReportRow | null> {
  const r: Row | null = await db.clientReport.findFirst({
    where: { id, userId },
    include: { site: { select: { siteId: true, url: true } }, runs: { orderBy: { createdAt: "desc" }, take: 30 } },
  });
  return r ? toRow(r, r.runs ?? []) : null;
}

// ─── write ────────────────────────────────────────────────────────────────────

export interface ReportInput {
  siteId: string;
  title: string;
  template: string;
  sections: unknown;
  periodDays: number;
  schedule: string;
  sendDay: number;
  recipients: string;
  notes: string;
}

export type UpsertResult = { ok: true; report: ReportRow } | { ok: false; error: string };

function validateInput(body: ReportInput): { error: string } | { value: Required<ReportInput>; schedule: ReportSchedule; template: ReportTemplateId; sections: ReportSectionId[] } {
  const title = String(body.title ?? "").trim().slice(0, 120);
  if (!title) return { error: "title_required" };
  const siteId = String(body.siteId ?? "").trim();
  if (!siteId) return { error: "site_required" };
  const template = parseTemplate(body.template);
  let sections = parseSections(body.sections);
  if (!sections.length) sections = REPORT_TEMPLATES[template];
  const periodDays = PERIOD_DAYS.includes(Number(body.periodDays) as 7 | 30 | 90) ? Number(body.periodDays) : 30;
  const scheduleRaw = String(body.schedule ?? "off");
  const schedule = (["off", "weekly", "monthly"].includes(scheduleRaw) ? scheduleRaw : "off") as ReportSchedule;
  const { to, invalid } = parseRecipients(body.recipients);
  if (invalid.length) return { error: "invalid_recipients" };
  // A scheduled report nobody would receive is a misconfiguration the UI cannot fix later —
  // the scheduler would render a run every week that no one ever sees.
  if (schedule !== "off" && !to.length) return { error: "recipients_required" };
  const notes = String(body.notes ?? "").slice(0, 8000);
  return {
    value: { siteId, title, template, sections, periodDays, schedule, sendDay: validSendDay(schedule, body.sendDay), recipients: to.join(", "), notes },
    schedule,
    template,
    sections,
  };
}

export async function createReport(userId: string, body: ReportInput): Promise<UpsertResult> {
  const v = validateInput(body);
  if ("error" in v) return { ok: false, error: v.error };
  const site: { id: string } | null = await db.site.findFirst({ where: { id: v.value.siteId, userId }, select: { id: true } });
  if (!site) return { ok: false, error: "site_not_found" };
  const r = await db.clientReport.create({
    data: {
      userId,
      siteId: v.value.siteId,
      title: v.value.title,
      template: v.value.template,
      sections: JSON.stringify(v.value.sections),
      periodDays: v.value.periodDays,
      schedule: v.value.schedule,
      sendDay: v.value.sendDay,
      recipients: v.value.recipients,
      notes: v.value.notes,
      nextSendAt: nextSendAt(v.schedule, v.value.sendDay) ?? null,
    },
  });
  return { ok: true, report: toRow(r) };
}

export async function updateReport(userId: string, id: string, body: ReportInput): Promise<UpsertResult> {
  const v = validateInput(body);
  if ("error" in v) return { ok: false, error: v.error };
  const existing: Row | null = await db.clientReport.findFirst({ where: { id, userId } });
  if (!existing) return { ok: false, error: "not_found" };
  const r = await db.clientReport.update({
    where: { id },
    data: {
      siteId: v.value.siteId,
      title: v.value.title,
      template: v.value.template,
      sections: JSON.stringify(v.value.sections),
      periodDays: v.value.periodDays,
      schedule: v.value.schedule,
      sendDay: v.value.sendDay,
      recipients: v.value.recipients,
      notes: v.value.notes,
      // Rescheduled from now, not from the stored nextSendAt — an edit means the operator
      // just chose a new rhythm, and "weekly Friday" edited on a Saturday fires this Friday.
      nextSendAt: nextSendAt(v.schedule, v.value.sendDay) ?? null,
    },
  });
  return { ok: true, report: toRow(r) };
}

export async function deleteReport(userId: string, id: string): Promise<boolean> {
  const r = await db.clientReport.deleteMany({ where: { id, userId } });
  return Boolean(r?.count);
}

// ─── share token ──────────────────────────────────────────────────────────────

/** 32 random bytes, base64url — the same entropy class as the site share token. */
export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function rotateShareToken(userId: string, id: string): Promise<UpsertResult> {
  const r: Row | null = await db.clientReport.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, error: "not_found" };
  const updated = await db.clientReport.update({ where: { id }, data: { shareToken: newShareToken() } });
  return { ok: true, report: toRow(updated) };
}

export async function disableShareToken(userId: string, id: string): Promise<UpsertResult> {
  const r: Row | null = await db.clientReport.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, error: "not_found" };
  const updated = await db.clientReport.update({ where: { id }, data: { shareToken: null } });
  return { ok: true, report: toRow(updated) };
}

// ─── branding (User.reportBranding) ───────────────────────────────────────────

export async function getBranding(userId: string): Promise<ReportBranding> {
  const u: { reportBranding?: string | null } | null = await db.user.findUnique({ where: { id: userId }, select: { reportBranding: true } });
  if (!u?.reportBranding) return { ...DEFAULT_BRANDING };
  try {
    return { ...DEFAULT_BRANDING, ...parseBranding(JSON.parse(u.reportBranding)).branding };
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export async function saveBranding(userId: string, raw: unknown): Promise<{ branding: ReportBranding; issues: string[] }> {
  const { branding, issues } = parseBranding(raw);
  await db.user.update({ where: { id: userId }, data: { reportBranding: JSON.stringify(branding) } });
  return { branding, issues };
}

// ─── render / snapshot / send ─────────────────────────────────────────────────

export interface RenderedRun { html: string; data: ReportData }

/** Live render (no snapshot). Used by Preview — the operator sees exactly what will freeze. */
export async function renderPreview(userId: string, id: string): Promise<RenderedRun | { error: string }> {
  const r: Row | null = await db.clientReport.findFirst({ where: { id, userId } });
  if (!r) return { error: "not_found" };
  const sections = parseSections(JSON.parse(r.sections ?? "[]"));
  const w = reportWindow(Number(r.periodDays) || 30);
  const branding = await getBranding(userId);
  const data = await collectReportData(userId, String(r.siteId), w, sections);
  const html = renderReportHTML({
    title: String(r.title ?? ""), sections, data, branding,
    notes: String(r.notes ?? ""), generatedAt: new Date().toISOString(),
  });
  return { html, data };
}

export interface RunResult {
  runId: string;
  sentTo: string | null;
  pdf: boolean;
  error: string | null;
}

/**
 * Create the frozen snapshot: render → store ClientReportRun.html → attempt the PDF →
 * e-mail the recipients → notify the owner. `send: false` (preview-grade snapshot for
 * instances without SMTP) still stores the run — the report exists, only the mail is off.
 */
export async function createAndSendRun(userId: string, id: string, opts: { send: boolean; lang?: string }): Promise<RunResult | { error: string }> {
  const r: Row | null = await db.clientReport.findFirst({ where: { id, userId } });
  if (!r) return { error: "not_found" };
  const sections = parseSections(JSON.parse(r.sections ?? "[]"));
  const w = reportWindow(Number(r.periodDays) || 30);
  const branding = await getBranding(userId);
  const data = await collectReportData(userId, String(r.siteId), w, sections);
  const html = renderReportHTML({
    title: String(r.title ?? ""), sections, data, branding,
    notes: String(r.notes ?? ""), generatedAt: new Date().toISOString(),
  });

  const run: Row = await db.clientReportRun.create({
    data: { reportId: id, periodFrom: w.from, periodTo: w.to, html },
  });

  const pdf = await renderReportPdf(String(run.id), html);
  if (pdf.ok) await db.clientReportRun.update({ where: { id: run.id }, data: { pdfPath: pdf.path } });

  let sentTo: string | null = null;
  let error: string | null = null;
  const { to } = parseRecipients(r.recipients);
  if (opts.send) {
    if (!to.length) {
      error = "no_recipients";
    } else {
      const summary = buildSummary(data);
      const clientUrl = r.shareToken ? `${instanceUrl()}/share/report/${r.shareToken}` : null;
      const mail = buildReportEmail(
        {
          title: String(r.title ?? ""), siteDomain: data.siteDomain,
          periodFrom: w.from.toISOString().slice(0, 10), periodTo: w.to.toISOString().slice(0, 10),
          clientUrl,
          branding: { companyName: branding.companyName, accentColor: branding.accentColor, footer: branding.footer },
        },
        [summary.direction, summary.win, summary.priority].filter((s): s is string => Boolean(s)),
      );
      const res = await sendReportEmail(userId, { ...mail, to });
      if (res.ok) {
        sentTo = to.join(", ");
        await db.clientReportRun.update({ where: { id: run.id }, data: { sentTo } });
        const lang: NotifyLang = normalizeLang(opts.lang);
        // Owner receipt on the "digest" event (CONTRACT §5) — the client got the mail, the
        // operator's channels get one line saying so.
        await notifyUser(userId, NOTIFY_L[lang].reportSentMsg(String(r.title ?? ""), sentTo), { event: "digest" }).catch(() => {});
      } else {
        error = res.error;
      }
    }
  }
  if (error) await db.clientReportRun.update({ where: { id: run.id }, data: { error } });
  await db.clientReport.update({ where: { id }, data: { lastSentAt: sentTo ? new Date() : r.lastSentAt } });
  return { runId: String(run.id), sentTo, pdf: pdf.ok, error };
}

/** Advance nextSendAt after a scheduled send; reports with no schedule stay off the list. */
export async function reschedule(report: Row): Promise<void> {
  const schedule = String(report.schedule ?? "off") as ReportSchedule;
  const next = nextSendAt(schedule, Number(report.sendDay) || 1);
  await db.clientReport.update({ where: { id: report.id }, data: { nextSendAt: next, lastSentAt: next ? new Date() : report.lastSentAt } });
}

export async function smtpReady(userId: string): Promise<boolean> {
  return isSmtpConfigured(userId);
}
