"use client";

// Browser-side resolution of the metrics provider, key, host override and monthly cap.
// Same convention as every other key in this app: it lives in localStorage, is mirrored to
// User.seoSettings by SeoKeysSync, and travels with the request.

import { MetricsProvider, estimateKeywordUnits } from "./metrics";

export const METRICS_PROVIDERS: MetricsProvider[] = ["ahrefs", "semrush"];

/** Published gateway rates, used only to show the user what a click will cost. */
export const UNIT_PRICE_USD: Record<MetricsProvider, number> = {
  ahrefs: 0.000025,
  semrush: 0.00006,
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

export function getMetricsCreds(provider?: MetricsProvider): MetricsClientCreds {
  const p = provider ?? getMetricsProvider();
  if (typeof window === "undefined") return { provider: p, apiKey: "", baseUrl: "", cap: 0 };
  return {
    provider: p,
    apiKey: (localStorage.getItem(`seoKey_${p}`) || "").trim(),
    // Empty means the official host. A group-buy or self-hosted gateway goes here; the API
    // paths are identical either way, so nothing else in the app needs to know the difference.
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

export function estimateCostUsd(units: number, provider: MetricsProvider): number {
  return units * (UNIT_PRICE_USD[provider] ?? 0);
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
