// N9 — widget settings + key management (Settings → the WidgetSettingsCard).
//
//   GET    (read)          → key, settings, Turnstile status, embed code, SMTP status
//   PUT    (act)           → save a settings patch
//   POST   (manageSecrets) → regenerate the widget key (the old one dies immediately)
//   DELETE (manageSecrets) → revoke the key (widget off everywhere)
//
// Key management follows the mcp-token convention: owner-only, because rotating the key is
// rotating a public credential.

import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { readWidgetSettings, saveWidgetSettings, turnstileConfigured, WidgetSettingsError } from "@/lib/leads/settings";
import { smtpConfigured } from "@/lib/leads/email";
import type { WidgetSettings } from "@/lib/leads/types";

export const dynamic = "force-dynamic";

async function uid(capability: Capability): Promise<string | null> {
  return workspaceUserId(capability);
}

function baseUrl(req: Request): string {
  return (process.env.NEXTAUTH_URL || new URL(req.url).origin).trim().replace(/\/+$/, "");
}

function embedCode(req: Request, key: string): string {
  return `<iframe src="${baseUrl(req)}/embed/audit?key=${key}" style="width:100%;height:640px;border:0" loading="lazy" title="SEO audit"></iframe>`;
}

async function view(req: Request, userId: string) {
  const widget = await readWidgetSettings(userId);
  return {
    widgetKey: widget.widgetKey,
    settings: widget.settings,
    turnstile: turnstileConfigured(),
    smtp: await smtpConfigured(userId),
    embedCode: widget.widgetKey ? embedCode(req, widget.widgetKey) : "",
  };
}

export async function GET(req: Request) {
  const userId = await uid("read");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await view(req, userId));
}

export async function PUT(req: Request) {
  const userId = await uid("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const s = (body.settings ?? {}) as Record<string, unknown>;
  // Only whitelisted fields, each coerced: the settings JSON drives a public page, so an
  // unknown or oversized field must never slip through.
  const patch: Partial<WidgetSettings> = {};
  if (s.enabled !== undefined) patch.enabled = s.enabled === true;
  if (Array.isArray(s.allowedOrigins)) patch.allowedOrigins = s.allowedOrigins.map(v => String(v ?? "")).slice(0, 50);
  if (typeof s.accentColor === "string") patch.accentColor = s.accentColor.slice(0, 7);
  if (typeof s.logoUrl === "string") patch.logoUrl = s.logoUrl.slice(0, 500);
  if (typeof s.consentText === "string") patch.consentText = s.consentText.slice(0, 2000);
  if (typeof s.notifyEmail === "string") patch.notifyEmail = s.notifyEmail.slice(0, 200);
  if (typeof s.emailTemplate === "string") patch.emailTemplate = s.emailTemplate.slice(0, 4000);
  if (typeof s.aboutCompany === "string") patch.aboutCompany = s.aboutCompany.slice(0, 8000);
  try {
    await saveWidgetSettings(userId, { settings: patch });
  } catch (error) {
    if (error instanceof WidgetSettingsError) {
      return NextResponse.json({ error: "not_migrated" }, { status: 500 });
    }
    throw error;
  }
  return NextResponse.json(await view(req, userId));
}

export async function POST(req: Request) {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await saveWidgetSettings(userId, { regenerateKey: true });
  } catch (error) {
    if (error instanceof WidgetSettingsError) {
      return NextResponse.json({ error: "not_migrated" }, { status: 500 });
    }
    throw error;
  }
  return NextResponse.json(await view(req, userId));
}

export async function DELETE(req: Request) {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await saveWidgetSettings(userId, { revokeKey: true });
  } catch (error) {
    if (error instanceof WidgetSettingsError) {
      return NextResponse.json({ error: "not_migrated" }, { status: 500 });
    }
    throw error;
  }
  return NextResponse.json(await view(req, userId));
}
