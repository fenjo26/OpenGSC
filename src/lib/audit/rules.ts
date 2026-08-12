export type AuditRuleSeverity = "critical" | "warning" | "info";
export type AuditRuleCategory = "crawlability" | "metadata" | "content" | "links" | "performance" | "rendering" | "security";

export interface AuditPageFacts {
  hasHtml: boolean;
  isRoot: boolean;
  isHttps: boolean;
  httpStatus: number;
  loadMs: number;
  redirectHops: number;
  redirectLoop: boolean;
  title: string;
  titleDuplicate: boolean;
  metaDescription: string;
  robots: string;
  robotsConflict: boolean;
  canonical: string | null;
  canonicalInvalid: boolean;
  canonicalMismatch: boolean;
  h1Count: number;
  wordCount: number;
  imagesNoAlt: number;
  brokenLinkCount: number;
  jsRendered: boolean;
  viewportPresent: boolean;
  htmlLang: string;
  jsonLdInvalid: number;
  organizationSchemaIncomplete: boolean;
  openGraphMissing: number;
  twitterCardIncomplete: boolean;
  mixedContentCount: number;
  missingSecurityHeaders: number;
  sitemapSeeded: boolean;
  internalInboundLinks: number;
}

export interface AuditRuleDefinition {
  id: string;
  severity: AuditRuleSeverity;
  category: AuditRuleCategory;
  titleKey: string;
  scope: "page" | "site";
  /** False for useful-but-not-universal checks that should not change the established health score. */
  affectsScore?: boolean;
  evaluate: (facts: AuditPageFacts) => boolean;
}

const html = (facts: AuditPageFacts) => facts.hasHtml;
const visibleHtml = (facts: AuditPageFacts) => facts.hasHtml && !facts.jsRendered;

/**
 * Stable Site Audit registry shared by the crawler, UI, exports and MCP.
 *
 * This registry belongs only to the built-in runtime Site Audit. It deliberately does not import
 * or evaluate AI Visibility or SEO Tools → GEO state: those products have different inputs,
 * persistence and user expectations even when a signal sounds similar.
 *
 * Rule ids are persisted in SiteAuditPage.issues and therefore must never be renamed to improve
 * wording; change the localized title instead. Adding a rule is backward compatible because old
 * audit rows simply do not contain its id.
 */
