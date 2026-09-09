"use client";

// Estimated traffic for a domain, as one chip beside the DR badge.
//
// This is the app's only view of traffic it does not own. Search Console answers "how am I doing
// in Google"; this answers "how big is this domain, and where do its visits come from" — for any
// domain, including the ones you are losing to.
//
// Three behaviours are deliberate:
//
// 1. **Nothing is bought on render.** Mounting reads the server cache and nothing else, so the
//    chip is free on every page load and stays annotated once a domain has been checked. Fetching
//    costs units and therefore happens only when someone presses the button — the same rule
//    `keywordSource.ts` enforces for keyword data, and for the same reason: a dashboard that
//    spends money when you open it is a dashboard you learn to avoid.
//
// 2. **The chip is always visible for the owner.** It used to render nothing without a key,
 //   which read as a feature that does not exist. Without a key it shows a hint instead —
 //   which key to enter and where — and disappears only for share-link guests, who cannot
//    configure anything.
//
// 3. **The source is named, and when two keys exist, choosable.** GoAnyAPI and Semrush TA are
//    two vendors estimating the same truth; their figures disagree by design. The chip labels
//    which one answered, and with both keys configured a small menu lets the owner ask the
//    other — the cache keeps one row per provider, so comparing costs one press, not a refetch
//    of the first.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ExternalLink, Loader2, TrendingUp } from "lucide-react";
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

  // localStorage is only readable after mount; a guest with a share link has no keys at all and
  // must never see a button that would spend the owner's credits.
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
    } catch { /* the header is fine without this */ }
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
      }
      // The provider's own reason, not a generic failure: `insufficient_credits` and `bad_key`
      // send the user to two different screens — and the failing source is named, because
      // "no data" from Semrush TA and from GoAnyAPI are two different walls.
      else setErr(`${d?.provider ? PROVIDER_LABEL[d.provider as TrafficProvider] + ": " : ""}${String(d?.error ?? "no_data")}`);
    } catch { setErr("network"); }
    setBusy(null);
  }, [busy, goanyKey, semrushKey, clean, shareToken]);

  // Which source a plain press answers with: Semrush when its key exists — its calls are
  // effectively free where GoAnyAPI spends credits — otherwise the only key there is.
  const defaultProvider: TrafficProvider | null = useMemo(() => {
    if (semrushKey) return "semrush";
    if (goanyKey) return "goanyapi";
    return null;
  }, [semrushKey, goanyKey]);
  const bothKeys = !!semrushKey && !!goanyKey;

  if (!clean.includes(".")) return null;

  // Guests without cached data see nothing: they cannot add a key, so a hint would be noise.
  if (!data && !shareToken && !defaultProvider) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0, ...style }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600,
          padding: "2px 7px", borderRadius: "6px", border: "1px dashed var(--color-border)",
          color: "var(--color-text-tertiary)", cursor: "default",
        }}>
          <TrendingUp size={11} /> Traffic
        </span>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px",
          color: "var(--color-text-tertiary)",
        }}>
          {t("trafficNoKeyHint")}
          <a href="/settings?tab=metrics" title={t("blsrcConfigure")}
            style={{ display: "inline-flex", alignItems: "center", color: "var(--color-accent-blue)", textDecoration: "none" }}>
            {t("blsrcConfigure")} <ExternalLink size={10} style={{ marginLeft: "2px" }} />
          </a>
        </span>
      </span>
    );
  }

  if (!data) {
    const p = defaultProvider;
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "2px", flexShrink: 0, position: "relative", ...style }}>
        <button
          onClick={() => p && fetchFrom(p)} disabled={busy != null || !p}
          title={err ? `${t("trafficCheckTitle")} — ${err}` : t("trafficCheckTitle")}
          style={{
            display: "flex", alignItems: "center", gap: "4px", flexShrink: 0,
            fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "6px",
            border: "1px solid var(--color-border)", background: "transparent",
            color: err ? "var(--color-warning)" : "var(--color-text-secondary)",
            cursor: busy != null || !p ? "default" : "pointer",
          }}>
          {busy ? <Loader2 size={11} className="spin" /> : <TrendingUp size={11} />}
          {t("trafficCheckBtn")}
        </button>
        {/* Failures were once tooltip-only, which read as "nothing happened". The reason —
            no data at this provider, a bad key, an empty wallet — is one glance away now. */}
        {err && (
          <span style={{ fontSize: "11px", color: "var(--color-warning)", maxWidth: "280px",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={err}>
            {err === "no_data" || err.endsWith(": no_data") ? t("trafficNoData") : err}
          </span>
        )}
        {bothKeys && (
          <>
            <button onClick={() => setMenuOpen(o => !o)}
              style={{
                display: "flex", alignItems: "center", padding: "2px 3px", borderRadius: "6px",
                border: "1px solid var(--color-border)", background: "transparent",
                color: "var(--color-text-secondary)", cursor: "pointer",
              }}
              title={t("trafficSourceMenu")}>
              <ChevronDown size={11} />
            </button>
            {menuOpen && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setMenuOpen(false)} />
                <div style={{
                  position: "absolute", top: "100%", left: 0, marginTop: "4px", zIndex: 50,
                  background: "var(--color-card)", border: "1px solid var(--color-border)",
                  borderRadius: "8px", padding: "4px", minWidth: "150px", boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
                }}>
                  {(["semrush", "goanyapi"] as const).map(src => (
                    <button key={src} onClick={() => fetchFrom(src)}
                      style={{
                        display: "flex", alignItems: "center", gap: "6px", width: "100%", textAlign: "left",
                        padding: "7px 9px", fontSize: "12px", borderRadius: "6px", border: "none",
                        background: "transparent", color: "var(--color-text-primary)", cursor: "pointer",
                      }}>
                      {PROVIDER_LABEL[src]}
                      {provider === src && <span style={{ color: "#10B981", fontSize: "11px" }}>✓</span>}
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

  const genAI = data.sources?.genAI;
  const src = provider === "semrush" ? "Semrush TA" : "GoAnyAPI";
  return (
    <span
      title={[
        `${t("trafficSourceMenu")}: ${src}`,
        checkedAt ? `${t("trafficAsOf")} ${new Date(checkedAt).toLocaleDateString()}` : "",
        data.period ? `${t("trafficPeriod")} ${data.period}` : "",
        data.globalRank ? `#${data.globalRank} global` : "",
      ].filter(Boolean).join(" · ")}
      style={{ display: "inline-flex", alignItems: "center", gap: "4px", flexShrink: 0, position: "relative", ...style }}>
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
      {/* The source tag doubles as the switch: one press asks the other vendor, and the cache
          keeps both answers so switching back is free. */}
      {bothKeys && (
        <>
          <button onClick={() => setMenuOpen(o => !o)} className="metric-chip"
            title={`${t("trafficSourceMenu")}: ${src}`}
            style={{ fontSize: "10px", fontWeight: 600, padding: "2px 6px", display: "inline-flex", alignItems: "center", gap: "2px", cursor: "pointer" }}>
            {src === "Semrush TA" ? "S" : "G"} <ChevronDown size={9} />
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
