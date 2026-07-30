"use client";

// Shared "keyword weights" behaviour for any table of keywords: read the cache for free on
// render, load the missing ones only when the user asks, price the request before it is sent.
//
// This exists as a hook rather than as copied code because the two consumers differ in exactly
// one way that matters — Striking Distance asks about one market chosen in the toolbar, while
// Rank Tracker's keywords each carry their own country — and that difference is precisely where
// a duplicated implementation would drift. Cache keys are (keyword, country), so a version that
// assumed a single country would silently serve German volumes for US keywords.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getMetricsCreds, getMetricsWithKd, setMetricsWithKd } from "./metricsClient";

export interface KeywordWeight {
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  parentTopic: string | null;
  source: "api" | "csv";
  checkedAt: string;
}

export interface WeightTarget {
  keyword: string;
  country: string;
}

/** Must match `normalizeKeyword` on the server, or paid rows never match the row that wants them. */
export const wKey = (keyword: string, country: string) =>
  `${country.toLowerCase()}|${keyword.trim().toLowerCase()}`;

export interface UseKeywordWeights {
  weights: Record<string, KeywordWeight>;
  get: (keyword: string, country: string) => KeywordWeight | undefined;
  total: number;
  covered: number;
  missing: number;
  busy: boolean;
  notice: string;
  hasKey: boolean;
  withKd: boolean;
  setWithKd: (v: boolean) => void;
  load: () => Promise<void>;
}

export function useKeywordWeights(
  targets: WeightTarget[],
  opts: { enabled?: boolean; onError?: (code: string) => string } = {},
): UseKeywordWeights {
  const enabled = opts.enabled !== false;

  const [weights, setWeights] = useState<Record<string, KeywordWeight>>({});
  const [withKd, setWithKdS] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    setWithKdS(getMetricsWithKd());
    setHasKey(getMetricsCreds().apiKey.length > 4);
  }, []);

  const setWithKd = (v: boolean) => { setWithKdS(v); setMetricsWithKd(v); };

  // Group by market: one request per country, because that is the granularity the cache and
  // the provider both work at.
  const byCountry = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of targets) {
      const kw = t.keyword.trim().toLowerCase();
      const c = (t.country || "us").toLowerCase();
      if (!kw) continue;
      const list = map.get(c) ?? [];
      if (!list.includes(kw)) list.push(kw);
      map.set(c, list);
    }
    return map;
  }, [targets]);

  // A stable identity for the effect below — the Map itself is new on every render.
  const groupSig = useMemo(
    () => [...byCountry.entries()].map(([c, ks]) => `${c}:${ks.length}:${ks[0] ?? ""}`).join("|"),
    [byCountry],
  );

  const request = useCallback(async (doFetch: boolean) => {
    const creds = getMetricsCreds();
    const merged: Record<string, KeywordWeight> = {};

    for (const [country, keywords] of byCountry.entries()) {
      if (!keywords.length) continue;
      const body: Record<string, unknown> = {
        keywords, country, provider: creds.provider, fetch: doFetch,
      };
      if (doFetch) {
        Object.assign(body, {
          withDifficulty: withKd, apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap,
        });
      }
      const res = await fetch("/api/metrics/keywords", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      for (const [kw, w] of Object.entries(d.metrics ?? {})) merged[wKey(kw, country)] = w as KeywordWeight;
      // The first failure wins the notice: a per-country error list would be noise, and every
      // realistic cause (bad key, cap reached, provider down) applies to all of them equally.
      if (!res.ok && doFetch && !notice) {
        setNotice(opts.onError?.(String(d.error ?? "error")) ?? String(d.error ?? "error"));
      }
    }
    setWeights(merged);
  }, [byCountry, withKd, notice, opts]);

  // Free cache read. `fetch: false` cannot reach a provider, so this is safe on every render
  // and is what makes imported CSV data show up with no key configured.
  useEffect(() => {
    if (!enabled || !byCountry.size) { setWeights({}); return; }
    request(false).catch(() => { /* the table works without weights */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupSig, enabled]);

  const get = useCallback(
    (keyword: string, country: string) => weights[wKey(keyword, country)],
    [weights],
  );

  const total = useMemo(() => [...byCountry.values()].reduce((n, ks) => n + ks.length, 0), [byCountry]);

  const missing = useMemo(() => {
    let n = 0;
    for (const [country, keywords] of byCountry.entries()) {
      for (const kw of keywords) {
        const w = weights[wKey(kw, country)];
        // A row fetched without KD does not satisfy a request that now wants it.
        if (!w || (withKd && w.difficulty == null)) n++;
      }
    }
    return n;
  }, [byCountry, weights, withKd]);

  const load = useCallback(async () => {
    if (busy) return;
    setBusy(true); setNotice("");
    try { await request(true); }
    catch { setNotice(opts.onError?.("error") ?? "error"); }
    setBusy(false);
  }, [busy, request, opts]);

  return { weights, get, total, covered: total - missing, missing, busy, notice, hasKey, withKd, setWithKd, load };
}
