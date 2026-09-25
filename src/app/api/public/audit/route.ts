// N9 — PUBLIC widget endpoints. No session: the proxy lets /api/public/ through and THIS
// route is the gate (CONTRACT.md §0.6 — a leak through here is the wave's worst outcome).
//
//   GET  ?key=&lang=  → the public widget config (no secrets, no owner data)
//   POST { key, domain, lang, captchaToken } → the lite audit
//
// Everything the POST reads of the owner's data: User.widgetSettings by widgetKey. Nothing
// else. Guards, in order: key lookup → origin allow-list → Turnstile → rate limit → cache
// → audit. Error responses carry short codes only — no internal detail, ever.

import { NextResponse } from "next/server";
import { auditCache } from "@/lib/leads/cache";
import { LEAD_STRINGS, localizeFindings } from "@/lib/leads/i18n";
import { LiteAuditError, normalizeAuditDomain, runLiteAudit, topFindings } from "@/lib/leads/liteAudit";
import { checkOrigin } from "@/lib/leads/originGuard";
import { hashIp, ipSalt, takeAuditQuota, WindowCounter } from "@/lib/leads/ratelimit";
import { findUserByWidgetKey, publicWidgetConfig } from "@/lib/leads/settings";
import { normalizeLeadLang } from "@/lib/leads/types";

export const dynamic = "force-dynamic";

/** One counter per process — the same instance every widget request lands on. */
const counter = new WindowCounter();

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "";
}

function originAndReferer(req: Request): { origin: string | null; referer: string | null } {
  return { origin: req.headers.get("origin"), referer: req.headers.get("referer") };
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // no keys configured → the widget runs without a captcha
  if (!token) return false;
  try {
    // Fixed, trusted Cloudflare endpoint — the one POST this contour makes to a known host.
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json() as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const widget = await findUserByWidgetKey(params.get("key") ?? "");
  if (!widget) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { origin, referer } = originAndReferer(req);
  if (!checkOrigin(origin, referer, widget.settings.allowedOrigins)) {
    return NextResponse.json({ error: "origin" }, { status: 403 });
  }
  // lang is echoed only to pick the consent text; the config itself is language-neutral.
  const lang = normalizeLeadLang(params.get("lang"));
  const consent = widget.settings.consentText || LEAD_STRINGS[lang].consent;
  return NextResponse.json({
    ...publicWidgetConfig(widget.settings),
    consentText: consent,
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const widget = await findUserByWidgetKey(String(body.key ?? ""));
    if (!widget || !widget.settings.enabled) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const { origin, referer } = originAndReferer(req);
    if (!checkOrigin(origin, referer, widget.settings.allowedOrigins)) {
      return NextResponse.json({ error: "origin" }, { status: 403 });
    }

    const ip = clientIp(req);
    if (!(await verifyTurnstile(String(body.captchaToken ?? ""), ip))) {
      return NextResponse.json({ error: "captcha" }, { status: 400 });
    }

    const domainInput = String(body.domain ?? "").trim();
    let domain: string;
    try {
      domain = normalizeAuditDomain(domainInput);
    } catch {
      return NextResponse.json({ error: "invalid_domain" }, { status: 400 });
    }

    // Cache first: a hit costs nothing and does not consume quota — the crawl is the scarce
    // resource the limits protect, not the JSON answer.
    const lang = normalizeLeadLang(body.lang);
    let report = auditCache.get(widget.widgetKey, domain);
    let token: string;
    if (report) {
      token = auditCache.issueToken(widget.widgetKey, domain);
    } else {
      const ipHash = hashIp(ip, ipSalt());
      const verdict = takeAuditQuota(counter, ipHash, widget.widgetKey);
      if (!verdict.allowed) {
        return NextResponse.json(
          { error: "rate_limited", retryAfterSec: verdict.retryAfterSec },
          { status: 429, headers: { "Retry-After": String(verdict.retryAfterSec) } },
        );
      }
      try {
        report = await runLiteAudit(domain);
      } catch (error) {
        if (error instanceof LiteAuditError) {
          return NextResponse.json({ error: error.code }, { status: error.code === "invalid_domain" ? 400 : 422 });
        }
        throw error;
      }
      auditCache.set(widget.widgetKey, domain, report);
      token = auditCache.issueToken(widget.widgetKey, domain);
    }

    // The public list shows titles and evidence only — `fix` is the full report's job
    // (and the operator's follow-up).
    const findings = localizeFindings(topFindings(report.findings, 5), lang)
      .map(({ code, severity, title, evidence }) => ({ code, severity, title, evidence }));
    return NextResponse.json({
      score: report.score,
      https: report.https,
      pagesChecked: report.pagesChecked,
      checkedAt: report.checkedAt,
      findings,
      token,
    });
  } catch (error) {
    console.warn("[public/audit] failed:", (error as Error)?.message ?? error);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
