export type AuditRuleSeverity = "critical" | "warning" | "info";
export type AuditRuleCategory = "crawlability" | "metadata" | "content" | "links" | "performance" | "rendering";

export interface AuditRuleDefinition {
  id: string;
  severity: AuditRuleSeverity;
  category: AuditRuleCategory;
  titleKey: string;
  scope: "page" | "site";
}

/**
 * Stable registry shared by the crawler, UI and MCP surfaces.
 *
 * Rule ids are persisted in SiteAuditPage.issues and therefore must never be renamed to improve
 * wording; change the localized title instead. Adding a rule is backward compatible because old
 * audit rows simply do not contain its id.
 */
export const AUDIT_RULES: readonly AuditRuleDefinition[] = [
  { id: "http_error", severity: "critical", category: "crawlability", titleKey: "auditIssueHttpError", scope: "page" },
  { id: "fetch_failed", severity: "critical", category: "crawlability", titleKey: "auditIssueFetchFailed", scope: "page" },
  { id: "redirect", severity: "warning", category: "crawlability", titleKey: "auditIssueRedirect", scope: "page" },
  { id: "title_missing", severity: "warning", category: "metadata", titleKey: "auditIssueTitleMissing", scope: "page" },
  { id: "title_too_long", severity: "warning", category: "metadata", titleKey: "auditIssueTitleTooLong", scope: "page" },
  { id: "title_duplicate", severity: "warning", category: "metadata", titleKey: "auditIssueTitleDuplicate", scope: "site" },
  { id: "description_missing", severity: "warning", category: "metadata", titleKey: "auditIssueDescriptionMissing", scope: "page" },
  { id: "description_too_long", severity: "warning", category: "metadata", titleKey: "auditIssueDescriptionTooLong", scope: "page" },
  { id: "h1_missing", severity: "warning", category: "content", titleKey: "auditIssueH1Missing", scope: "page" },
  { id: "h1_multiple", severity: "warning", category: "content", titleKey: "auditIssueH1Multiple", scope: "page" },
  { id: "noindex", severity: "critical", category: "crawlability", titleKey: "auditIssueNoindex", scope: "page" },
  { id: "canonical_mismatch", severity: "warning", category: "metadata", titleKey: "auditIssueCanonicalMismatch", scope: "page" },
  { id: "thin_content", severity: "warning", category: "content", titleKey: "auditIssueThinContent", scope: "page" },
  { id: "images_no_alt", severity: "warning", category: "content", titleKey: "auditIssueImagesNoAlt", scope: "page" },
  { id: "broken_links", severity: "critical", category: "links", titleKey: "auditIssueBrokenLinks", scope: "page" },
  { id: "slow_response", severity: "warning", category: "performance", titleKey: "auditIssueSlowResponse", scope: "page" },
  { id: "js_rendered", severity: "info", category: "rendering", titleKey: "auditIssueJsRendered", scope: "page" },
] as const;

export const AUDIT_RULE_IDS = AUDIT_RULES.map(rule => rule.id);
export const AUDIT_RULE_BY_ID = new Map(AUDIT_RULES.map(rule => [rule.id, rule]));
