import { META_LIMITS } from "@/lib/seo/metaLimits";
import { pageMatchesQuery } from "./queryAlign";

export type AuditRuleSeverity = "critical" | "warning" | "info";
export type AuditRuleCategory = "crawlability" | "metadata" | "content" | "links" | "performance" | "rendering" | "security";

export interface AuditMainQuery {
  query: string;
  impressions: number;
}

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
  /**
   * Text of the first H1 (≤ 200 chars) — needed by title_query_mismatch and the meta-fit items.
   *
   * The wave-oct fields below this line are optional: the full crawler always fills them, but
   * the quick single-page scanner (src/lib/scanner/scan.ts) reuses AuditPageFacts and cannot
   * compute cross-page or GSC-joined facts. Absent = unknown, and unknown never fires a rule.
   */
  h1Text?: string;
  wordCount: number;
  imagesNoAlt: number;
  brokenLinkCount: number;
  jsRendered: boolean;
  viewportPresent: boolean;
  /** Viewport present AND responsive (device-width, zoom not blocked); undefined = not extracted. */
  viewportResponsive?: boolean;
  htmlLang: string;
  /** hreflang problems on the page's own set, from checkHreflangSite. */
  hreflangInvalid?: string[];
  hreflangNoReturn?: string[];
  hreflangSelfMissing?: boolean;
  hreflangTargetBad?: string[];
  hreflangXDefaultMissing?: boolean;
  langHreflangMismatch?: string;
  /** Internal link targets that answered 3xx during the crawl (evidence carries up to 5). */
  internalRedirectLinks?: string[];
  imagesNoDimensions?: number;
  /** Decoded HTML size in bytes. */
  htmlBytes?: number;
  /** The page's main GSC query over 28 d (max impressions, ≥ 20); null = no data, rule silent. */
  mainQuery?: AuditMainQuery | null;
  /** Evidence string from the PSI stage ("LCP 4.3 s · CLS 0.31 · field"); null = not poor / not sampled. */
  cwvPoor?: string | null;
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
  { id: "title_too_long", severity: "warning", category: "metadata", titleKey: "auditIssueTitleTooLong", scope: "page", evaluate: facts => html(facts) && facts.title.length > META_LIMITS.title.auditMax },
  { id: "title_too_short", severity: "warning", category: "metadata", titleKey: "auditIssueTitleTooShort", scope: "page", evaluate: facts => html(facts) && facts.title.length > 0 && facts.title.length < META_LIMITS.title.auditMin },
  { id: "title_duplicate", severity: "warning", category: "metadata", titleKey: "auditIssueTitleDuplicate", scope: "site", evaluate: facts => html(facts) && facts.titleDuplicate },
  { id: "description_missing", severity: "warning", category: "metadata", titleKey: "auditIssueDescriptionMissing", scope: "page", evaluate: facts => html(facts) && !facts.metaDescription },
  { id: "description_too_long", severity: "warning", category: "metadata", titleKey: "auditIssueDescriptionTooLong", scope: "page", evaluate: facts => html(facts) && facts.metaDescription.length > META_LIMITS.description.auditMax },
  { id: "description_too_short", severity: "warning", category: "metadata", titleKey: "auditIssueDescriptionTooShort", scope: "page", evaluate: facts => html(facts) && facts.metaDescription.length > 0 && facts.metaDescription.length < META_LIMITS.description.auditMin },
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
  // ─── hreflang (wave-oct T5): set validity, reciprocity, target health ─────────────
  // Not gated on hasHtml: a set can live entirely in the Link header or the sitemap, so the
  // facts arrays are the trigger, whatever produced them. Optional facts (single-page scanner)
  // are unknown, and unknown never fires.
  { id: "hreflang_invalid", severity: "warning", category: "metadata", titleKey: "auditIssueHreflangInvalid", scope: "page", evaluate: facts => (facts.hreflangInvalid?.length ?? 0) > 0 },
  { id: "hreflang_no_return", severity: "warning", category: "metadata", titleKey: "auditIssueHreflangNoReturn", scope: "site", evaluate: facts => (facts.hreflangNoReturn?.length ?? 0) > 0 },
  { id: "hreflang_self_missing", severity: "info", category: "metadata", titleKey: "auditIssueHreflangSelfMissing", scope: "page", affectsScore: false, evaluate: facts => facts.hreflangSelfMissing === true },
  { id: "hreflang_target_bad", severity: "warning", category: "metadata", titleKey: "auditIssueHreflangTargetBad", scope: "page", evaluate: facts => (facts.hreflangTargetBad?.length ?? 0) > 0 },
  { id: "hreflang_x_default_missing", severity: "info", category: "metadata", titleKey: "auditIssueHreflangXDefaultMissing", scope: "site", affectsScore: false, evaluate: facts => facts.hreflangXDefaultMissing === true },
  // Only the primary subtag is compared (fr vs fr-CA is fine; fr vs en is the real mistake).
  { id: "lang_hreflang_mismatch", severity: "info", category: "content", titleKey: "auditIssueLangHreflangMismatch", scope: "page", affectsScore: false, evaluate: facts => !!facts.langHreflangMismatch },
  // ─── rendering & performance heuristics (T5) ─────────────────────────────────────
  { id: "viewport_not_responsive", severity: "warning", category: "rendering", titleKey: "auditIssueViewportNotResponsive", scope: "page", evaluate: facts => html(facts) && facts.viewportPresent && facts.viewportResponsive === false },
  { id: "images_no_dimensions", severity: "info", category: "performance", titleKey: "auditIssueImagesNoDimensions", scope: "page", affectsScore: false, evaluate: facts => html(facts) && (facts.imagesNoDimensions ?? 0) > 0 },
  { id: "internal_redirect_links", severity: "warning", category: "links", titleKey: "auditIssueInternalRedirectLinks", scope: "page", evaluate: facts => html(facts) && (facts.internalRedirectLinks?.length ?? 0) > 0 },
  { id: "html_too_large", severity: "info", category: "performance", titleKey: "auditIssueHtmlTooLarge", scope: "page", affectsScore: false, evaluate: facts => (facts.htmlBytes ?? 0) > 2 * 1024 * 1024 },
  // ─── query alignment & Core Web Vitals (T5) — hints, never score-changing ────────
  // Heuristics on top of real data: they point somewhere, they do not lower the health score.
  { id: "title_query_mismatch", severity: "info", category: "content", titleKey: "auditIssueTitleQueryMismatch", scope: "page", affectsScore: false, evaluate: facts => html(facts) && facts.mainQuery != null && !pageMatchesQuery(facts.title, facts.h1Text ?? "", facts.mainQuery.query) },
  { id: "cwv_poor", severity: "warning", category: "performance", titleKey: "auditIssueCwvPoor", scope: "page", affectsScore: false, evaluate: facts => !!facts.cwvPoor },
] as const;

export const AUDIT_RULE_IDS = AUDIT_RULES.map(rule => rule.id);
export const AUDIT_RULE_BY_ID = new Map(AUDIT_RULES.map(rule => [rule.id, rule]));
export const AUDIT_ACTIONABLE_RULE_IDS = new Set(AUDIT_RULES.filter(rule => rule.severity !== "info").map(rule => rule.id));
export const AUDIT_SCORING_RULE_IDS = new Set(AUDIT_RULES.filter(rule => rule.severity !== "info" && rule.affectsScore !== false).map(rule => rule.id));

export function evaluateAuditPageRules(facts: AuditPageFacts): string[] {
  return AUDIT_RULES.filter(rule => rule.evaluate(facts)).map(rule => rule.id);
}
