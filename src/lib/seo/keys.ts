// Client-side helpers to read API keys / settings from localStorage.
// Mirrors the app convention: keys live in the browser and are sent per-request.
"use client";

import { EditorialPolicy, DEFAULT_POLICY, normalizePolicy } from "./policy";

export function getAiCreds(): { provider: string; apiKey: string } {
  if (typeof window === "undefined") return { provider: "anthropic", apiKey: "" };
  const provider = localStorage.getItem("aiProvider") || "anthropic";
  const apiKey = localStorage.getItem(`aiKey_${provider}`) || localStorage.getItem("aiApiKey") || "";
  return { provider, apiKey };
}

export const AI_PROVIDER_IDS = ["anthropic", "openai", "gemini", "openrouter", "zai", "kimi", "kie", "custom"] as const;
export const AI_PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini", openrouter: "OpenRouter", zai: "Z.AI", kimi: "Kimi (Moonshot AI)", kie: "Kie.ai (GPT-5.5)", custom: "Custom (OpenAI-compatible)",
};

// Per-provider model chosen in Settings → API Keys (aiModel_<provider>); empty = provider default.
export function getProviderModel(provider: string): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(`aiModel_${provider}`) || "";
}

// Custom OpenAI-compatible provider (e.g. kie.ai): base URL + key + default model, stored separately.
export function getCustomProvider(): { baseUrl: string; apiKey: string; model: string } {
  if (typeof window === "undefined") return { baseUrl: "", apiKey: "", model: "" };
  return {
    baseUrl: localStorage.getItem("aiBaseUrl_custom") || "",
    apiKey: localStorage.getItem("aiKey_custom") || "",
    model: localStorage.getItem("aiModel_custom") || "",
  };
}

// Providers the user has configured a key for (for the live model selector).
export function getConfiguredProviders(): { id: string; key: string }[] {
  if (typeof window === "undefined") return [];
  return AI_PROVIDER_IDS
    .map(id => ({ id, key: localStorage.getItem(`aiKey_${id}`) || "" }))
    .filter(p => p.key.trim().length > 4);
}

// SEO task IDs that can each have their own default provider/model.
export type SeoTask = "outline" | "text" | "analysis" | "policy" | "landing";

// Per-task resolved creds: a task-specific default (set once in SEO settings) overrides the global
// SEO provider. For the custom provider, also returns baseUrl. Falls back gracefully at each level.
export function getTaskCreds(task: SeoTask): { provider: string; apiKey: string; model: string; baseUrl?: string } {
  if (typeof window === "undefined") return { provider: "anthropic", apiKey: "", model: "" };
  const provider = localStorage.getItem(`seoTaskProvider_${task}`) || localStorage.getItem("seoProvider") || localStorage.getItem("aiProvider") || "anthropic";
  if (provider === "custom") {
    const c = getCustomProvider();
    const model = localStorage.getItem(`seoTaskModel_${task}`) || c.model;
    return { provider, apiKey: c.apiKey, model, baseUrl: c.baseUrl };
  }
  const apiKey = localStorage.getItem(`aiKey_${provider}`) || localStorage.getItem("aiApiKey") || "";
  const model = localStorage.getItem(`seoTaskModel_${task}`) || localStorage.getItem("seoModel") || getProviderModel(provider);
  return { provider, apiKey, model };
}

// Resolved creds for SEO generation: a SEO-specific provider override (seoProvider)
// can differ from the global aiProvider; falls back to it when unset.
export function getSeoGenCreds(): { provider: string; apiKey: string; model: string } {
  if (typeof window === "undefined") return { provider: "anthropic", apiKey: "", model: "" };
  const provider = localStorage.getItem("seoProvider") || localStorage.getItem("aiProvider") || "anthropic";
  const apiKey = localStorage.getItem(`aiKey_${provider}`) || localStorage.getItem("aiApiKey") || "";
  const model = localStorage.getItem("seoModel") || getProviderModel(provider);
  return { provider, apiKey, model };
}

export function getSerpCreds(): { provider: string; apiKey: string } {
  if (typeof window === "undefined") return { provider: "serper", apiKey: "" };
  const provider = localStorage.getItem("seoSerpProvider") || "serper";
  const apiKey = localStorage.getItem(`seoKey_${provider}`) || "";
  return { provider, apiKey };
}

export function getFirecrawlKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("seoKey_firecrawl") || "";
}

// Kie.ai's image-generation jobs API (GPT Image-2, Nano Banana 2) uses the same account/key as
// the "kie" chat provider above — read straight from its key slot, no separate settings needed.
export function getKieKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("aiKey_kie") || "";
}

// DataForSEO key specifically (Keywords Data / Labs need DataForSEO, regardless of active SERP provider).
export function getDataForSeoKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("seoKey_dataforseo") || "";
}

// ─── Keyword data source ────────────────────────────────────────────────────────
//
// The setting the app was missing. There was a selector for who scrapes the SERP
// (`seoSerpProvider`) and one for whose metrics feed the analytics screens
// (`seoMetricsProvider`), but none for where the content tools get volumes and difficulty — they
// simply used DataForSEO if a key happened to exist. Scraping with Serper and holding an Ahrefs
// key therefore meant no keyword data anywhere, silently.

export type KwSourceSetting = "auto" | "ahrefs" | "semrush" | "dataforseo" | "off";

export function getKwSourceSetting(): KwSourceSetting {
  if (typeof window === "undefined") return "auto";
  const v = localStorage.getItem("seoKwSource");
  return v === "ahrefs" || v === "semrush" || v === "dataforseo" || v === "off" ? v : "auto";
}

