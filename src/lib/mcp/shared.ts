// Shared plumbing for the MCP tool registry.
//
// The registry is split across three files (tools.ts = GSC core, toolsData.ts = the
// rest of the app's read surfaces, toolsOptimize.ts = the page-optimization contour).
// Everything they have in common lives here, so none of them has to import another —
// a cycle through the registry array is easy to create and annoying to unpick.

import { prisma } from "@/lib/prisma";
import { rawQuery } from "@/lib/db/raw";
import { normalizePolicy, type EditorialPolicy } from "@/lib/seo/policy";

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

/** The per-task override slots the settings UI writes — see lib/seo/aiTasks.ts. */
export type SeoTaskId = "outline" | "text" | "analysis" | "policy" | "landing" | "utility";

// First non-blank wins. `??` is wrong for this chain: these values come out of a JSON blob where
// "cleared in the UI" is stored as "", and `"" ?? next` keeps the empty string and stops the
// fallback dead.
const firstSet = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
};

/**
 * Resolve the AI credentials a paid tool should run on, preferring anything the agent
 * passed explicitly over the stored snapshot. Mirrors `aiSummary()` in lib/digest.ts —
 * the key naming convention (`aiKey_<provider>`) is set by the settings UI, not here.
 *
 * `task` matters more than it looks. The browser resolves creds through `resolveTaskCreds()`
 * in lib/seo/keys.ts, whose chain is FOUR levels deep: per-task override → SEO-wide → global →
 * provider default. This function only ever read the last three, so the per-task level — the one
 * users actually reach for, because it is how you keep a reasoning model off a step whose output
 * must be JSON — was invisible over MCP. The same job then ran on a different model here than in
 * the UI, which is exactly as confusing as it sounds: the Outline page worked and the agent's
 * outline_auto failed, on one instance, with one set of keys.
 */
export async function resolveAiCreds(userId: string, args: Json = {}, task?: SeoTaskId): Promise<AiCreds> {
  const s = await getUserSettings(userId);
  const provider = firstSet(
    args.aiProvider,
    task && s[`seoTaskProvider_${task}`],
    s.seoProvider,
    s.aiProvider,
  ) ?? "anthropic";
  const apiKey = firstSet(args.aiApiKey, s[`aiKey_${provider}`], s.aiApiKey) ?? "";
  // Same order the UI uses once the provider is known: task model, then the SEO-wide model,
  // then whatever that provider defaults to.
  //
  // `seoModel` is only valid while we are still resolving for the provider it was chosen under.
  // A per-task provider override changes that, and passing a GLM id to OpenAI (or the reverse)
  // produces a 404 that reads as "the tool is broken" rather than "wrong model".
  const seoWideProvider = firstSet(s.seoProvider, s.aiProvider) ?? "anthropic";
  const model = firstSet(
    args.model,
    task && s[`seoTaskModel_${task}`],
    provider === seoWideProvider ? s.seoModel : undefined,
    s[`aiModel_${provider}`],
  );
  return {
    aiProvider: provider,
    aiApiKey: apiKey,
    model,
    // Per-provider base URL, falling back to the custom-provider slot for backwards compatibility.
    // zai needs its own: the default is now the general API endpoint, and a user on the Coding
    // Plan points this at https://api.z.ai/api/anthropic to keep using that one.
    aiBaseUrl: s[`aiBaseUrl_${provider}`] || s.aiBaseUrl_custom || undefined,
    firecrawlKey: s.seoKey_firecrawl || s.firecrawlKey || undefined,
  };
}

/**
 * Every OTHER provider this instance holds a key for, as ready-to-use credential sets.
 *
 * A generation job used to die outright when its one provider failed for a reason that had
 * nothing to do with the request — a gateway that ranks upstream routes by price and picks one
 * that cannot report token usage returns `502 … did not include usage for billing` AFTER the
 * model has already written the answer, and retrying reproduces it. Fifteen minutes and a
 * scraped SERP were thrown away because one hop misbehaved, while keys for two other providers
 * sat unused in the same settings blob.
 *
 * Ordering is deliberate: providers the user has explicitly chosen a model for come first, since
 * a configured model is evidence they use that provider, and an unconfigured one falls back to
 * whatever `defaultModelFor` picks. Capped at three so a broken instance cannot bill its way
 * through an entire catalogue.
 */
export async function resolveAiFallbacks(userId: string, primaryProvider?: string): Promise<AiCreds[]> {
  const s = await getUserSettings(userId);
  const out: AiCreds[] = [];
  const skip = String(primaryProvider || "").trim();
  for (const key of Object.keys(s)) {
    if (!key.startsWith("aiKey_")) continue;
    const p = key.slice("aiKey_".length);
    if (!p || p === skip) continue;
    const apiKey = firstSet(s[key]);
    if (!apiKey) continue;
    out.push({
      aiProvider: p,
      aiApiKey: apiKey,
      model: firstSet(s[`aiModel_${p}`]),
      aiBaseUrl: s[`aiBaseUrl_${p}`] || undefined,
    });
  }
  out.sort((a, b) => (b.model ? 1 : 0) - (a.model ? 1 : 0));
  return out.slice(0, 3);
}

