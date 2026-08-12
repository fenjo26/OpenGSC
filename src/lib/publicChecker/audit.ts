import "server-only";
import tls from "node:tls";
import { assertSafeTarget, safeFetch, SafeFetchError } from "@/lib/security/safeFetch";
import { extractAuditHtml, missingSecurityHeaders, robotsDirectivesConflict } from "@/lib/audit/pageSignals";
import { AUDIT_RULE_BY_ID, evaluateAuditPageRules, type AuditPageFacts, type AuditRuleCategory, type AuditRuleSeverity } from "@/lib/audit/rules";

const UA = "Mozilla/5.0 (compatible; OpenGSC-Public-Checker/1.0; +https://opengsc.org)";
const MAX_HTML_BYTES = 1_250_000;

const PUBLIC_RULE_IDS = new Set([
  "http_error", "title_missing", "title_too_long", "description_missing", "description_too_long",
  "h1_missing", "h1_multiple", "noindex", "robots_conflict", "canonical_missing",
  "canonical_invalid", "canonical_mismatch", "thin_content", "images_no_alt", "slow_response",
  "viewport_missing", "lang_missing", "jsonld_invalid", "organization_schema_incomplete",
  "open_graph_incomplete", "twitter_card_incomplete", "mixed_content", "security_headers_missing",
]);

export interface PublicFinding {
  id: string;
  severity: AuditRuleSeverity;
  category: AuditRuleCategory;
  titleKey: string;
  evidence?: string;
}

export interface PublicCheckResult {
  requestedUrl: string;
  finalUrl: string;
  checkedAt: string;
  score: number;
  passed: number;
  available: number;
  findings: PublicFinding[];
  facts: {
    status: number;
    contentType: string;
    loadMs: number;
    bytes: number;
    redirected: boolean;
    https: boolean;
    certificateDaysRemaining: number | null;
    title: string;
    titleLength: number;
    descriptionLength: number;
    h1Count: number;
    canonical: boolean;
    indexable: boolean | null;
    schemaBlocks: number;
    openGraphMissing: number;
    imagesNoAlt: number;
    wordCount: number;
    missingSecurityHeaders: string[];
    webVitals: "unavailable";
  };
}

