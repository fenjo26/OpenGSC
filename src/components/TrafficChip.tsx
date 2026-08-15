"use client";

// Estimated traffic for a domain, as one chip beside the DR badge.
//
// This is the app's only view of traffic it does not own. Search Console answers "how am I doing
// in Google"; this answers "how big is this domain, and where do its visits come from" — for any
// domain, including the ones you are losing to.
//
// Two behaviours are deliberate:
//
// 1. **Nothing is bought on render.** Mounting reads the server cache and nothing else, so the
//    chip is free on every page load and stays annotated once a domain has been checked. Fetching
//    costs credits and therefore happens only when someone presses the button — the same rule
//    `keywordSource.ts` enforces for keyword data, and for the same reason: a dashboard that
//    spends money when you open it is a dashboard you learn to avoid.
//
// 2. **The GenAI share is shown, not buried.** It is the one number here that no other tool in
//    this app can produce, and it is the other half of the AEO module's question: being cited in
//    AI answers only matters if it sends anyone.

import { useCallback, useEffect, useState } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getGoAnyKey } from "@/lib/seo/keys";
import type { DomainTraffic } from "@/lib/seo/goanyapi";

/** 48 954 756 → "49M". Precision past two significant figures is noise on an estimate. */
function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;

export default function TrafficChip({
  domain, shareToken, style,
}: { domain: string; shareToken?: string; style?: React.CSSProperties }) {
  const { t } = useLanguage();
  const [data, setData] = useState<DomainTraffic | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);

  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const url = (extra: string) =>
    `/api/traffic?domain=${encodeURIComponent(clean)}${extra}${shareToken ? `&shareToken=${shareToken}` : ""}`;

  // localStorage is only readable after mount; a guest with a share link has no key at all and
  // must never see a button that would spend the owner's credits.
  useEffect(() => { setHasKey(!shareToken && getGoAnyKey().trim().length > 4); }, [shareToken]);

  const readCache = useCallback(async () => {
    if (!clean.includes(".")) return;
    try {
      const res = await fetch(url("&cacheOnly=1"));
      if (!res.ok) return;
      const d = await res.json();
      if (d?.traffic) { setData(d.traffic); setCheckedAt(d.checkedAt ?? null); }
    } catch { /* the header is fine without this */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clean, shareToken]);

  useEffect(() => { readCache(); }, [readCache]);

  async function check() {
    if (busy || !hasKey) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(url(""), { headers: { "x-goanyapi-key": getGoAnyKey() } });
      const d = await res.json();
      if (d?.traffic) { setData(d.traffic); setCheckedAt(d.checkedAt ?? null); }
      // The provider's own reason, not a generic failure: `insufficient_credits` and `bad_key`
      // send the user to two different screens.
      else setErr(String(d?.error ?? "no_data"));
    } catch { setErr("network"); }
    setBusy(false);
  }

  if (!clean.includes(".")) return null;

  if (!data) {
    if (!hasKey) return null; // nothing cached and no key — say nothing rather than advertise
    return (
      <button
        onClick={check} disabled={busy}
        title={err ? `${t("trafficCheckTitle")} — ${err}` : t("trafficCheckTitle")}
        style={{
          display: "flex", alignItems: "center", gap: "4px", flexShrink: 0,
          fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "6px",
          border: "1px solid var(--color-border)", background: "transparent",
          color: err ? "var(--color-warning)" : "var(--color-text-secondary)",
          cursor: busy ? "default" : "pointer", ...style,
        }}>
        {busy ? <Loader2 size={11} className="spin" /> : <TrendingUp size={11} />}
        {t("trafficCheckBtn")}
      </button>
    );
  }

  const genAI = data.sources?.genAI;
  return (
    <span
      title={[
        checkedAt ? `${t("trafficAsOf")} ${new Date(checkedAt).toLocaleDateString()}` : "",
        data.period ? `${t("trafficPeriod")} ${data.period}` : "",
        data.globalRank ? `#${data.globalRank} global` : "",
      ].filter(Boolean).join(" · ")}
      style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0, ...style }}>
      <span style={{
        fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "6px",
        background: "rgba(16,163,127,0.12)", color: "#10A37F",
      }}>
        {data.visits != null ? compact(data.visits) : "—"} {t("trafficVisitsLabel")}
      </span>
      {genAI != null && genAI > 0 && (
        <span
          title={t("trafficGenAiTitle")}
          style={{
            fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "6px",
            background: "rgba(124,58,237,0.12)", color: "#7C3AED",
          }}>
          GenAI {pct(genAI)}
        </span>
      )}
    </span>
  );
}
