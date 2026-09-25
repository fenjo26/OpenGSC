// N9 — shared types for the public audit widget, lead storage and proposals.
// Pure types only: nothing here imports Prisma or Next, so every module (and every test)
// can use them freely.

export type LeadLang = "en" | "ru" | "uk" | "fr" | "es" | "de" | "zh";

export const LEAD_LANGS: LeadLang[] = ["en", "ru", "uk", "fr", "es", "de", "zh"];

export function normalizeLeadLang(value: unknown): LeadLang {
  return LEAD_LANGS.includes(value as LeadLang) ? (value as LeadLang) : "en";
}

export type FindingSeverity = "critical" | "warning" | "info";

export type FindingCategory =
  | "crawlability"
  | "metadata"
  | "content"
  | "links"
  | "performance"
  | "rendering"
  | "security";

/** Everything the lite audit can report. Persisted inside Lead.findings and in the cache. */
export type FindingCode =
  | "https_unavailable"
  | "http_error"
  | "fetch_failed"
  | "redirect"
  | "redirect_chain"
  | "title_missing"
  | "title_too_long"
  | "title_too_short"
  | "description_missing"
  | "description_too_long"
  | "description_too_short"
  | "h1_missing"
  | "h1_multiple"
  | "noindex"
  | "canonical_missing"
  | "viewport_missing"
  | "viewport_not_responsive"
  | "lang_missing"
  | "jsonld_invalid"
  | "open_graph_incomplete"
  | "security_headers_missing"
  | "slow_response"
  | "broken_links"
  | "mixed_content"
  | "thin_content"
  | "images_no_alt";

export const FINDING_CATEGORIES: FindingCategory[] = [
  "crawlability", "metadata", "content", "links", "performance", "rendering", "security",
];

/**
 * A finding BEFORE localization — what the 15-minute cache stores. Evidence is deliberately
 * language-neutral (numbers, limits, paths) so one cached audit can be answered in any widget
 * language, and the localized strings can never leak between visitors.
 */
export interface RawFinding {
  code: FindingCode;
  severity: FindingSeverity;
  category: FindingCategory;
  /** Concrete numbers/paths, e.g. "72 > 65 · /about" — built by the audit, not translated. */
  evidence: string;
  /** Page paths (not full URLs) where the finding fired; [] = site-wide. */
  pages: string[];
}

/** The localized finding stored on a Lead and shown to the operator / e-mailed to the visitor. */
export interface LeadFinding extends RawFinding {
  /** Human title, in the widget's language. */
  title: string;
  /** How to fix, in the widget's language. Never sent to the public widget top list. */
  fix: string;
}

/** The lite audit result — raw (unlocalized) so the cache stays language-independent. */
export interface LiteAuditReport {
  domain: string;
  /** Where the homepage finally answered (after redirects). */
  finalUrl: string;
  https: boolean;
  /** 0..100. */
  score: number;
  findings: RawFinding[];
  pagesChecked: number;
  checkedAt: string;
}

/** What the PUBLIC widget receives per finding: no `fix` — that is the full report's job. */
export interface PublicFinding {
  code: string;
  severity: FindingSeverity;
  title: string;
  evidence: string;
}

export const LEAD_STATUSES = ["new", "contacted", "won", "lost", "client"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * User.widgetSettings JSON (N9). All fields optional in storage; parseWidgetSettings fills
 * defaults. No secrets here — the whole object drives a public page.
 */
export interface WidgetSettings {
  enabled: boolean;
  /** Empty = any origin (the settings card warns about this). */
  allowedOrigins: string[];
  accentColor: string;
  logoUrl: string;
  /** Empty = the standard per-language consent text. */
  consentText: string;
  /** Extra address that also receives the "new lead" notification (needs SMTP). */
  notifyEmail: string;
  /** First-letter template for the "Write" button; "" = deterministic default. */
  emailTemplate: string;
  /** "About the company" block for proposals. */
  aboutCompany: string;
}

/** A lead row as the dashboard and MCP see it. */
export interface LeadListItem {
  id: string;
  domain: string;
  email: string;
  name: string;
  message: string;
  score: number;
  /** Localized titles of the 3 most severe findings. */
  top: string[];
  source: string;
  /** Page the widget was embedded on (Origin header). */
  origin: string;
  status: LeadStatus;
  createdAt: string;
  proposal: string | null;
}

export interface LeadFull extends LeadListItem {
  findings: LeadFinding[];
}

/** Settings the PUBLIC embeddable page may see. Nothing here is a secret. */
export interface PublicWidgetConfig {
  enabled: boolean;
  accentColor: string;
  logoUrl: string;
  /** Custom consent text; "" → the widget renders the standard per-language text. */
  consentText: string;
  captcha: { enabled: boolean; siteKey: string };
}
