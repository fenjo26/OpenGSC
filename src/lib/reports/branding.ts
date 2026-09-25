// N8 — white-label branding of the workspace's client reports (User.reportBranding,
// JSON). Pure module: parse/validate only, no Prisma — the limits are unit-tested here so
// both the Settings card and the renderer refuse the same values.

export interface ReportBranding {
  companyName: string;
  /** data:image/png|svg+xml|jpeg|jpg;base64,... — ≤ 200 KiB. Inlined into every snapshot. */
  logoDataUrl: string;
  /** Hex colour for headings/accents, e.g. "#2563eb". Anything valid in CSS. */
  accentColor: string;
  footer: string;
  website: string;
  /** White-label default OFF: no "Made with OpenGSC" unless the operator opts in. */
  showPoweredBy: boolean;
}

export const DEFAULT_BRANDING: ReportBranding = {
  companyName: "",
  logoDataUrl: "",
  accentColor: "#2563eb",
  footer: "",
  website: "",
  showPoweredBy: false,
};

/** 200 KiB of decoded image bytes (the brief's ceiling) — what the logo file itself weighs. */
export const LOGO_MAX_BYTES = 200 * 1024;

// Strict base64 payload (no whitespace — FileReader never emits any, and a charset that
// tolerates padding characters would let a "200 KiB" logo grow without decoding to more).
const LOGO_RE = /^data:image\/(png|svg\+xml|jpe?g);base64,([A-Za-z0-9+/=]+)$/;
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export type BrandingIssue = "logo_too_large" | "logo_bad_format" | "color_bad_format" | "website_bad_format" | "footer_too_long" | "company_too_long";

function cleanUrl(raw: unknown): { value: string; issue?: BrandingIssue } {
  const s = String(raw ?? "").trim();
  if (!s) return { value: "" };
  if (s.length > 200) return { value: "", issue: "website_bad_format" };
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { value: "", issue: "website_bad_format" };
    return { value: u.href };
  } catch {
    return { value: "", issue: "website_bad_format" };
  }
}

/**
 * Validate raw JSON (from the API body or the User column) into branding. Unknown keys are
 * dropped; every invalid value is reported so the card can name it — nothing is silently
 * coerced to a default the operator did not choose.
 */
export function parseBranding(raw: unknown): { branding: ReportBranding; issues: BrandingIssue[] } {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const issues: BrandingIssue[] = [];

  const companyName = String(src.companyName ?? "").slice(0, 120);
  if (companyName.length >= 120) issues.push("company_too_long");

  let logoDataUrl = String(src.logoDataUrl ?? "").trim();
  if (logoDataUrl) {
    const m = LOGO_RE.exec(logoDataUrl);
    if (!m) {
      issues.push("logo_bad_format");
      logoDataUrl = "";
    } else {
      // The limit is on the decoded image, so it matches the file-size check the card does
      // client-side: a 200 KiB PNG stays legal even though its base64 is ~267 KiB of text.
      const b64 = m[2];
      const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
      const decodedBytes = Math.floor(b64.length * 3 / 4) - pad;
      if (decodedBytes > LOGO_MAX_BYTES) {
        issues.push("logo_too_large");
        logoDataUrl = "";
      }
    }
  }

  let accentColor = String(src.accentColor ?? "").trim();
  if (accentColor && !HEX_COLOR.test(accentColor)) {
    issues.push("color_bad_format");
    accentColor = DEFAULT_BRANDING.accentColor;
  }

  let footer = String(src.footer ?? "");
  if (footer.length > 300) {
    issues.push("footer_too_long");
    footer = footer.slice(0, 300);
  }

  const site = cleanUrl(src.website);
  if (site.issue) issues.push(site.issue);

  return {
    branding: {
      companyName,
      logoDataUrl,
      accentColor: accentColor || DEFAULT_BRANDING.accentColor,
      footer,
      website: site.value,
      showPoweredBy: src.showPoweredBy === true,
    },
    issues,
  };
}
