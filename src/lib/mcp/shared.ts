// Shared plumbing for the MCP tool registry.
//
// The registry is split across three files (tools.ts = GSC core, toolsData.ts = the
// rest of the app's read surfaces, toolsOptimize.ts = the page-optimization contour).
// Everything they have in common lives here, so none of them has to import another —
// a cycle through the registry array is easy to create and annoying to unpick.

import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";

export type Json = Record<string, unknown>;

/**
 * `cost` documents what calling the tool actually spends, and is surfaced in tools/list
 * so an agent can tell the difference before it calls something:
 *   local — reads this instance's SQLite. Free, instant.
 *   quota — calls a Google API on the user's own OAuth. Free, but consumes a daily quota.
 *   net   — fetches a third-party page over HTTP. Free, but leaves the server.
 *   paid  — spends the user's own LLM/SERP credits. Never runs without confirm: true.
 */
export type ToolCost = "local" | "quota" | "net" | "paid";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
  /**
   * Required, not optional with a `local` default. A default would mean the one mistake
   * that actually costs something — adding a tool that spends money and forgetting to say
   * so — compiles cleanly and is then announced to agents as free.
   */
  cost: ToolCost;
  /** Override protocol annotations for local tools that intentionally mutate this instance. */
  readOnly?: boolean;
  idempotent?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  handler: (userId: string, args: Json) => Promise<unknown>;
}

// ─── numeric helpers ────────────────────────────────────────────────────────────

export const sinceDate = (days: unknown, def = 90, max = 480): Date => {
  const n = Math.min(max, Math.max(1, parseInt(String(days ?? def), 10) || def));
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

export const lim = (v: unknown, def: number, max: number): number =>
  Math.min(max, Math.max(1, parseInt(String(v ?? def), 10) || def));

export const pct = (n: number) => Math.round(n * 1000) / 10;
export const r1 = (n: number) => Math.round(n * 10) / 10;

// ─── site resolution ────────────────────────────────────────────────────────────

// Resolve a site by id, exact URL, or domain substring — agents usually pass a domain.
export async function resolveSite(userId: string, site: unknown) {
  const q = String(site ?? "").trim();
  if (!q) throw new Error("Missing required argument: site (domain, GSC property, or site id from list_sites)");
  const sites = await prisma.site.findMany({ where: { userId } });
  const found = matchSite(sites, q);
  if (!found) throw new Error(`Site not found: "${q}". Call list_sites to see available sites.`);
  return found;
}

export const normDomain = (s: string) =>
  s.toLowerCase().replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/^www\./, "").replace(/\/+$/, "");

function matchSite<T extends { id: string; siteId: string; url: string }>(sites: T[], q: string): T | undefined {
  const nq = normDomain(q);
  return (
    sites.find(s => s.id === q) ??
    sites.find(s => normDomain(s.siteId) === nq || normDomain(s.url) === nq) ??
    sites.find(s => normDomain(s.siteId).includes(nq) || normDomain(s.url).includes(nq))
  );
}

// Same as resolveSite, but "all"/empty means the whole portfolio instead of an error —
// for tools (decay, digests) whose UI equivalent has an "all sites" mode.
export async function resolveSites(userId: string, site: unknown) {
  const q = String(site ?? "").trim();
  const sites = await prisma.site.findMany({ where: { userId } });
  if (!q || q.toLowerCase() === "all") return sites;
  const found = matchSite(sites, q);
  if (!found) throw new Error(`Site not found: "${q}". Call list_sites to see available sites, or pass "all".`);
  return [found];
}

export const siteArg = {
  type: "string",
  description: "The site — a domain (example.com), GSC property (sc-domain:example.com), or a site id from list_sites",
};

export const siteOrAllArg = {
  type: "string",
  description: "The site — a domain, GSC property, or site id from list_sites. Pass \"all\" for the whole portfolio.",
};

// ─── the user's saved SEO settings ──────────────────────────────────────────────
//
// SEO Tools keys live in the browser's localStorage and are mirrored to User.seoSettings
// by SeoKeysSync. Server-side callers with no browser (digest-cron, rank-cron, and now
// MCP) read that mirror. Raw SQL by the same convention as the rest of the codebase:
// the column may not exist on an instance that hasn't run `prisma db push`, and an
// agent asking for a rewrite should get "no key configured", not a 500.

export async function getUserSettings(userId: string): Promise<Record<string, any>> {
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    return rows?.[0]?.seoSettings ? JSON.parse(rows[0].seoSettings) : {};
  } catch {
    return {};
  }
}

export interface AiCreds {
  aiProvider: string;
  aiApiKey: string;
  model?: string;
  aiBaseUrl?: string;
  firecrawlKey?: string;
}

/**
 * Resolve the AI credentials a paid tool should run on, preferring anything the agent
 * passed explicitly over the stored snapshot. Mirrors `aiSummary()` in lib/digest.ts —
 * the key naming convention (`aiKey_<provider>`) is set by the settings UI, not here.
 */
export async function resolveAiCreds(userId: string, args: Json = {}): Promise<AiCreds> {
  const s = await getUserSettings(userId);
  const provider = String(args.aiProvider ?? s.seoProvider ?? s.aiProvider ?? "anthropic");
  const apiKey = String(args.aiApiKey ?? s[`aiKey_${provider}`] ?? s.aiApiKey ?? "");
  const model = String(args.model ?? s.seoModel ?? s[`aiModel_${provider}`] ?? "") || undefined;
  return {
    aiProvider: provider,
    aiApiKey: apiKey,
    model,
    aiBaseUrl: s.aiBaseUrl_custom || undefined,
    firecrawlKey: s.seoKey_firecrawl || s.firecrawlKey || undefined,
  };
}

/**
 * Gate for every tool that spends the user's money.
 *
 * MCP's own risk model is the client's: some clients auto-approve tool calls, and an
 * agent exploring the registry should not be able to bill the user by calling a tool
 * to "see what it returns". `confirm: true` makes spending an explicit act, and the
 * refusal text tells the agent to ask the human rather than retry with the flag set.
 */
export function assertConfirmed(args: Json, what: string): void {
  if (args.confirm === true) return;
  throw new Error(
    `${what} spends the instance owner's own AI credits, so it will not run unconfirmed. ` +
    `Ask the user for permission first, then call again with confirm: true. ` +
    `If you only need material to write from — and you can write it yourself — call get_optimization_brief instead: it is free.`,
  );
}

export const confirmArg = {
  type: "boolean",
  description: "Must be true. PAID: this call spends the instance owner's own AI credits — get their permission before setting it.",
};

// JSON columns are stored as strings throughout the schema; agents want objects.
export const parseJson = (s: string | null | undefined): unknown => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
};
