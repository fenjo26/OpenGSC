// Server half of MCP credentials: find who a presented token belongs to and what it may do,
// keep the stored form hashed, and record where it is used from.
//
// The decisions themselves (scopes, refusal texts, address bookkeeping) are pure and live in
// tokenScope.ts; hashing lives in src/lib/security/apiTokens.ts. This file is the database glue.

import { prisma, dbAny } from "@/lib/prisma";
import { rawExec, rawQuery } from "@/lib/db/raw";
import { clientIpFromHeaders } from "@/lib/security/clientIp";
import { displayOf, isHashedForm, lookupForms, storedFormOf } from "@/lib/security/apiTokens";
import {
  isLinkTokenFormat, isMainTokenFormat, isNewIp, parseKnownIps, rememberIp, type TokenGrant,
} from "./tokenScope";

export type TokenVia = "header" | "query";

/** The token from wherever the client was able to put it, and which of the two it was. */
export function extractMcpToken(req: Request): { token: string; via: TokenVia } | null {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || req.headers.get("x-api-key")?.trim() || "";
  if (bearer) return { token: bearer, via: "header" };
  try {
    const qs = new URL(req.url).searchParams;
    const q = (qs.get("token") || qs.get("key") || qs.get("api_key") || "").trim();
    if (q) return { token: q, via: "query" };
  } catch { /* unparseable URL */ }
  return null;
}

export interface McpCredential {
  /** The person the token belongs to (the owner, in practice: only the owner can mint tokens). */
  actorId: string;
  grant: TokenGrant;
}

/**
 * Resolve the request's MCP token. Null = no token, or one that matches nothing.
 * Side effects, both best-effort and never failing the request: a legacy plaintext main token is
 * rewritten to its hashed form, and the use is recorded (with an alert on a new address).
 */
export async function resolveMcpCredential(req: Request): Promise<McpCredential | null> {
  const found = extractMcpToken(req);
  if (!found) return null;
  const { token, via } = found;
  const isLink = isLinkTokenFormat(token);
  if (!isLink && !isMainTokenFormat(token)) return null;
  const ip = clientIpFromHeaders(req.headers);

  if (isLink) {
    let link: { id: string; userId: string; label: string; allowWrite: boolean; allowSpend: boolean; knownIps: string; lastIp: string | null; lastUsedAt: Date | null } | null = null;
    try {
      link = await dbAny.mcpLink.findUnique({ where: { tokenHash: storedFormOf(token) } });
    } catch {
      return null; // McpLink table missing — prisma db push not run yet
    }
    if (!link) return null;
    void recordLinkUse(link, ip).catch(() => {});
    return {
      actorId: link.userId,
      grant: { kind: "link", linkId: link.id, allowWrite: !!link.allowWrite, allowSpend: !!link.allowSpend },
    };
  }

  const [hashed, plain] = lookupForms(token);
  let row: { id: string; mcpToken: string | null } | undefined;
  try {
    const rows = await rawQuery<{ id: string; mcpToken: string | null }[]>(
      `SELECT id, mcpToken FROM "User" WHERE mcpToken = ? OR mcpToken = ? LIMIT 1`, hashed, plain,
    );
    row = rows?.[0];
  } catch {
    return null; // mcpToken column missing (prisma db push not run yet)
  }
  if (!row) return null;
  // A hashed row must equal the hash of what was presented; the plaintext branch exists only for
  // rows minted before hashing. (The format check above already keeps a hash form from being
  // presented as a token; this keeps the rule true even if that check ever loosens.)
  if (isHashedForm(row.mcpToken) && row.mcpToken !== hashed) return null;
  if (!isHashedForm(row.mcpToken)) {
    // A token minted before hashing: replace the plaintext with its hashed form. Conditional on
    // the old value so a rotation that raced this request is not overwritten.
    await rawExec(`UPDATE "User" SET mcpToken = ? WHERE id = ? AND mcpToken = ?`, hashed, row.id, plain).catch(() => {});
  }
  void recordMainUse(row.id, ip).catch(() => {});
  return { actorId: row.id, grant: via === "header" ? { kind: "header" } : { kind: "url" } };
}

// ─── usage ──────────────────────────────────────────────────────────────────────

/** Skip the write when the same address used the same credential within this window. */
const RECORD_EVERY_MS = 5 * 60_000;
const lastRecorded = new Map<string, { ip: string; at: number }>();

function shouldRecord(key: string, ip: string): boolean {
  const now = Date.now();
  const prev = lastRecorded.get(key);
  if (prev && prev.ip === ip && now - prev.at < RECORD_EVERY_MS) return false;
  if (lastRecorded.size > 1000) lastRecorded.clear();
  lastRecorded.set(key, { ip, at: now });
  return true;
}

export interface TokenUsage {
  lastUsedAt: string | null;
  lastIp: string | null;
  knownIps: string[];
}

const mainUsageKey = (userId: string) => `mcp_token_usage:${userId}`;

