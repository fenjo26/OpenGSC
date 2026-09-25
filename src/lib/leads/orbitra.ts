// N9 → Orbitra bridge (the operator's own tracker, orbitra.link). Server-to-server calls
// to its single entry point api.php with a write-scoped API key. The URL and key live in
// InstanceSetting (a self-hosted workspace has exactly one tracker); the lead row carries
// only the created campaign's reference. Kept out of the public contour entirely: these
// calls run with the operator's session, never from /embed or /api/public.
//
// The tracker is operator-configured infrastructure on the same trust level as A-Parser
// (which may sit at loopback) — private addresses are deliberately allowed, but
// assertSafeTarget still parses and validates every URL before the request.

import { prisma } from "@/lib/prisma";
import { assertSafeTarget, SafeFetchError } from "@/lib/security/safeFetch";

export const ORBITRA_URL_KEY = "orbitra_url";
export const ORBITRA_KEY_KEY = "orbitra_key";

export class OrbitraError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(code);
  }
}

/** https://tracker.example.com — scheme added when missing, query/hash/trailing slash dropped. */
export function normalizeOrbitraUrl(raw: string): string | null {
  let s = (raw || "").trim();
  if (!s) return null;
  // Only a bare hostname gets a scheme; an explicit non-http(s) scheme must be REJECTED,
  // not rewritten (a blind prepend once turned ftp://tracker into host "ftp").
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString();
  } catch {
    return null;
  }
}

/** ogsc-<domain-slug>-<yyyymmddhhmm> — unique per attempt, so a re-send never collides. */
export function campaignAliasFor(domain: string, now: Date = new Date()): string {
  const slug = domain.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";
  return `ogsc-${slug}-${now.toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;
}

export interface OrbitraConfig {
  url: string;
  key: string;
}

export async function readOrbitraConfig(): Promise<OrbitraConfig | null> {
  const rows = await prisma.instanceSetting.findMany({ where: { key: { in: [ORBITRA_URL_KEY, ORBITRA_KEY_KEY] } } });
  const url = rows.find(r => r.key === ORBITRA_URL_KEY)?.value.trim();
  const key = rows.find(r => r.key === ORBITRA_KEY_KEY)?.value.trim();
  return url && key ? { url, key } : null;
}

export async function saveOrbitraConfig(rawUrl: string, key: string): Promise<OrbitraConfig> {
  const url = normalizeOrbitraUrl(rawUrl);
  const k = (key || "").trim();
  if (!url) throw new OrbitraError("invalid_url");
  if (!k) throw new OrbitraError("invalid_key");
  for (const [settingKey, value] of [[ORBITRA_URL_KEY, url], [ORBITRA_KEY_KEY, k]] as const) {
    await prisma.instanceSetting.upsert({ where: { key: settingKey }, update: { value }, create: { key: settingKey, value } });
  }
  return { url, key: k };
}

async function orbitraApi<T = unknown>(
  cfg: OrbitraConfig,
  action: string,
  init?: { method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const target = `${cfg.url}/api.php?action=${encodeURIComponent(action)}`;
  try {
    await assertSafeTarget(target, { allowPrivate: true });
    const res = await fetch(target, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new OrbitraError(`orbitra_http_${res.status}`, res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OrbitraError("orbitra_not_json");
    }
  } catch (e) {
    if (e instanceof OrbitraError) throw e;
    if (e instanceof SafeFetchError) throw new OrbitraError("orbitra_forbidden_target");
    throw new OrbitraError("orbitra_unreachable");
  }
}

/** Any read action proves both halves of the config: the URL answers, the key is accepted. */
export async function testOrbitra(cfg: OrbitraConfig): Promise<void> {
  await orbitraApi(cfg, "metrics");
}

export interface OrbitraCampaignRef {
  id: number | null;
  alias: string;
  /** The tracker's base URL — the admin UI is a SPA, so this is the deep link we can honestly build. */
  url: string;
}

/**
 * One campaign per lead: name = the lead's domain, unique alias, no streams/offers invented —
 * a shell the operator fills in Orbitra when the traffic actually starts.
 */
export async function createCampaignForLead(
  lead: { domain: string },
  cfg: OrbitraConfig,
): Promise<OrbitraCampaignRef> {
  const name = lead.domain.replace(/^www\./, "");
  const alias = campaignAliasFor(lead.domain);
  const res = await orbitraApi<Record<string, unknown>>(cfg, "save_campaign", {
    method: "POST",
    body: { name, alias },
  });
  // The answer's envelope varies across tracker versions — accept the id from any known slot.
  const raw = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
  const inner = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
  const id =
    typeof inner.id === "number" ? inner.id :
    typeof raw.id === "number" ? raw.id : null;
  const ok = id !== null || raw.success === true || inner.success === true;
  if (!ok) throw new OrbitraError("orbitra_bad_response");
  return { id, alias, url: cfg.url };
}
