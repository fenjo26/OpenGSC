// N9 — widget settings and widgetKey storage on the User row (raw SQL, the mcp-token
// convention: a column that predates `prisma db push` degrades to defaults instead of
// throwing). The JSON holds no secrets — everything in it drives a public page.

import { randomBytes } from "node:crypto";
import { rawExec, rawQuery } from "@/lib/db/raw";
import { normalizeOriginHost } from "./originGuard";
import type { PublicWidgetConfig, WidgetSettings } from "./types";

export type { WidgetSettings, PublicWidgetConfig };

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  enabled: false,
  allowedOrigins: [],
  accentColor: "#3B82F6",
  logoUrl: "",
  consentText: "",
  notifyEmail: "",
  emailTemplate: "",
  aboutCompany: "",
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Tolerant parse of stored JSON: every bad field falls back to its default, never throws. */
export function parseWidgetSettings(raw: string | null | undefined): WidgetSettings {
  if (!raw) return { ...DEFAULT_WIDGET_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_WIDGET_SETTINGS };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_WIDGET_SETTINGS };
  const s = parsed as Record<string, unknown>;
  const accent = str(s.accentColor, 7);
  const logo = str(s.logoUrl, 500);
  const notifyEmail = str(s.notifyEmail, 200);
  const origins = Array.isArray(s.allowedOrigins)
    ? [...new Set(s.allowedOrigins.map(v => normalizeOriginHost(String(v ?? ""))).filter(Boolean))].slice(0, 50)
    : [];
  return {
    enabled: s.enabled === true,
    allowedOrigins: origins,
    accentColor: HEX_COLOR.test(accent) ? accent : DEFAULT_WIDGET_SETTINGS.accentColor,
    logoUrl: /^https?:\/\//i.test(logo) ? logo : "",
    consentText: str(s.consentText, 2000),
    notifyEmail: EMAIL_RE.test(notifyEmail) ? notifyEmail : "",
    emailTemplate: str(s.emailTemplate, 4000),
    aboutCompany: str(s.aboutCompany, 8000),
  };
}

/** A public widget id: long enough to be unguessable, prefixed for recognition in logs. */
export function generateWidgetKey(): string {
  return "wid_" + randomBytes(18).toString("hex");
}

export interface WidgetOwnerRow {
  userId: string;
  widgetKey: string;
  settings: WidgetSettings;
}

/** Read key + settings of the workspace owner. Returns defaults (no key) when unset. */
export async function readWidgetSettings(userId: string): Promise<WidgetOwnerRow> {
  const rows = await rawQuery<{ id: string; widgetKey: string | null; widgetSettings: string | null }[]>(
    `SELECT id, widgetKey, widgetSettings FROM "User" WHERE id = ?`, userId,
  );
  const row = rows?.[0];
  return {
    userId: row?.id ?? userId,
    widgetKey: row?.widgetKey ?? "",
    settings: parseWidgetSettings(row?.widgetSettings),
  };
}

/** The public contour's ONLY read of the owner's data: the User row named by the widget key. */
export async function findUserByWidgetKey(widgetKey: string): Promise<WidgetOwnerRow | null> {
  const key = String(widgetKey ?? "").trim();
  if (!key) return null;
  try {
    const rows = await rawQuery<{ id: string; widgetKey: string | null; widgetSettings: string | null }[]>(
      `SELECT id, widgetKey, widgetSettings FROM "User" WHERE widgetKey = ?`, key,
    );
    const row = rows?.[0];
    if (!row?.widgetKey) return null;
    return { userId: row.id, widgetKey: row.widgetKey, settings: parseWidgetSettings(row.widgetSettings) };
  } catch {
    // Column/table missing on a not-yet-migrated instance: behave as "no such widget".
    return null;
  }
}

export class WidgetSettingsError extends Error {
  constructor(public readonly code: "not_migrated" | "invalid") { super(code); }
}

/** Save a settings patch (merged onto the current JSON) and optionally rotate the key. */
export async function saveWidgetSettings(
  userId: string,
  patch: { settings?: Partial<WidgetSettings>; regenerateKey?: boolean; revokeKey?: boolean },
): Promise<WidgetOwnerRow> {
  const current = await readWidgetSettings(userId);
  const merged: WidgetSettings = { ...current.settings, ...(patch.settings ?? {}) };
  const key = patch.revokeKey ? "" : patch.regenerateKey ? generateWidgetKey() : current.widgetKey;
  try {
    await rawExec(
      `UPDATE "User" SET widgetSettings = ?, widgetKey = ? WHERE id = ?`,
      JSON.stringify(merged), key || null, userId,
    );
  } catch {
    throw new WidgetSettingsError("not_migrated");
  }
  return { userId, widgetKey: key, settings: merged };
}

export function publicWidgetConfig(settings: WidgetSettings): PublicWidgetConfig {
  return {
    enabled: settings.enabled,
    accentColor: settings.accentColor,
    logoUrl: settings.logoUrl,
    consentText: settings.consentText,
    captcha: {
      enabled: Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY),
      siteKey: process.env.TURNSTILE_SITE_KEY ?? "",
    },
  };
}

export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}
