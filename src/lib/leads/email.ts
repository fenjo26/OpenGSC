// N9 — the full-report e-mail a widget visitor receives after leaving their address.
//
// It goes through the OWNER's SMTP configuration (Settings → Notifications, wave-oct T3),
// but to the VISITOR's address — sendEmail() in notify/channels (extended by wave-nov R with
// envelope options) delivers it: same transport, same SSRF guard on the host, same retry and
// error codes. Anti-spam posture (docs/LEADS.md):
//   • a report e-mail requires a one-time audit token (see ./cache.ts) — no token, no mail;
//   • the lead form is rate-limited per IP on top of that;
//   • the channel must be switched ON — a lead never sends through a channel the owner
//     disabled (unlike notify's own "test send", which deliberately ignores the switch).
//
// If SMTP is not configured nothing is sent and the widget says "we will contact you".

import "server-only";
import { readChannels, sendEmail } from "@/lib/notify/channels";
import type { NotifyChannelsConfig } from "@/lib/notify/types";
import { LEAD_STRINGS } from "./i18n";
import type { LeadFinding, LeadLang } from "./types";

/** The owner's stored e-mail channel, or null when off/unconfigured. */
async function ownerEmailChannel(userId: string): Promise<NonNullable<NotifyChannelsConfig["email"]> | null> {
  const cfg = await readChannels(userId).catch(() => ({}) as NotifyChannelsConfig);
  const email = cfg.email;
  return email?.on && email.host && email.from ? email : null;
}

export async function smtpConfigured(userId: string): Promise<boolean> {
  return (await ownerEmailChannel(userId)) != null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function reportBody(domain: string, score: number, findings: LeadFinding[], lang: LeadLang): { text: string; html: string } {
  const L = LEAD_STRINGS[lang].email;
  const lines = [L.header(domain, score), "", L.intro, ""];
  const htmlParts = [`<h2>${escapeHtml(L.header(domain, score))}</h2><p>${escapeHtml(L.intro)}</p>`];
  findings.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.title}${f.evidence ? ` — ${f.evidence}` : ""}`);
    lines.push(`   → ${f.fix}`);
    lines.push("");
    htmlParts.push(
      `<p><strong>${escapeHtml(f.title)}</strong>${f.evidence ? ` <span style="color:#6b7280">(${escapeHtml(f.evidence)})</span>` : ""}</p>` +
      `<p style="margin-top:2px">→ ${escapeHtml(f.fix)}</p>`,
    );
  });
  lines.push("—", L.footer);
  htmlParts.push(`<p style="color:#6b7280;font-size:12px;margin-top:28px">${escapeHtml(L.footer)}</p>`);
  return { text: lines.join("\n"), html: htmlParts.join("") };
}

/** Send the full audit report to the visitor. Returns ok:false when SMTP is off — never throws. */
export async function sendFullReportEmail(input: {
  userId: string;
  to: string;
  domain: string;
  score: number;
  findings: LeadFinding[];
  lang: LeadLang;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const email = await ownerEmailChannel(input.userId);
    if (!email) return { ok: false, error: "not_configured" };
    const L = LEAD_STRINGS[input.lang].email;
    const { text, html } = reportBody(input.domain, input.score, input.findings, input.lang);
    return await sendEmail(email, L.subject(input.domain, input.score), text, { to: [input.to], html });
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 80) };
  }
}

/** Best-effort copy of the "new lead" notice to the extra address from the widget settings. */
export async function sendLeadNotificationCopy(input: {
  userId: string;
  to: string;
  domain: string;
  email: string;
  score: number;
  top: string[];
  lang: LeadLang;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const email = await ownerEmailChannel(input.userId);
    if (!email) return { ok: false, error: "not_configured" };
    const L = LEAD_STRINGS[input.lang].email;
    const subject = `📥 ${input.domain}`;
    const text = [
      `${input.domain} · ${input.email}`,
      `${input.score}/100`,
      input.top.join(", "),
    ].join("\n");
    const html = `<p><strong>${escapeHtml(input.domain)}</strong> · ${escapeHtml(input.email)}</p><p>${input.score}/100</p><p>${input.top.map(escapeHtml).join(", ")}</p><p style="color:#6b7280;font-size:12px">${escapeHtml(L.footer)}</p>`;
    return await sendEmail(email, subject, text, { to: [input.to], html });
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 80) };
  }
}