export const AUDIT_RULES: readonly AuditRuleDefinition[] = [
  { id: "http_error", severity: "critical", category: "crawlability", titleKey: "auditIssueHttpError", scope: "page", evaluate: facts => facts.httpStatus >= 400 },
  { id: "fetch_failed", severity: "critical", category: "crawlability", titleKey: "auditIssueFetchFailed", scope: "page", evaluate: facts => facts.httpStatus === 0 },
  { id: "redirect", severity: "warning", category: "crawlability", titleKey: "auditIssueRedirect", scope: "page", evaluate: facts => facts.httpStatus >= 300 && facts.httpStatus < 400 },
  { id: "redirect_chain", severity: "warning", category: "crawlability", titleKey: "auditIssueRedirectChain", scope: "page", evaluate: facts => facts.redirectHops > 1 && !facts.redirectLoop },
  { id: "redirect_loop", severity: "critical", category: "crawlability", titleKey: "auditIssueRedirectLoop", scope: "page", evaluate: facts => facts.redirectLoop },
  { id: "title_missing", severity: "warning", category: "metadata", titleKey: "auditIssueTitleMissing", scope: "page", evaluate: facts => html(facts) && !facts.title },
  { id: "title_too_long", severity: "warning", category: "metadata", titleKey: "auditIssueTitleTooLong", scope: "page", evaluate: facts => html(facts) && facts.title.length > 65 },
  { id: "title_duplicate", severity: "warning", category: "metadata", titleKey: "auditIssueTitleDuplicate", scope: "site", evaluate: facts => html(facts) && facts.titleDuplicate },
  { id: "description_missing", severity: "warning", category: "metadata", titleKey: "auditIssueDescriptionMissing", scope: "page", evaluate: facts => html(facts) && !facts.metaDescription },
  { id: "description_too_long", severity: "warning", category: "metadata", titleKey: "auditIssueDescriptionTooLong", scope: "page", evaluate: facts => html(facts) && facts.metaDescription.length > 165 },
  { id: "h1_missing", severity: "warning", category: "content", titleKey: "auditIssueH1Missing", scope: "page", evaluate: facts => visibleHtml(facts) && facts.h1Count === 0 },
  { id: "h1_multiple", severity: "warning", category: "content", titleKey: "auditIssueH1Multiple", scope: "page", evaluate: facts => visibleHtml(facts) && facts.h1Count > 1 },
  { id: "noindex", severity: "critical", category: "crawlability", titleKey: "auditIssueNoindex", scope: "page", evaluate: facts => html(facts) && /(^|[\s,;:])noindex(?=$|[\s,;])/i.test(facts.robots) },
  { id: "robots_conflict", severity: "warning", category: "crawlability", titleKey: "auditIssueRobotsConflict", scope: "page", evaluate: facts => html(facts) && facts.robotsConflict },
  { id: "canonical_missing", severity: "warning", category: "metadata", titleKey: "auditIssueCanonicalMissing", scope: "page", affectsScore: false, evaluate: facts => html(facts) && !facts.canonical },
  { id: "canonical_invalid", severity: "warning", category: "metadata", titleKey: "auditIssueCanonicalInvalid", scope: "page", evaluate: facts => html(facts) && facts.canonicalInvalid },
  { id: "canonical_mismatch", severity: "warning", category: "metadata", titleKey: "auditIssueCanonicalMismatch", scope: "page", evaluate: facts => html(facts) && facts.canonicalMismatch },
  { id: "thin_content", severity: "warning", category: "content", titleKey: "auditIssueThinContent", scope: "page", evaluate: facts => visibleHtml(facts) && facts.wordCount < 150 },
  { id: "images_no_alt", severity: "warning", category: "content", titleKey: "auditIssueImagesNoAlt", scope: "page", evaluate: facts => html(facts) && facts.imagesNoAlt > 0 },
  { id: "broken_links", severity: "critical", category: "links", titleKey: "auditIssueBrokenLinks", scope: "page", evaluate: facts => html(facts) && facts.brokenLinkCount > 0 },
  { id: "orphan_sitemap_page", severity: "warning", category: "links", titleKey: "auditIssueOrphanSitemapPage", scope: "site", affectsScore: false, evaluate: facts => html(facts) && facts.sitemapSeeded && facts.internalInboundLinks === 0 },
  { id: "slow_response", severity: "warning", category: "performance", titleKey: "auditIssueSlowResponse", scope: "page", evaluate: facts => facts.loadMs > 3000 },
  { id: "js_rendered", severity: "info", category: "rendering", titleKey: "auditIssueJsRendered", scope: "page", evaluate: facts => html(facts) && facts.jsRendered },
  { id: "viewport_missing", severity: "warning", category: "rendering", titleKey: "auditIssueViewportMissing", scope: "page", evaluate: facts => html(facts) && !facts.viewportPresent },
  { id: "lang_missing", severity: "info", category: "content", titleKey: "auditIssueLangMissing", scope: "page", evaluate: facts => html(facts) && !facts.htmlLang },
  { id: "jsonld_invalid", severity: "warning", category: "metadata", titleKey: "auditIssueJsonLdInvalid", scope: "page", evaluate: facts => html(facts) && facts.jsonLdInvalid > 0 },
  { id: "organization_schema_incomplete", severity: "info", category: "metadata", titleKey: "auditIssueOrganizationSchemaIncomplete", scope: "site", evaluate: facts => html(facts) && facts.isRoot && facts.organizationSchemaIncomplete },
  { id: "open_graph_incomplete", severity: "info", category: "metadata", titleKey: "auditIssueOpenGraphIncomplete", scope: "page", evaluate: facts => html(facts) && facts.openGraphMissing > 0 },
  { id: "twitter_card_incomplete", severity: "info", category: "metadata", titleKey: "auditIssueTwitterCardIncomplete", scope: "page", evaluate: facts => html(facts) && facts.twitterCardIncomplete },
  { id: "mixed_content", severity: "warning", category: "security", titleKey: "auditIssueMixedContent", scope: "page", evaluate: facts => html(facts) && facts.isHttps && facts.mixedContentCount > 0 },
  { id: "security_headers_missing", severity: "warning", category: "security", titleKey: "auditIssueSecurityHeadersMissing", scope: "site", affectsScore: false, evaluate: facts => html(facts) && facts.isRoot && facts.missingSecurityHeaders > 0 },
] as const;

export const AUDIT_RULE_IDS = AUDIT_RULES.map(rule => rule.id);
export const AUDIT_RULE_BY_ID = new Map(AUDIT_RULES.map(rule => [rule.id, rule]));
export const AUDIT_ACTIONABLE_RULE_IDS = new Set(AUDIT_RULES.filter(rule => rule.severity !== "info").map(rule => rule.id));
export const AUDIT_SCORING_RULE_IDS = new Set(AUDIT_RULES.filter(rule => rule.severity !== "info" && rule.affectsScore !== false).map(rule => rule.id));

export function evaluateAuditPageRules(facts: AuditPageFacts): string[] {
  return AUDIT_RULES.filter(rule => rule.evaluate(facts)).map(rule => rule.id);
}