export async function readMainUsage(userId: string): Promise<TokenUsage> {
  try {
    const row = await prisma.instanceSetting.findUnique({ where: { key: mainUsageKey(userId) } });
    const v = row ? JSON.parse(row.value) as Partial<TokenUsage> : {};
    return { lastUsedAt: typeof v.lastUsedAt === "string" ? v.lastUsedAt : null, lastIp: typeof v.lastIp === "string" ? v.lastIp : null, knownIps: parseKnownIps(v.knownIps) };
  } catch {
    return { lastUsedAt: null, lastIp: null, knownIps: [] };
  }
}

/** A new or revoked main token starts a new history: the old token's addresses say nothing about it. */
export async function resetMainUsage(userId: string): Promise<void> {
  await prisma.instanceSetting.deleteMany({ where: { key: mainUsageKey(userId) } }).catch(() => {});
}

async function recordMainUse(userId: string, ip: string): Promise<void> {
  if (!shouldRecord(`main:${userId}`, ip)) return;
  const usage = await readMainUsage(userId);
  const alert = isNewIp(usage.knownIps, ip);
  const next: TokenUsage = { lastUsedAt: new Date().toISOString(), lastIp: ip === "unknown" ? usage.lastIp : ip, knownIps: rememberIp(usage.knownIps, ip) };
  const value = JSON.stringify(next);
  await prisma.instanceSetting.upsert({ where: { key: mainUsageKey(userId) }, create: { key: mainUsageKey(userId), value }, update: { value } });
  if (alert) await alertNewAddress(userId, displayOfMain(userId), ip);
}

async function recordLinkUse(
  link: { id: string; userId: string; label: string; knownIps: string },
  ip: string,
): Promise<void> {
  if (!shouldRecord(`link:${link.id}`, ip)) return;
  const known = parseKnownIps(link.knownIps);
  const alert = isNewIp(known, ip);
  await dbAny.mcpLink.update({
    where: { id: link.id },
    data: { lastUsedAt: new Date(), ...(ip !== "unknown" ? { lastIp: ip } : {}), knownIps: JSON.stringify(rememberIp(known, ip)) },
  });
  if (alert) await alertNewAddress(link.userId, Promise.resolve(link.label ? `"${link.label}"` : "connector link"), ip);
}

async function displayOfMain(userId: string): Promise<string> {
  try {
    const rows = await rawQuery<{ mcpToken: string | null }[]>(`SELECT mcpToken FROM "User" WHERE id = ?`, userId);
    return displayOf(rows?.[0]?.mcpToken) ?? "MCP token";
  } catch {
    return "MCP token";
  }
}

// ─── alert ──────────────────────────────────────────────────────────────────────

const ALERT: Record<string, (what: string, ip: string) => string> = {
  en: (w, ip) => `🔐 OpenGSC: ${w} was used from a new address: ${ip}.\nIf this was not you, revoke it in Settings → API & MCP.`,
  ru: (w, ip) => `🔐 OpenGSC: ${w} использован с нового адреса: ${ip}.\nЕсли это были не вы — отзовите его в Настройки → API и MCP.`,
  uk: (w, ip) => `🔐 OpenGSC: ${w} використано з нової адреси: ${ip}.\nЯкщо це були не ви — відкличте його в Налаштування → API і MCP.`,
  fr: (w, ip) => `🔐 OpenGSC : ${w} a été utilisé depuis une nouvelle adresse : ${ip}.\nSi ce n’était pas vous, révoquez-le dans Paramètres → API et MCP.`,
  es: (w, ip) => `🔐 OpenGSC: ${w} se usó desde una dirección nueva: ${ip}.\nSi no fuiste tú, revócalo en Ajustes → API y MCP.`,
  de: (w, ip) => `🔐 OpenGSC: ${w} wurde von einer neuen Adresse verwendet: ${ip}.\nWarst du das nicht, widerrufe es unter Einstellungen → API & MCP.`,
  zh: (w, ip) => `🔐 OpenGSC：${w} 从新地址被使用：${ip}。\n如果不是你本人，请在 设置 → API 与 MCP 中撤销。`,
  nl: (w, ip) => `🔐 OpenGSC: ${w} is gebruikt vanaf een nieuw adres: ${ip}.\nWas jij dit niet, trek het dan in via Instellingen → API & MCP.`,
};

async function alertNewAddress(userId: string, what: Promise<string>, ip: string): Promise<void> {
  let lang = "en";
  try {
    const rows = await rawQuery<{ alertSettings?: string | null }[]>(`SELECT alertSettings FROM "User" WHERE id = ?`, userId);
    const parsed = rows?.[0]?.alertSettings ? JSON.parse(rows[0].alertSettings) as { lang?: unknown } : {};
    if (typeof parsed.lang === "string" && parsed.lang in ALERT) lang = parsed.lang;
  } catch { /* default language */ }
  const { notifyUser } = await import("@/lib/notify");
  await notifyUser(userId, ALERT[lang](await what, ip));
}
