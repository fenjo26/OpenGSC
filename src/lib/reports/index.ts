// N8 — client reports (docs/REPORTS.md): white-label HTML snapshots + PDF, scheduled
// e-mail and the client link /share/report/<token>. This barrel exposes the surface the
// routes, the scheduler and the MCP tool use; the pieces themselves stay in their own
// modules so the pure ones (sections, branding, schedule, render) test without a database.

export * from "./sections";
export * from "./branding";
export * from "./schedule";
export * from "./render";
export type * from "./collect";
export {
  listReports, getReport, createReport, updateReport, deleteReport,
  rotateShareToken, disableShareToken, getBranding, saveBranding,
  renderPreview, createAndSendRun, reportsSchemaMissing, smtpReady,
  listSiteOptions, PERIOD_DAYS,
  type ReportRow, type ReportInput, type UpsertResult, type RunResult, type RenderedRun,
} from "./store";
export { startReportsScheduler, kickReportsScheduler } from "./scheduler";
export { renderReportPdf, reportPdfPath } from "./pdf";
export { sendReportEmail, buildReportEmail, isSmtpConfigured } from "./mail";
