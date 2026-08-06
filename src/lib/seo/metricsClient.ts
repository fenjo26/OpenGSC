"use client";

// Browser-side resolution of the metrics provider, key, host override and monthly cap.
// Same convention as every other key in this app: it lives in localStorage, is mirrored to
// User.seoSettings by SeoKeysSync, and travels with the request.

import { MetricsProvider, UNIT_PRICE_USD, estimateCostUsd, estimateKeywordUnits, priceExpand, priceEnrich } from "./metrics";

export const METRICS_PROVIDERS: MetricsProvider[] = ["ahrefs", "semrush"];

// Keyword-source pricing is defined in `metrics.ts` and re-exported here so the existing browser
// imports (`priceExpand`/`priceEnrich` from `@/lib/seo/metricsClient`) keep working. The functions
// themselves are pure and provider-aware; they cannot live in this file because the keyword-ideas
// server route also needs them, and this module is `"use client"`.
export { priceExpand, priceEnrich };

// Both moved to `metrics.ts` so the server can price a request without importing this
// `"use client"` module. Re-exported unchanged: every existing import still resolves here.
export { UNIT_PRICE_USD, estimateCostUsd };

/**
 * Where the key came from. This exists because "custom base URL" was a field that told the user
 * nothing: whether you hold an official Ahrefs subscription or credits bought from a reseller is
 * the first thing you know about your own setup, and the settings screen should ask it in those
 * words instead of asking for a hostname.
 *
 * It is presentation only. The mode picks a base URL and writes it to the same storage key the
 * code has always read, so nothing downstream — client, server, or MCP — knows modes exist.
 */
export type MetricsMode = "official" | "reseller" | "custom";

/** Reseller gateways that speak the official API protocol; only the host differs. */
export const RESELLER_BASE_URL: Record<MetricsProvider, string> = {
  ahrefs: "https://ahrefs-api.groupbuyseo.org",
  semrush: "https://api-semrush.groupbuyseo.org",
};

export interface MetricsClientCreds {
  provider: MetricsProvider;
  apiKey: string;
  baseUrl: string;
  cap: number;
}

export function getMetricsProvider(): MetricsProvider {
  if (typeof window === "undefined") return "ahrefs";
  const p = localStorage.getItem("seoMetricsProvider");
  return p === "semrush" ? "semrush" : "ahrefs";
}

export function getMetricsMode(provider?: MetricsProvider): MetricsMode {
  if (typeof window === "undefined") return "official";
  const p = provider ?? getMetricsProvider();
  const m = localStorage.getItem(`seoMetricsMode_${p}`);
  if (m === "reseller" || m === "custom") return m;
  // Anyone who set a base URL before modes existed is on a gateway by definition — inferring it
  // keeps their setup working instead of silently resetting them to the official host.
  return (localStorage.getItem(`seoMetricsBaseUrl_${p}`) || "").trim() ? "custom" : "official";
}

/** Writes the mode and the base URL together, so the two can never disagree. */
export function setMetricsMode(provider: MetricsProvider, mode: MetricsMode, customUrl = "") {
  localStorage.setItem(`seoMetricsMode_${provider}`, mode);
  const key = `seoMetricsBaseUrl_${provider}`;
  if (mode === "official") localStorage.removeItem(key);
  else if (mode === "reseller") localStorage.setItem(key, RESELLER_BASE_URL[provider]);
  else if (customUrl.trim()) localStorage.setItem(key, customUrl.trim());
  else localStorage.removeItem(key);
}

/**
 * Where the key for one provider *and one mode* is stored.
 *
 * An official Ahrefs key and a reseller key are different strings that only work against their
 * own host. Keeping a single cell per provider meant whatever you typed appeared under every
 * mode — so switching modes silently kept a key the new host would reject, and the screen said
 * "Connected" throughout.
 *
 * Official mode keeps the historical `seoKey_<provider>` name so existing installs keep working
 * untouched. The other two get suffixed names under the same prefix, which is what makes them
 * covered by the settings backup for free.
 */
export function metricsKeyStorage(provider: MetricsProvider, mode: MetricsMode): string {
  return mode === "official" ? `seoKey_${provider}` : `seoKey_${provider}__${mode}`;
}

export function getMetricsApiKey(provider: MetricsProvider, mode?: MetricsMode): string {
  if (typeof window === "undefined") return "";
  const m = mode ?? getMetricsMode(provider);
  const own = (localStorage.getItem(metricsKeyStorage(provider, m)) || "").trim();
  if (own || m === "official") return own;
  // Anyone who configured a gateway before the key was split by mode has it in the legacy cell.
  // Falling back keeps them working; the first save in this mode moves it to its own slot.
  return (localStorage.getItem(`seoKey_${provider}`) || "").trim();
}

export function getMetricsCreds(provider?: MetricsProvider): MetricsClientCreds {
  const p = provider ?? getMetricsProvider();
  if (typeof window === "undefined") return { provider: p, apiKey: "", baseUrl: "", cap: 0 };
  return {
    provider: p,
    apiKey: getMetricsApiKey(p),
    // Empty means the official host. Written by setMetricsMode, never typed directly except in
    // custom mode — this stays the single source of truth for where requests go.
    baseUrl: (localStorage.getItem(`seoMetricsBaseUrl_${p}`) || "").trim(),
    cap: Number(localStorage.getItem(`seoMetricsCap_${p}`) || 0) || 0,
  };
}

export function hasMetricsKey(provider?: MetricsProvider): boolean {
  return getMetricsCreds(provider).apiKey.length > 4;
}

/** Whether the KD column is requested — it costs as much as everything else combined. */
export function getMetricsWithKd(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("seoMetricsWithKd") === "1";
}

export function setMetricsWithKd(on: boolean) {
  localStorage.setItem("seoMetricsWithKd", on ? "1" : "0");
}

/** "1 200 units · ≈ $0.03" — the numbers a button needs to be honest about what it spends. */
export function priceKeywordLoad(count: number, withKd: boolean, provider: MetricsProvider) {
  const units = count > 0 ? estimateKeywordUnits(count, withKd) : 0;
  return { units, usd: estimateCostUsd(units, provider) };
}

export function formatUsd(v: number): string {
  if (v <= 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}
