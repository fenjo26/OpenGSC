export const OUTREACH_STAGES = [
  "discovered", "qualified", "ready", "contacted", "replied", "negotiating", "won", "lost",
] as const;

export type OutreachStage = typeof OUTREACH_STAGES[number];

export const OUTREACH_STAGE_SET = new Set<string>(OUTREACH_STAGES);

export function normalizeProspectDomain(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  }
}

export function isHttpUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

export function outreachErrorKey(value: unknown): string {
  const code = String(value ?? "");
  if (code === "campaign_name_exists") return "outreachErrorCampaignExists";
  if (code === "campaign_name_required") return "outreachErrorCampaignRequired";
  if (code === "prospect_domain_required") return "outreachErrorDomainRequired";
  if (["invalid_source_url", "invalid_contact_url", "invalid_backlink_url"].includes(code)) return "outreachErrorInvalidUrl";
  if (code === "invalid_contact_email") return "outreachErrorInvalidEmail";
  if (code.endsWith("_not_found")) return "outreachErrorNotFound";
  return "outreachErrorGeneric";
}
