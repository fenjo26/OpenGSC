"use client";

// Client helpers for GEO audits. An audit runs server-side and persists its result,
// so the user can close the tab and re-open it later from the recent list.
import type { GeoReport } from "@/lib/seo/geo";
import { getAparserCreds as getAparserConnection } from "@/lib/seo/keys";

export interface GeoAuditRec {
  id: string;
  query: string;
  language: string;
  country: string;
  model: string;
  status: "processing" | "completed" | "error";
  error?: string | null;
  report?: string | null;
  createdAt: string;
  updatedAt: string;
}

// The GEO engine needs a provider-hosted search tool — OpenAI's `web_search`, kie.ai's mirror of
// it, or Gemini's `google_search` grounding — independent of whichever provider the other SEO
// tools are set to.
export function getOpenAiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiKey_openai") || (localStorage.getItem("aiProvider") === "openai" ? localStorage.getItem("aiApiKey") || "" : "");
}
// Endpoint override for the OpenAI engine (aiBaseUrl_openai), same convention as the shared
// client: a gateway key must be spent against the gateway, never against api.openai.com.
export function getOpenAiBaseUrl(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiBaseUrl_openai") || "";
}
export function getKieKeyForGeo(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiKey_kie") || "";
}
export function getGeminiKeyForGeo(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiKey_gemini") || "";
}
export function getGeminiBaseUrl(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiBaseUrl_gemini") || "";
}

/**
 * A-Parser is the one engine with no API key: it is software the user runs, reached at their own
 * host with that instance's password.
 *
 * The connection itself is not GEO's to own — it is the same instance the A-Parser SERP provider
 * uses, stored once in Settings → SEO Tools (`seoBaseUrl_aparser` / `seoKey_aparser`) and read
 * through `keys.ts`. Re-exported here only so the GEO page has one import for everything it
 * needs, and so a future change of storage keys has one place to happen.
 */
export function getAparserCreds(): { url: string; password: string; config: string } {
  const c = getAparserConnection();
  return { url: c.baseUrl, password: c.password, config: c.configPreset };
}
function hasAparserCreds(): boolean {
  const a = getAparserCreds();
  return !!a.url.trim() && !!a.password.trim();
}

const GEO_ENGINE_KEY = "geoEngine";
export type GeoEngineChoice = "openai" | "kie" | "gemini" | "aparser";
// Which engine to use: an explicit user choice (if that key is still configured), else whichever
// key is actually present, preferring OpenAI (native web_search) when several are set.
export function getGeoEngine(): GeoEngineChoice {
  if (typeof window === "undefined") return "openai";
  const hasOpenAi = !!getOpenAiKey();
  const hasKie = !!getKieKeyForGeo();
  const hasGemini = !!getGeminiKeyForGeo();
  const hasAparser = hasAparserCreds();
  const stored = localStorage.getItem(GEO_ENGINE_KEY) as GeoEngineChoice | null;
  if (stored === "kie" && hasKie) return "kie";
  if (stored === "gemini" && hasGemini) return "gemini";
  if (stored === "openai" && hasOpenAi) return "openai";
  if (stored === "aparser" && hasAparser) return "aparser";
  if (hasOpenAi) return "openai";
  if (hasGemini) return "gemini";
  if (hasKie) return "kie";
  // Last in the automatic order on purpose. Configuring A-Parser must not silently move an
  // existing user's audits off the engine they have been comparing runs on; it is picked
  // automatically only when nothing else is configured at all.
  if (hasAparser) return "aparser";
  return "openai";
}
export function setGeoEngine(e: GeoEngineChoice) {
  if (typeof window !== "undefined") localStorage.setItem(GEO_ENGINE_KEY, e);
}
// For "aparser" this returns the instance password: the route treats `apiKey` as the engine's
// credential whatever it is, and the endpoint travels in `baseUrl` like every other override.
export function getGeoApiKey(engine: GeoEngineChoice): string {
  return engine === "kie" ? getKieKeyForGeo()
    : engine === "gemini" ? getGeminiKeyForGeo()
    : engine === "aparser" ? getAparserCreds().password
    : getOpenAiKey();
}

const GEO_MODEL_KEY = "geoModel";
// Returns "" when nothing has been chosen, so the caller resolves a default from the account's
// live model list (lib/seo/models.ts) instead of inheriting a model id frozen into this file.
export function getGeoModel(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(GEO_MODEL_KEY) || "";
}
export function setGeoModel(m: string) {
  if (typeof window !== "undefined") localStorage.setItem(GEO_MODEL_KEY, m);
}

export async function startGeoAudit(payload: {
  query: string; language: string; country: string; model: string; apiKey: string;
  engine?: GeoEngineChoice;
  baseUrl?: string;
  analysisModel?: string;
  /**
   * Stage-2 provider, key and model from the `utility` task setting.
   *
   * `apiKey` is the GEO engine's (OpenAI or kie.ai) and pays for the web search; this pays for
   * the structured pass that reads the trace afterwards. Two keys in one payload looks odd until
   * you notice the two stages need different things: only the first needs a hosted web_search
   * tool, and only the second is worth economising on.
   */
  analysis?: { provider: string; apiKey: string; model?: string; baseUrl?: string };
  /** Engine "aparser" only: which preset inside the user's A-Parser to run. */
  aparserPreset?: string;
  /** Engine "aparser" only: the instance's thread-count config to run under. */
  aparserConfig?: string;
  /** Optional: the user's own page to compare against the cited ones in stage 2. */
  pageUrl?: string;
}): Promise<{ id?: string; error?: string }> {
  try {
    const res = await fetch("/api/seo/geo", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) return { error: d.error || "audit_failed" };
    return { id: d.id };
  } catch (e: any) { return { error: String(e?.message ?? e) }; }
}

export async function getGeoAudit(id: string): Promise<GeoAuditRec | null> {
  try {
    const res = await fetch(`/api/seo/geo/${id}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()).audit ?? null;
  } catch { return null; }
}

export async function listGeoAudits(): Promise<GeoAuditRec[]> {
  try {
    const res = await fetch("/api/seo/geo", { cache: "no-store" });
    if (!res.ok) return [];
    return (await res.json()).audits ?? [];
  } catch { return []; }
}

export async function deleteGeoAudit(id: string): Promise<void> {
  try { await fetch(`/api/seo/geo/${id}`, { method: "DELETE" }); } catch {}
}

export function parseReport(rec: GeoAuditRec | null): GeoReport | null {
  if (!rec?.report) return null;
  try { return JSON.parse(rec.report) as GeoReport; } catch { return null; }
}
