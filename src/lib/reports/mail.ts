// N8 — the client e-mail of a report run.
//
// sendEmail() in src/lib/notify/channels.ts (N10's file — not modifiable from this task)
// sends a title+markdown notification to the channel's OWN configured `to` list and has no
// attachments and no per-call override. A client report needs neither of the first two
// things it lacks — it goes to the report's own recipients — so this module builds a
// transport from the SAME stored SMTP config (readChannels), with the same SSRF guard
// (assertSafeTarget, so the SMTP host cannot become a port scanner of the internal
// network) and the same error codes. What it deliberately does NOT do is attach the PDF:
// the e-mail carries the client link instead; the channels.ts change that would allow
// attachments is described in the N8 report for R.

import nodemailer from "nodemailer";
import { SafeFetchError, assertSafeTarget } from "@/lib/security/safeFetch";
import { readChannels } from "@/lib/notify/channels";
import type { NotifyChannelsConfig } from "@/lib/notify/types";

export interface ReportEmail {
  to: string[];
  subject: string;
  text: string;
  /** Branded light HTML body (the report snapshot itself stays a link/download, not the mail). */
  html: string;
}

export type ReportMailResult = { ok: true } | { ok: false; error: string };

const smtpError = (e: unknown): string => {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const code = String(err?.code ?? "");
  if (code === "EAUTH" || err?.responseCode === 535) return "smtp_auth";
  if (["ETIMEDOUT", "ECONNECTION", "ECONNREFUSED", "EDNS", "ESOCKET", "EPROTOCOL", "EENVELOPE", "EADDRESS"].includes(code)) return "smtp_connect";
  return `smtp_error ${String(err?.message ?? e).slice(0, 150)}`.trim();
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function isSmtpConfigured(userId: string): Promise<boolean> {
  const cfg = await readChannels(userId).catch(() => ({}) as NotifyChannelsConfig);
  return Boolean(cfg.email?.host);
}

export async function sendReportEmail(userId: string, mail: ReportEmail): Promise<ReportMailResult> {
  const cfg = await readChannels(userId).catch(() => ({}) as NotifyChannelsConfig);
  const email = cfg.email;
  if (!email?.host) return { ok: false, error: "smtp_not_configured" };
  if (!mail.to.length) return { ok: false, error: "no_recipients" };
  try {
    await assertSafeTarget(`https://${email.host}`);
  } catch (e) {
    if (e instanceof SafeFetchError && e.code === "private_address") return { ok: false, error: "private_address" };
    return { ok: false, error: "smtp_connect" };
  }

  const transport = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.secure,
    ...(email.user && email.pass ? { auth: { user: email.user, pass: email.pass } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const send = () => transport.sendMail({
    from: email.from,
    to: mail.to.slice(0, 20).join(", "),
    subject: mail.subject.slice(0, 200),
    text: mail.text,
    html: mail.html,
  });
  try {
    try {
      await send();
    } catch (e) {
      if (smtpError(e) === "smtp_auth") throw e; // wrong password will not fix itself — no retry
      await sleep(2_000);
      await send(); // one retry on network errors, like sendEmail
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: smtpError(e) };
  } finally {
    transport.close();
  }
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
