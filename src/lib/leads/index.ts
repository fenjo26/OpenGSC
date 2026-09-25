// N9 (docs/tasks/wave-nov/N9-audit-widget-leads.md) — the embeddable audit widget contour:
// the public lite audit, rate limiting, lead storage, proposals. The wave foundation stub
// (CONTRACT.md §3) is replaced by real modules; this barrel re-exports the public surface.

export * from "./types";
export { LEAD_STRINGS, t2, localizeFindings, consequenceOf } from "./i18n";
export { hashIp, ipSalt, WindowCounter, takeAuditQuota, takeLeadQuota, AUDIT_LIMITS } from "./ratelimit";
export { checkOrigin, normalizeOriginHost, refererHost } from "./originGuard";
export { AuditCache, auditCache, CACHE_TTL_MS, TOKEN_TTL_MS } from "./cache";
export {
  runLiteAudit, widgetFetch, normalizeAuditDomain, LiteAuditError,
  scoreFromFindings, topFindings, WIDGET_UA, MAX_PAGES, PAGE_MAX_BYTES, TOTAL_BUDGET_MS, HEAD_CHECK_LIMIT,
} from "./liteAudit";
export {
  parseWidgetSettings, DEFAULT_WIDGET_SETTINGS, generateWidgetKey, findUserByWidgetKey,
  readWidgetSettings, saveWidgetSettings, publicWidgetConfig, turnstileConfigured, WidgetSettingsError,
} from "./settings";
export type { WidgetSettings, WidgetOwnerRow, PublicWidgetConfig } from "./settings";
export {
  generateProposal, generateDraftEmail, mailtoUrl, proposalToHtml, parseBranding,
  groupFindings, containsForecast, NO_FORECAST_MARKERS,
} from "./proposal";
export type { ProposalInput, DraftEmail, ProposalBranding } from "./proposal";
export { leadsToCsv, csvCell } from "./csv";
export { sendFullReportEmail, sendLeadNotificationCopy, smtpConfigured } from "./email";
export { listLeads, getLead, updateLead, createLead, leadsSchemaMissing, LeadStoreError } from "./store";
export type { LeadFilter, CreateLeadInput } from "./store";
