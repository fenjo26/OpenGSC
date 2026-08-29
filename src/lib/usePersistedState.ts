"use client";

import { useState } from "react";

// Period-style controls (the dashboard window, report days, decay buckets) used to be bare
// component state: a refresh reset them, no link could carry them, and every screen silently
// started from its own hardcoded default. This hook gives them two stores, read in one order:
//
//   URL param (when `urlParam` is passed)  — a link that says ?period=12m means it, so the
//                                            report a client opens is the report you saw;
//   localStorage (when `key` is passed)    — the last value this browser was set to, the same
//                                            role gsc_sort already plays for sort order;
//   fallback                               — the old hardcoded default, last resort.
//
// Writes go to both stores. The URL write uses history.replaceState rather than the router,
// so changing a period never pushes a history entry (back keeps meaning "previous page") and
// never triggers a Next navigation — the fetch effects keyed on the value do the refetching.
// Reading window.location directly (instead of useSearchParams) keeps pages that have no
// other use for search params out of the Suspense requirement.

export function usePersistedState<T extends string | number>(
  key: string | null,
  fallback: T,
  ok: (v: unknown) => boolean,
  urlParam?: string,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    if (urlParam) {
      const raw = new URLSearchParams(window.location.search).get(urlParam);
      if (raw !== null) {
        const parsed = (typeof fallback === "number" ? Number(raw) : raw) as unknown;
        if (ok(parsed)) return parsed as T;
      }
    }
    if (key) {
      try {
        const stored = window.localStorage.getItem(key);
        if (stored !== null) {
          const parsed = JSON.parse(stored) as unknown;
          if (ok(parsed)) return parsed as T;
        }
      } catch { /* a corrupted preference is no preference */ }
    }
    return fallback;
  });

  const set = (v: T) => {
    setValue(v);
    if (key) {
      try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
    }
    if (urlParam && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set(urlParam, String(v));
      window.history.replaceState(null, "", url);
    }
  };

  return [value, set];
}

// Every GSC window the app offers — the dashboard's "More periods" menu, the site page's
// PERIOD_OPTIONS, and the /api/gsc/portfolio vocabulary all agree on these 17 keys. One
// allow-list, because the dashboard and the site page deliberately share one "last window I
// was working in" value: a URL param or a stored value outside this set falls back to the
// default rather than putting the UI in a state no selector can display.
export const GSC_PERIODS: ReadonlySet<string> = new Set([
  "yesterday", "7d", "14d", "28d", "last_week", "this_month", "last_month",
  "this_quarter", "last_quarter", "ytd", "3m", "6m", "8m", "12m", "16m", "2y", "3y",
]);

export const isGscPeriod = (v: unknown): boolean =>
  typeof v === "string" && GSC_PERIODS.has(v);

// The report panels (striking distance, CTR benchmark, cannibalization, related intent) all
// offer the same day windows and share one stored value — the window you are analysing in is
// one mental knob, so it follows you from the site page's tabs to the standalone report.
// Every read is validated against this list, so a panel can never be handed a number its
// selector cannot display.
export const isReportDays = (v: unknown): boolean =>
  typeof v === "number" && [30, 60, 90, 180].includes(v);

// Standalone report pages accept the window as a query param (?days=90, ?period=week) so a
// report can be shared at the exact window it was read at. The same components embedded on
// the site page take the value as a prop instead — there the URL's ?period= means the GSC
// window, and four panels must not fight over one param.
export function setUrlParam(param: string, value: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(param, value);
  window.history.replaceState(null, "", url);
}
