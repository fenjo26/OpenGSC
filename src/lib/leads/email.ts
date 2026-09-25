// N9 — the full-report e-mail a widget visitor receives after leaving their address.
//
// It goes through the OWNER's SMTP configuration (Settings → Notifications, wave-oct T3),
// but to the VISITOR's address — sendEmail() in notify/channels only delivers to the
// owner's own recipient list, so this module builds its own transport from the same
// config. Anti-spam posture (docs/LEADS.md):
//   • a report e-mail requires a one-time audit token (see ./cache.ts) — no token, no mail;
//   • the lead form is rate-limited per IP on top of that;
//   • the SMTP host is checked against the SSRF guard exactly like notify's own sender.
//
// If SMTP is not configured nothing is sent and the widget says "we will contact you".

import "server-only";
import nodemailer from "nodemailer";
import { assertSafeTarget, SafeFetchError } from "@/lib/security/safeFetch";
import { readChannels } from "@/lib/notify/channels";
import { LEAD_STRINGS } from "./i18n";
import type { LeadFinding, LeadLang } from "./types";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

async function ownerSmtp(userId: string): Promise<SmtpConfig | null> {
  const cfg = await readChannels(userId);
  const email = cfg.email;
  if (!email?.on || !email.host || !email.from) return null;
  return { host: email.host, port: email.port, secure: email.secure, user: email.user, pass: email.pass, from: email.from };
}

export async function smtpConfigured(userId: string): Promise<boolean> {
  return (await ownerSmtp(userId)) != null;
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

async function sendViaSmtp(
  cfg: SmtpConfig,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  // The SMTP host must not become a port scanner of the internal network either — the same
  // check notify's own sendEmail() runs (import-only reuse of the guard, not the sender).
  try {
    await assertSafeTarget(`https://${cfg.host}`, { allowPrivate: false });
  } catch (error) {
    return { ok: false, error: error instanceof SafeFetchError && error.code === "private_address" ? "private_address" : "smtp_connect" };
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({ from: cfg.from, to, subject, text, html });
    return { ok: true };
  } catch (error) {
    const err = error as { code?: string };
    return { ok: false, error: err?.code ? `smtp_${err.code}`.slice(0, 60) : "smtp_error" };
  } finally {
    transport.close();
  }
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
    const cfg = await ownerSmtp(input.userId);
    if (!cfg) return { ok: false, error: "not_configured" };
    const L = LEAD_STRINGS[input.lang].email;
    const { text, html } = reportBody(input.domain, input.score, input.findings, input.lang);
    return await sendViaSmtp(cfg, input.to, L.subject(input.domain, input.score), text, html);
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
    const cfg = await ownerSmtp(input.userId);
    if (!cfg) return { ok: false, error: "not_configured" };
    const L = LEAD_STRINGS[input.lang].email;
    const subject = `📥 ${input.domain}`;
    const text = [
      `${input.domain} · ${input.email}`,
      `${input.score}/100`,
      input.top.join(", "),
    ].join("\n");
    const html = `<p><strong>${escapeHtml(input.domain)}</strong> · ${escapeHtml(input.email)}</p><p>${input.score}/100</p><p>${input.top.map(escapeHtml).join(", ")}</p><p style="color:#6b7280;font-size:12px">${escapeHtml(L.footer)}</p>`;
    return await sendViaSmtp(cfg, input.to, subject, text, html);
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 80) };
  }
}
