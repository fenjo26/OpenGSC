"use client";

// Estimated traffic for a domain, rendered as one more metric in the dashboard strip.
//
// The app measures plenty through Search Console; this answers "how big is this domain, and
// where do its visits come from" for any domain, including the ones you are losing to. The
// GenAI share is shown beside the value — it is the one number here no other tool produces,
// the other half of the AEO module's question.
//
// Three behaviours are deliberate:
//
// 1. **Nothing is bought on render.** Mounting reads the server cache and nothing else, so the
//    slot is free on every page load and stays annotated once a domain has been checked.
//    Fetching costs credits and happens only on click.
// 2. **The slot always renders** — an empty dash with a tooltip beats an invisible feature.
//    The tooltip carries whatever is known: which key to enter, what failed, how old the
//    figure is.
// 3. **The source is named, and when two keys exist, choosable.** GoAnyAPI and Semrush TA are
//    two vendors estimating the same truth; their figures disagree by design. The cache keeps
//    one row per provider, so switching sources costs one press, not a refetch.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, TrendingUp } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getGoAnyKey } from "@/lib/seo/keys";
import { getMetricsCreds } from "@/lib/seo/metricsClient";
import type { DomainTraffic } from "@/lib/seo/goanyapi";

type TrafficProvider = "goanyapi" | "semrush";