export function normalizePublicTarget(input: string): URL {
  const value = String(input ?? "").trim();
  if (!value || value.length > 500) throw new Error("invalid_url");
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`); }
  catch { throw new Error("invalid_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported_protocol");
  if (url.username || url.password) throw new Error("credentials_not_allowed");
  // This is a domain/homepage checker, not an arbitrary URL fetcher. Removing path/query also
  // keeps cache keys stable and prevents user-specific report data from entering memory.
  url.protocol = "https:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function certificateDays(url: URL): Promise<number | null> {
  // allowPrivate is pinned to false on every public-surface call: this route is reachable without
  // a session, so it must never inherit the instance's OPENGSC_ALLOW_PRIVATE_TARGETS setting.
  const safe = await assertSafeTarget(url, { allowPrivate: false });
  const address = safe.addresses[0];
  if (!address) return null;
  return new Promise(resolve => {
    let settled = false;
    const socket = tls.connect({
      host: address.address,
      port: Number(url.port || 443),
      servername: url.hostname,
      rejectUnauthorized: true,
      timeout: 7_000,
    });
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const expires = Date.parse(cert.valid_to || "");
      done(Number.isFinite(expires) ? Math.floor((expires - Date.now()) / 86_400_000) : null);
    });
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
  });
}

function canonicalState(canonical: string | null, finalUrl: URL) {
  if (!canonical?.trim()) return { invalid: false, mismatch: false };
  try {
    const resolved = new URL(canonical, finalUrl);
    const final = new URL(finalUrl);
    resolved.hash = ""; final.hash = "";
    return { invalid: !["http:", "https:"].includes(resolved.protocol), mismatch: resolved.href !== final.href };
  } catch { return { invalid: true, mismatch: false }; }
}

function evidenceFor(id: string, facts: AuditPageFacts, signals: ReturnType<typeof extractAuditHtml> | null, security: string[]): string | undefined {
  switch (id) {
    case "http_error": return `HTTP ${facts.httpStatus}`;
    case "title_too_long": return `${facts.title.length}`;
    case "description_too_long": return `${facts.metaDescription.length}`;
    case "h1_missing": case "h1_multiple": return `${facts.h1Count}`;
    case "thin_content": return `${facts.wordCount}`;
    case "images_no_alt": return `${facts.imagesNoAlt}`;
    case "slow_response": return `${facts.loadMs} ms`;
    case "jsonld_invalid": return `${facts.jsonLdInvalid}`;
    case "open_graph_incomplete": return `${signals?.openGraphMissing.length ?? 0}`;
    case "mixed_content": return `${facts.mixedContentCount}`;
    case "security_headers_missing": return security.join(", ");
    default: return undefined;
  }
}

function finding(id: string, evidence?: string): PublicFinding | null {
  const rule = AUDIT_RULE_BY_ID.get(id);
  return rule ? { id, severity: rule.severity, category: rule.category, titleKey: rule.titleKey, evidence } : null;
}

export async function runPublicCheck(input: string): Promise<PublicCheckResult> {
  const requested = normalizePublicTarget(input);
  let response;
  let https = true;
  let httpsFailure: string | null = null;
  try {
    response = await safeFetch(requested, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow", timeoutMs: 15_000, maxRedirects: 5, maxBytes: MAX_HTML_BYTES, allowPrivate: false,
    });
  } catch (error) {
    httpsFailure = error instanceof SafeFetchError ? error.code : "network_error";
    const fallback = new URL(requested); fallback.protocol = "http:";
    try {
      response = await safeFetch(fallback, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        redirect: "follow", timeoutMs: 15_000, maxRedirects: 5, maxBytes: MAX_HTML_BYTES, allowPrivate: false,
      });
      https = response.url.startsWith("https:");
    } catch {
      throw new Error(httpsFailure);
    }
  }

  const finalUrl = new URL(response.url);
  https = https && finalUrl.protocol === "https:";
  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = response.ok && (contentType.includes("html") || !contentType);
  const html = isHtml ? await response.text() : "";
  const signals = html ? extractAuditHtml(html) : null;
  const headers = Object.fromEntries([
    "content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options",
    "referrer-policy", "x-robots-tag",
  ].map(name => [name, response.headers.get(name) ?? ""]));
  const security = missingSecurityHeaders(headers, https);
  const robots = [signals?.robots ?? "", headers["x-robots-tag"]].filter(Boolean).join(", ").toLowerCase();
  const canonical = canonicalState(signals?.canonical ?? null, finalUrl);
  const certDays = https ? await certificateDays(finalUrl).catch(() => null) : null;

  const facts: AuditPageFacts = {
    hasHtml: !!signals, isRoot: true, isHttps: https, httpStatus: response.status,
    loadMs: 0, redirectHops: response.redirected ? 1 : 0, redirectLoop: false,
    title: signals?.title ?? "", titleDuplicate: false, metaDescription: signals?.metaDesc ?? "",
    robots, robotsConflict: robotsDirectivesConflict(robots), canonical: signals?.canonical?.trim() || null,
    canonicalInvalid: canonical.invalid, canonicalMismatch: canonical.mismatch,
    h1Count: signals?.h1Count ?? 0, wordCount: signals?.wordCount ?? 0,
    imagesNoAlt: signals?.imagesNoAlt ?? 0, brokenLinkCount: 0, jsRendered: false,
    viewportPresent: signals?.viewportPresent ?? false, htmlLang: signals?.htmlLang ?? "",
    jsonLdInvalid: signals?.jsonLdInvalid ?? 0, organizationSchemaIncomplete: signals?.organizationSchemaIncomplete ?? false,
    openGraphMissing: signals?.openGraphMissing.length ?? 0, twitterCardIncomplete: signals?.twitterCardIncomplete ?? false,
    mixedContentCount: signals?.mixedContentUrls.length ?? 0, missingSecurityHeaders: security.length,
    sitemapSeeded: false, internalInboundLinks: 0,
  };

  // The pinned fetch exposes total duration only at the caller, so measure a cheap HEAD against
  // the already-validated final URL. If it fails, latency is unavailable rather than a finding.
  const latencyStart = Date.now();
  try { await safeFetch(finalUrl, { method: "HEAD", redirect: "follow", timeoutMs: 8_000, maxBytes: 1, allowPrivate: false }); facts.loadMs = Date.now() - latencyStart; }
  catch { facts.loadMs = 0; }

  const ids = evaluateAuditPageRules(facts).filter(id => PUBLIC_RULE_IDS.has(id));
  const findings: PublicFinding[] = ids.map(id => finding(id, evidenceFor(id, facts, signals, security))).filter((item): item is PublicFinding => !!item);
  if (!https) findings.unshift({ id: "https_unavailable", severity: "critical", category: "security", titleKey: "publicCheckHttpsUnavailable", evidence: httpsFailure ?? undefined });
  if (https && certDays != null && certDays < 30) findings.push({ id: "certificate_expiring", severity: certDays < 7 ? "critical" : "warning", category: "security", titleKey: "publicCheckCertificateExpiring", evidence: `${certDays}` });
  if (signals && signals.jsonLdCount === 0) findings.push({ id: "structured_data_missing", severity: "info", category: "metadata", titleKey: "publicCheckSchemaMissing" });

  const htmlRuleCount = [...PUBLIC_RULE_IDS].filter(id => !["http_error", "slow_response", "security_headers_missing"].includes(id)).length;
  const available = 3 + (signals ? htmlRuleCount : 0); // HTTPS, HTTP response, security + HTML rules
  const failedIds = new Set(findings.map(item => item.id));
  const failed = findings.filter(item => item.severity !== "info").length;
  const passed = Math.max(0, available - failed);
  const severityOrder: Record<AuditRuleSeverity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    requestedUrl: requested.href, finalUrl: finalUrl.href, checkedAt: new Date().toISOString(),
    score: available ? Math.round((passed / available) * 100) : 0, passed, available,
    findings,
    facts: {
      status: response.status, contentType: contentType.split(";")[0], loadMs: facts.loadMs,
      bytes: response.byteLength, redirected: response.redirected, https,
      certificateDaysRemaining: certDays, title: signals?.title.slice(0, 180) ?? "",
      titleLength: signals?.title.length ?? 0, descriptionLength: signals?.metaDesc.length ?? 0,
      h1Count: signals?.h1Count ?? 0, canonical: !!signals?.canonical,
      indexable: signals ? !failedIds.has("noindex") : null, schemaBlocks: signals?.jsonLdCount ?? 0,
      openGraphMissing: signals?.openGraphMissing.length ?? 0, imagesNoAlt: signals?.imagesNoAlt ?? 0,
      wordCount: signals?.wordCount ?? 0, missingSecurityHeaders: security, webVitals: "unavailable",
    },
  };
}
