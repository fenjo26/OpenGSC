// N8 — the client e-mail of a report run.
//
// It rides sendEmail() from src/lib/notify/channels.ts (extended by wave-nov R with envelope
// options): the SAME stored SMTP config, the same SSRF guard (assertSafeTarget, so the SMTP
// host cannot become a port scanner of the internal network), the same retry/error codes —
// only the envelope is ours: the report's own recipients, subject and branded HTML body.

import { readChannels, sendEmail } from "@/lib/notify/channels";
import type { NotifyChannelsConfig } from "@/lib/notify/types";

export interface ReportEmail {
  to: string[];
  subject: string;
  text: string;
  /** Branded light HTML body (the report snapshot itself stays a link/download, not the mail). */
  html: string;
}

export type ReportMailResult = { ok: true } | { ok: false; error: string };

export async function isSmtpConfigured(userId: string): Promise<boolean> {
  const cfg = await readChannels(userId).catch(() => ({}) as NotifyChannelsConfig);
  return Boolean(cfg.email?.host);
}

export async function sendReportEmail(userId: string, mail: ReportEmail): Promise<ReportMailResult> {
  const cfg = await readChannels(userId).catch(() => ({}) as NotifyChannelsConfig);
  const email = cfg.email;
  if (!email?.host) return { ok: false, error: "smtp_not_configured" };
  if (!mail.to.length) return { ok: false, error: "no_recipients" };
  const res = await sendEmail(email, mail.subject.slice(0, 200), mail.text, {
    to: mail.to,
    html: mail.html,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? "smtp_error" };
}

// ─── the body ─────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ReportEmailContent {
  title: string;
  siteDomain: string;
  periodFrom: string; // YYYY-MM-DD
  periodTo: string;
  clientUrl: string | null; // /share/report/<token> when the link is on
  branding: { companyName: string; accentColor: string; footer: string };
}

/** The e-mail the client receives. Deterministic, scriptless, no external images. */
export function buildReportEmail(c: ReportEmailContent, summaryLines: string[]): ReportEmail {
  const accent = c.branding.accentColor || "#2563eb";
  const link = c.clientUrl
    ? `<p style="margin:22px 0 26px"><a href="${esc(c.clientUrl)}" style="display:inline-block;background:${esc(accent)};color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:8px">Open the report</a></p>`
    : "";
  const summary = summaryLines.length
    ? `<ul style="color:#3c4046;padding-left:20px;margin:10px 0">${summaryLines.map(l => `<li style="margin:4px 0">${esc(l)}</li>`).join("")}</ul>`
    : "";
  const text = [
    `${c.title} — ${c.siteDomain}`,
    `Period: ${c.periodFrom} — ${c.periodTo}`,
    "",
    ...summaryLines,
    c.clientUrl ? `\nOpen the report: ${c.clientUrl}` : "",
    c.branding.footer ? `\n${c.branding.footer}` : "",
  ].filter(s => s !== "").join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#f2f4f7;font:14px/1.55 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2328">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;padding:28px 30px">
  <tr><td style="border-bottom:3px solid ${esc(accent)};padding-bottom:14px">
    <div style="font-size:19px;font-weight:700">${esc(c.title)}</div>
    <div style="color:#6a7079;font-size:13px;margin-top:3px">${esc(c.siteDomain)} · ${esc(c.periodFrom)} — ${esc(c.periodTo)}</div>
  </td></tr>
  <tr><td style="padding-top:16px">
    ${summary}
    ${link}
  </td></tr>
  <tr><td style="border-top:1px solid #e6e8eb;padding-top:12px;color:#6a7079;font-size:12px">
    ${c.branding.footer ? `${esc(c.branding.footer)}<br/>` : ""}${c.branding.companyName ? esc(c.branding.companyName) : ""}
  </td></tr>
</table>
</td></tr></table></body></html>`;

  return { to: [], subject: `${c.title} — ${c.periodFrom} — ${c.periodTo}`, text, html };
}
