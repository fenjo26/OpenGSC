// N9 — PUBLIC lead intake. No session; the guards are the same bargain as /api/public/audit:
// key → origin allow-list → one-time audit token → per-IP lead quota → validation.
//
// A Lead is only ever created from a consumed audit token, so the stored findings, the
// score and the e-mailed report always correspond to a real crawl — and the SMTP relay
// cannot be driven by posting the form directly.

import { NextResponse } from "next/server";
import { auditCache } from "@/lib/leads/cache";
import { sendFullReportEmail, sendLeadNotificationCopy } from "@/lib/leads/email";
import { localizeFindings } from "@/lib/leads/i18n";
import { topFindings } from "@/lib/leads/liteAudit";
import { checkOrigin } from "@/lib/leads/originGuard";
import { hashIp, ipSalt, takeLeadQuota, WindowCounter } from "@/lib/leads/ratelimit";
import { findUserByWidgetKey } from "@/lib/leads/settings";
import { createLead, LeadStoreError } from "@/lib/leads/store";
import { normalizeLeadLang } from "@/lib/leads/types";

export const dynamic = "force-dynamic";

const counter = new WindowCounter();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "";
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const widget = await findUserByWidgetKey(String(body.key ?? ""));
    if (!widget || !widget.settings.enabled) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    if (!checkOrigin(origin, referer, widget.settings.allowedOrigins)) {
      return NextResponse.json({ error: "origin" }, { status: 403 });
    }

    // One-time token from a completed audit — consumed even if validation below fails.
    const audit = auditCache.consumeToken(String(body.token ?? ""));
    if (!audit) return NextResponse.json({ error: "token" }, { status: 400 });

    const email = String(body.email ?? "").trim().slice(0, 200);
    if (!EMAIL_RE.test(email) || body.consent !== true) {
      return NextResponse.json({ error: "validation" }, { status: 400 });
    }

    const ipHash = hashIp(clientIp(req), ipSalt());
    const verdict = takeLeadQuota(counter, ipHash);
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterSec: verdict.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSec) } },
      );
    }

    const lang = normalizeLeadLang(body.lang);
    const lead = await createLead({
      userId: widget.userId,
      domain: audit.domain,
      email,
      name: String(body.name ?? "").trim().slice(0, 120),
      message: String(body.message ?? "").trim().slice(0, 2000),
      origin: origin ?? (referer ?? "").slice(0, 300),
      ipHash,
      lang,
      report: audit,
    });

    // Best-effort extras — a lead row exists either way.
    if (widget.settings.notifyEmail) {
      void sendLeadNotificationCopy({
        userId: widget.userId,
        to: widget.settings.notifyEmail,
        domain: audit.domain,
        email,
        score: audit.score,
        top: topFindings(localizeFindings(audit.findings, lang), 3).map(f => f.title),
        lang,
      });
    }
    const mailed = await sendFullReportEmail({
      userId: widget.userId,
      to: email,
      domain: audit.domain,
      score: audit.score,
      findings: localizeFindings(audit.findings, lang),
      lang,
    });

    return NextResponse.json({ ok: true, id: lead.id, emailed: mailed.ok });
  } catch (error) {
    if (error instanceof LeadStoreError) {
      // The instance has the code but not `prisma db push` — the lead is lost, say so plainly.
      return NextResponse.json({ error: "not_migrated" }, { status: 500 });
    }
    console.warn("[public/lead] failed:", (error as Error)?.message ?? error);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
