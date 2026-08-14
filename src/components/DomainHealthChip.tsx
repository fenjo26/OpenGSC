"use client";

// Domain Rating and referring domains for an arbitrary domain, in one small inline control.
//
// Built for the Indexer, where the question is asked before any work is done: a dropped domain
// with no live link profile is worth nothing, and finding that out after generating content and
// pointing a network at it is the expensive way to learn it. One check costs a fraction of a
// cent; one bad domain in a network costs considerably more.
//
// DR always comes from the free public endpoint, so the useful half of this works with no key
// at all. The paid half only fills in when a key exists and the user asks.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Activity } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getMetricsCreds } from "@/lib/seo/metricsClient";
import { getAhrefsDrKey } from "@/lib/seo/keys";

interface State {
  dr: number | null;
  refDomains: number | null;
  backlinks: number | null;
  loaded: boolean;
}

// Theme variables, not literals: the palette flips between light and dark, and a hardcoded
// green that reads well on #000 is unreadable on the light canvas.
function drColor(dr: number) {
  if (dr >= 50) return "var(--color-success)";
  if (dr >= 25) return "var(--color-accent-green)";
  if (dr >= 10) return "var(--color-warning)";
  return "var(--color-danger)";
}

export default function DomainHealthChip({ domain, compact = false }: { domain: string; compact?: boolean }) {
  const { t } = useLanguage();
  const [state, setState] = useState<State>({ dr: null, refDomains: null, backlinks: null, loaded: false });
  const [busy, setBusy] = useState(false);

  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

  // Cache-only read on mount: free for both halves, so a domain checked once stays annotated.
  const read = useCallback(async () => {
    if (!clean.includes(".")) return;
    try {
      const [drRes, mRes] = await Promise.all([
        fetch(`/api/dr?domains=${encodeURIComponent(clean)}&cacheOnly=1`, { headers: { "x-ahrefs-dr-key": getAhrefsDrKey() } }),
        fetch("/api/metrics/domain", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domains: [clean], fetch: false }),
        }),
      ]);
      const dr = drRes.ok ? (await drRes.json())?.ratings?.[clean]?.dr ?? null : null;
      const m = mRes.ok ? (await mRes.json())?.metrics?.[clean] ?? null : null;
      setState({
        dr: dr == null ? null : Number(dr),
        refDomains: m?.refDomains ?? null,
        backlinks: m?.backlinks ?? null,
        loaded: dr != null || !!m,
      });
    } catch { /* the row is fine without this */ }
  }, [clean]);

  useEffect(() => { read(); }, [read]);

  async function check() {
    if (busy) return;
    setBusy(true);
    const creds = getMetricsCreds();
    try {
      // The free DR call happens regardless; the paid one is skipped without a key rather than
      // erroring, so pressing this with no key still tells you something.
      await fetch(`/api/dr?domains=${encodeURIComponent(clean)}`, { headers: { "x-ahrefs-dr-key": getAhrefsDrKey() } });
      if (creds.apiKey) {
        await fetch("/api/metrics/domain", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domains: [clean], fetch: true,
            provider: creds.provider, apiKey: creds.apiKey, baseUrl: creds.baseUrl, cap: creds.cap,
          }),
        });
      }
      await read();
    } catch { /* ignore */ }
    setBusy(false);
  }

  if (!clean.includes(".")) return null;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
      {state.dr != null && (
        <span className="metric-chip"
          style={{ background: `color-mix(in srgb, ${drColor(state.dr)} 14%, transparent)`, color: drColor(state.dr) }}
          title="Domain Rating by Ahrefs (ahrefs.com)">DR {Math.round(state.dr)}</span>
      )}
      {state.refDomains != null && <span className="metric-chip">RD {Math.round(state.refDomains)}</span>}
      {/* Not .metric-action: the free DR half always runs, so this is not unambiguously a
          spend. It stays a quiet ghost control. */}
      <button className="metric-chip" onClick={check} disabled={busy} title={t("idxDomainMetrics")}
        style={{ border: "1px solid var(--color-border)", background: "transparent", fontWeight: 500, cursor: busy ? "wait" : "pointer" }}>
        {busy ? <Loader2 size={9} className="spin" /> : <Activity size={9} />}
        {!compact && t("idxCheckDomain")}
      </button>
    </span>
  );
}