const PROVIDER_LABEL: Record<TrafficProvider, string> = {
  goanyapi: "GoAnyAPI",
  semrush: "Semrush TA",
};

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
  const [provider, setProvider] = useState<TrafficProvider | null>(null);
  const [busy, setBusy] = useState<TrafficProvider | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [goanyKey, setGoanyKey] = useState("");
  const [semrushKey, setSemrushKey] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const url = (extra: string) =>
    `/api/traffic?domain=${encodeURIComponent(clean)}${extra}${shareToken ? `&shareToken=${shareToken}` : ""}`;

  // localStorage is only readable after mount; a guest with a share link has no keys at all
  // and must never see a control that would spend the owner's credits.
  useEffect(() => {
    if (shareToken) return;
    setGoanyKey(getGoAnyKey().trim());
    setSemrushKey(getMetricsCreds("semrush").apiKey.trim());
  }, [shareToken]);

  const readCache = useCallback(async () => {
    if (!clean.includes(".")) return;
    try {
      const res = await fetch(url("&cacheOnly=1"));
      if (!res.ok) return;
      const d = await res.json();
      if (d?.traffic) {
        setData(d.traffic);
        setCheckedAt(d.checkedAt ?? null);
        setProvider(d.traffic.provider === "semrush" ? "semrush" : "goanyapi");
      }
    } catch { /* the strip is fine without this */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clean, shareToken]);

  useEffect(() => { readCache(); }, [readCache]);

  const fetchFrom = useCallback(async (p: TrafficProvider) => {
    if (busy) return;
    setBusy(p); setErr(null); setMenuOpen(false);
    try {
      const headers: Record<string, string> = {};
      if (goanyKey) headers["x-goanyapi-key"] = goanyKey;
      if (semrushKey) {
        headers["x-semrush-key"] = semrushKey;
        const base = getMetricsCreds("semrush").baseUrl;
        if (base) headers["x-semrush-baseurl"] = base;
      }
      const res = await fetch(url(`&provider=${p}`), { headers });
      const d = await res.json();
      if (d?.traffic) {
        setData(d.traffic);
        setCheckedAt(d.checkedAt ?? null);
        setProvider(d.traffic.provider === "semrush" ? "semrush" : "goanyapi");
      } else {
        // The provider's own reason, named: "no data" from Semrush TA and from GoAnyAPI are
        // two different walls, and a tooltip that labels the wall saves a retry against the
        // wrong one.
        const who = d?.provider ? PROVIDER_LABEL[d.provider as TrafficProvider] + ": " : "";
        setErr(who + String(d?.error ?? "no_data"));
      }
    } catch { setErr("network"); }
    setBusy(null);
  }, [busy, goanyKey, semrushKey, clean, shareToken]);

  // Which source a plain click answers with: Semrush when its key exists — its calls are
  // effectively free where GoAnyAPI spends credits — otherwise the only key there is.
  const defaultProvider: TrafficProvider | null = useMemo(() => {
    if (semrushKey) return "semrush";
    if (goanyKey) return "goanyapi";
    return null;
  }, [semrushKey, goanyKey]);
  const bothKeys = !!semrushKey && !!goanyKey;
  const noKey = !goanyKey && !semrushKey;

  if (!clean.includes(".")) return null;

  const genAI = data?.sources?.genAI;
  const src = provider === "semrush" ? "Semrush TA" : provider === "goanyapi" ? "GoAnyAPI" : "";
  const value = data?.visits != null ? compact(data.visits) : "—";
  // The dash reads by color: tertiary = not looked up yet, warning = looked up and failed.
  const valueColor = err ? "var(--color-warning)" : data ? "var(--color-text-primary)" : "var(--color-text-tertiary)";

  const title = err
    ? `${t("trafficCheckTitle")} — ${err === "no_data" || err.endsWith(": no_data") ? t("trafficNoData") : err}`
    : data
      ? [
          src,
          checkedAt ? `${t("trafficAsOf")} ${new Date(checkedAt).toLocaleDateString()}` : "",
          data.period ? `${t("trafficPeriod")} ${data.period}` : "",
          data.globalRank ? `#${data.globalRank} global` : "",
        ].filter(Boolean).join(" · ")
      : noKey && !shareToken
        ? t("trafficNoKeyHint")
        : `${t("trafficCheckTitle")} — ${defaultProvider === "semrush" ? "Semrush TA, 1 unit" : "GoAnyAPI"}`;

  const canLoad = !data && !busy && !!defaultProvider;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", flexShrink: 0, position: "relative", ...style }}>
      <span
        onClick={() => { if (canLoad) fetchFrom(defaultProvider!); }}
        title={title}
        style={{ display: "inline-flex", alignItems: "center", gap: "5px", cursor: canLoad ? "pointer" : "default" }}>
        {busy ? <Loader2 size={14} className="spin" /> : <TrendingUp size={14} style={{ color: data ? "#10A37F" : "var(--color-text-tertiary)" }} />}
        <span style={{ fontSize: "22px", fontWeight: 700, color: valueColor }}>{busy ? "…" : value}</span>
      </span>
      {genAI != null && genAI > 0 && (
        <span
          title={t("trafficGenAiTitle")}
          style={{ fontSize: "11px", fontWeight: 600, color: "#7C3AED" }}>
          AI {pct(genAI)}
        </span>
      )}
      {/* With both keys configured the caret picks the vendor; the cache keeps both answers,
          so switching back is free. */}
      {bothKeys && (
        <>
          <button onClick={() => setMenuOpen(o => !o)} title={t("trafficSourceMenu")}
            style={{ display: "flex", alignItems: "center", padding: "1px", background: "transparent",
              border: "none", color: "var(--color-text-tertiary)", cursor: "pointer" }}>
            <ChevronDown size={12} />
          </button>
          {menuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setMenuOpen(false)} />
              <div style={{
                position: "absolute", top: "100%", left: 0, marginTop: "4px", zIndex: 50,
                background: "var(--color-card)", border: "1px solid var(--color-border)",
                borderRadius: "8px", padding: "4px", minWidth: "150px", boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              }}>
                {(["semrush", "goanyapi"] as const).map(srcAlt => (
                  <button key={srcAlt} onClick={() => fetchFrom(srcAlt)}
                    style={{
                      display: "flex", alignItems: "center", gap: "6px", width: "100%", textAlign: "left",
                      padding: "7px 9px", fontSize: "12px", borderRadius: "6px", border: "none",
                      background: "transparent", color: "var(--color-text-primary)", cursor: "pointer",
                    }}>
                    {PROVIDER_LABEL[srcAlt]}
                    {provider === srcAlt && <span style={{ color: "#10B981", fontSize: "11px" }}>✓</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </span>
  );
}