/** Which per-task override slot a background job type should resolve against. */
export function taskForJobType(type: string): SeoTaskId {
  switch (type) {
    case "outline":
    case "outline_auto":
    case "cluster":
      return "outline";
    case "landing":
      return "landing";
    case "analysis":
      return "analysis";
    // `text` and `rewrite` are both prose generation — the UI runs /seo-tools/rewrite on the
    // `text` task too (see PATH_TASKS in lib/seo/aiTasks.ts).
    default:
      return "text";
  }
}

/**
 * Resolve the editorial policy a generation job should run under.
 *
 * The browser reads `seoPolicies` + `seoActivePolicy` from localStorage and puts the whole object
 * in the request body, where `renderPolicy()` turns it into the `<editorial_policy>` block. Nothing
 * on the MCP side did that, so every agent-started job ran with `policy: undefined` — and an absent
 * policy is not a default one, it is NO policy block at all: no brand, no audience, no tone of
 * voice, no words-to-avoid, and not even the compliance rule about never inventing licences.
 * The user's whole editorial setup silently did not apply to anything an agent generated.
 *
 * Returns undefined when the instance has no policies stored, so the payload stays byte-identical
 * to before in that case.
 */
export async function resolveActivePolicy(userId: string, args: Json = {}): Promise<EditorialPolicy | undefined> {
  const s = await getUserSettings(userId);
  let list: unknown;
  try {
    list = typeof s.seoPolicies === "string" ? JSON.parse(s.seoPolicies) : s.seoPolicies;
  } catch {
    return undefined;
  }
  if (!Array.isArray(list) || !list.length) return undefined;
  const wanted = firstSet(args.policyName, s.seoActivePolicy);
  const hit = (wanted && list.find((p: any) => p?.name === wanted)) || list[0];
  return hit ? normalizePolicy(hit) : undefined;
}

export interface SerpCreds {
  serpProvider: string;
  serpKey: string;
}

/**
 * Resolve the SERP credentials genOutlineAuto/genCluster need, the same way resolveAiCreds
 * resolves the AI key: prefer whatever the agent passed explicitly, else fall back to the
 * User.seoSettings snapshot SeoKeysSync backs up from the browser (`seoSerpProvider` +
 * `seoKey_<provider>`, same naming convention as the SEO Tools settings UI).
 *
 * Before this existed, start_generation_job only called resolveAiCreds, so `outline_auto`
 * and `cluster` jobs always got an empty serpKey and failed with `no_serp_key` even when
 * the user had a paid, working SERP provider configured and synced — the key was sitting
 * in the same settings blob the whole time, just never read for this field.
 */
export async function resolveSerpCreds(userId: string, args: Json = {}): Promise<SerpCreds> {
  const s = await getUserSettings(userId);
  const provider = String(args.serpProvider ?? s.seoSerpProvider ?? "serper");
  const key = String(args.serpKey ?? s[`seoKey_${provider}`] ?? "");
  return { serpProvider: provider, serpKey: key };
}

export interface KeywordSourceCreds {
  source: "ahrefs" | "semrush" | "dataforseo";
  apiKey: string;
  baseUrl?: string;
  /** How many ideas one expansion may ask for — the ceiling on what it can cost. */
  limit: number;
  /** Monthly unit cap from Settings → SEO Metrics; 0 means no cap (same convention as withinCap). */
  cap: number;
}

/**
 * Server-side mirror of `getKeywordSource()` (lib/seo/keys.ts) — the keyword provider the
 * Outline page's "load keywords" step uses. The browser reads localStorage; everything it
 * reads is mirrored into User.seoSettings by SeoKeysSync under the same names, so this walks
 * the same Ahrefs → Semrush → DataForSEO chain over the same keys: reseller mode suffix
 * (`seoKey_<p>__reseller`), custom host (`seoMetricsBaseUrl_<p>`) and the idea limit
 * (`seoKwLimit`, clamped exactly like the UI clamps it).
 *
 * Returns null when nothing is configured — callers should say "configure it in Settings →
 * SEO Metrics", not silently skip the keyword grounding the user asked for.
 */
export async function resolveKeywordSource(userId: string): Promise<KeywordSourceCreds | null> {
  const s = await getUserSettings(userId);
  const setting = ["ahrefs", "semrush", "dataforseo", "off"].includes(String(s.seoKwSource))
    ? String(s.seoKwSource) : "auto";
  if (setting === "off") return null;
  const limitRaw = parseInt(String(s.seoKwLimit ?? "100"), 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(50, Math.min(200, limitRaw)) : 100;
  const candidates = setting === "auto" ? ["ahrefs", "semrush", "dataforseo"] : [setting];
  for (const c of candidates) {
    if (c === "dataforseo") {
      const k = String(s.seoKey_dataforseo ?? "").trim();
      if (k) return { source: "dataforseo", apiKey: k, limit, cap: 0 };
      continue;
    }
    const mode = String(s[`seoMetricsMode_${c}`] ?? "");
    const k = String(s[`seoKey_${c}__${mode}`] || s[`seoKey_${c}`] || "").trim();
    if (k.length > 4) {
      return {
        source: c as "ahrefs" | "semrush",
        apiKey: k,
        baseUrl: String(s[`seoMetricsBaseUrl_${c}`] ?? "").trim() || undefined,
        limit,
        cap: Number(s[`seoMetricsCap_${c}`] ?? 0) || 0,
      };
    }
  }
  return null;
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
