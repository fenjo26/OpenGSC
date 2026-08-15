"use client";

// Client helpers for GEO audits. An audit runs server-side and persists its result,
// so the user can close the tab and re-open it later from the recent list.
import type { GeoReport } from "@/lib/seo/geo";

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

// The GEO engine needs a real `web_search` tool call, so it always needs either an OpenAI key,
// or a kie.ai key (kie.ai's /codex/v1/responses endpoint proxies the same web_search tool) —
// independent of whichever provider the other SEO tools are set to.
export function getOpenAiKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiKey_openai") || (localStorage.getItem("aiProvider") === "openai" ? localStorage.getItem("aiApiKey") || "" : "");
}
export function getKieKeyForGeo(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiKey_kie") || "";
}

const GEO_ENGINE_KEY = "geoEngine";
export type GeoEngineChoice = "openai" | "kie";
// Which engine to use: an explicit user choice (if both keys are configured), else whichever
// key is actually present, preferring OpenAI (native web_search) when both are set.
export function getGeoEngine(): GeoEngineChoice {
  if (typeof window === "undefined") return "openai";
  const hasOpenAi = !!getOpenAiKey();
  const hasKie = !!getKieKeyForGeo();
  const stored = localStorage.getItem(GEO_ENGINE_KEY) as GeoEngineChoice | null;
  if (stored === "kie" && hasKie) return "kie";
  if (stored === "openai" && hasOpenAi) return "openai";
  if (hasOpenAi) return "openai";
  if (hasKie) return "kie";
  return "openai";
}
export function setGeoEngine(e: GeoEngineChoice) {
  if (typeof window !== "undefined") localStorage.setItem(GEO_ENGINE_KEY, e);
}
export function getGeoApiKey(engine: GeoEngineChoice): string {
  return engine === "kie" ? getKieKeyForGeo() : getOpenAiKey();
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
