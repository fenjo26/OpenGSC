"use client";

// Readiness for the SERP credential currently selected in the browser.
//
// Metered providers are ready as soon as they have a key. SearXNG is keyless, so readiness is a
// server question: the deep status endpoint (a real search) decides it. Until that answer
// arrives we treat SearXNG as ready to avoid flashing "missing key" at a working instance; a
// failed probe flips it back and the usual warning appears.

import { useEffect, useState } from "react";
import { serpProviderNeedsKey } from "@/lib/seo/serpReadiness";

export interface ClientSerpCreds {
  provider: string;
  apiKey?: string;
}

export function useSerpReadiness(creds: ClientSerpCreds): boolean {
  const needsKey = serpProviderNeedsKey(creds.provider);
  const [searxngOk, setSearxngOk] = useState(true);

  useEffect(() => {
    if (needsKey || creds.provider !== "searxng") return;
    let alive = true;
    setSearxngOk(true);
    fetch("/api/seo/serp/searxng/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean } | null) => {
        if (alive) setSearxngOk(!!data?.ok);
      })
      .catch(() => {
        if (alive) setSearxngOk(false);
      });
    return () => {
      alive = false;
    };
  }, [creds.provider, needsKey]);

  if (!needsKey) return creds.provider === "searxng" ? searxngOk : true;
  return String(creds.apiKey ?? "").trim().length > 0;
}