export function setKwSourceSetting(v: KwSourceSetting) {
  localStorage.setItem("seoKwSource", v);
}

/** Pull keyword data automatically after a SERP, or only when the user presses the button. */
export function getKwAuto(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("seoKwAuto") === "1";
}
export function setKwAuto(on: boolean) { localStorage.setItem("seoKwAuto", on ? "1" : "0"); }

/** How many ideas to request. This is the ceiling on what a single expansion can cost. */
export function getKwLimit(): number {
  if (typeof window === "undefined") return 100;
  const n = parseInt(localStorage.getItem("seoKwLimit") ?? "100", 10);
  return Number.isFinite(n) ? Math.max(50, Math.min(200, n)) : 100;
}
export function setKwLimit(n: number) {
  localStorage.setItem("seoKwLimit", String(Math.max(50, Math.min(200, n))));
}

/**
 * Resolved source, key and host for the content tools.
 *
 * `auto` walks Ahrefs → Semrush → DataForSEO by which key actually exists, then gives up as
 * `off`. It reads the metrics module's own storage rather than duplicating it, so switching
 * between an official and a reseller key in Settings → SEO Metrics moves this too, and there is
 * no second place where a stale host can hide.
 */
/**
 * The resolved source is never `"auto"` — that is a preference, not a provider. Typed as the
 * narrower union so callers that price a request cannot be handed a value there is no price for.
 */
export type KwResolvedSource = Exclude<KwSourceSetting, "auto">;

export function getKeywordSource(): { source: KwResolvedSource; apiKey: string; baseUrl?: string } {
  if (typeof window === "undefined") return { source: "off", apiKey: "" };

  const metricsKey = (p: "ahrefs" | "semrush") => {
    const mode = localStorage.getItem(`seoMetricsMode_${p}`);
    const suffixed = mode === "reseller" || mode === "custom" ? `seoKey_${p}__${mode}` : `seoKey_${p}`;
    return (localStorage.getItem(suffixed) || localStorage.getItem(`seoKey_${p}`) || "").trim();
  };
  const metricsHost = (p: "ahrefs" | "semrush") =>
    (localStorage.getItem(`seoMetricsBaseUrl_${p}`) || "").trim() || undefined;

  const setting = getKwSourceSetting();
  if (setting === "off") return { source: "off", apiKey: "" };

  const candidates: KwSourceSetting[] = setting === "auto"
    ? ["ahrefs", "semrush", "dataforseo"]
    : [setting];

  for (const c of candidates) {
    if (c === "dataforseo") {
      const k = getDataForSeoKey().trim();
      if (k) return { source: "dataforseo", apiKey: k };
      continue;
    }
    const p = c as "ahrefs" | "semrush";
    const k = metricsKey(p);
    if (k.length > 4) return { source: p, apiKey: k, baseUrl: metricsHost(p) };
  }

  // An explicit choice with no key is reported as that choice with an empty key, so the UI can
  // say "Ahrefs is selected but not configured" instead of silently behaving like `off`.
  return { source: setting === "auto" ? "off" : setting, apiKey: "" };
}

// ─── Fact-check / enrichment preferences ────────────────────────────────────────
export function getAutoFactcheck(): boolean {
  if (typeof window === "undefined") return false;
  return (localStorage.getItem("seoAutoFactcheck") ?? "1") !== "0";
}
export function getAutoImages(): boolean {
  if (typeof window === "undefined") return false;
  return (localStorage.getItem("seoAutoImages") ?? "1") !== "0";
}
export function getHardRedact(): boolean {
  if (typeof window === "undefined") return false;
  return (localStorage.getItem("seoHardRedact") ?? "0") === "1";
}
export function getFactSourceCount(): number {
  if (typeof window === "undefined") return 6;
  const n = parseInt(localStorage.getItem("seoFactSources") ?? "6", 10);
  return isNaN(n) ? 6 : Math.max(0, Math.min(10, n));
}
// Cost saver #2: fact-check only sections that contain verifiable facts (default ON — no quality loss).
export function getFactBearingOnly(): boolean {
  if (typeof window === "undefined") return true;
  return (localStorage.getItem("seoFactBearingOnly") ?? "1") !== "0";
}
// Cost saver #1: verify all sections against ONE shared competitor corpus instead of a live
// SERP per section (default OFF — keeps max-freshness live mode unless the user opts in).
export function getFactReuseCorpus(): boolean {
  if (typeof window === "undefined") return false;
  return (localStorage.getItem("seoFactReuseCorpus") ?? "0") === "1";
}

// Optional stronger model for outline/analysis (Anthropic only). Empty = provider default.
export function getSeoModel(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("seoModel") || "";
}

// ─── Editorial policies (stored as a named list) ────────────────────────────────
const POLICY_KEY = "seoPolicies";

export function loadPolicies(): EditorialPolicy[] {
  if (typeof window === "undefined") return [DEFAULT_POLICY];
  try {
    const raw = localStorage.getItem(POLICY_KEY);
    if (!raw) return [DEFAULT_POLICY];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr.map(normalizePolicy) : [DEFAULT_POLICY];
  } catch {
    return [DEFAULT_POLICY];
  }
}

export function savePolicies(policies: EditorialPolicy[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(POLICY_KEY, JSON.stringify(policies));
}

export function getActivePolicyName(): string {
  if (typeof window === "undefined") return "Default";
  return localStorage.getItem("seoActivePolicy") || "Default";
}

export function setActivePolicyName(name: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem("seoActivePolicy", name);
}
