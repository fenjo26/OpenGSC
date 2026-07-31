"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { withShare, isGuestView } from "@/lib/shareParam";
import KeywordWeightsBar from "@/components/KeywordWeightsBar";
import { useKeywordWeights, type KeywordWeight, type UseKeywordWeights } from "@/lib/seo/useKeywordWeights";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface StrikingKeyword {
  query: string; page: string; fullUrl: string;
  impressions: number; clicks: number; ctr: number; position: number;
  siteId?: string; siteName?: string;
}

type SortKey = "impressions" | "clicks" | "position" | "ctr" | "potential";

// ─── Helpers ───────────────────────────────────────────────────────────────────
function fmtK(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

/**
 * Rough organic CTR at the top of page one. Used to turn search volume into "clicks this
 * keyword could produce", which is the number that makes a striking-distance list sortable by
 * something other than impressions.
 *
 * Impressions are demand filtered through your current visibility — a keyword sitting at
 * position 18 shows a small number no matter how big its market is. Volume is the market
 * itself, and the gap between the two is exactly what this view is for.
 *
 * The constant is approximate and deliberately conservative. It is used only for ordering and
 * relative comparison, never presented as a forecast.
 */
const CTR_AT_TOP = 0.1;

/**
 * Cache lookups must normalize exactly the way the server does (`normalizeKeyword`), or a GSC
 * query with stray whitespace silently misses a weight that was fetched and paid for — showing
 * an em dash next to a keyword whose volume is sitting in the database.
 */
const wKey = (q: string) => q.trim().toLowerCase();

/** Clicks left on the table: what the keyword could bring near the top, minus what it brings now. */
function potentialOf(k: StrikingKeyword, w?: KeywordWeight): number | null {
  if (!w || w.volume == null) return null;
  return Math.max(0, Math.round(w.volume * CTR_AT_TOP) - k.clicks);
}

function kdColor(kd: number) {
  if (kd <= 14) return "var(--color-success)";
  if (kd <= 29) return "var(--color-accent-green)";
  if (kd <= 49) return "var(--color-warning)";
  if (kd <= 69) return "var(--color-accent-orange)";
  return "var(--color-danger)";
}

function posColor(p: number) {
  if (p <= 5)  return "#10B981";
  if (p <= 10) return "#F59E0B";
  if (p <= 15) return "#F97316";
  return "#EF4444";
}

// Position "closeness" badge: how many positions away from page 1 top-10
function proximityLabel(pos: number): { label: string; color: string; bg: string } {
  if (pos <= 5)  return { label: "Top 5 🎯",  color: "#10B981", bg: "rgba(16,185,129,0.1)" };
  if (pos <= 10) return { label: "Page 1",     color: "#3B82F6", bg: "rgba(59,130,246,0.1)" };
  if (pos <= 15) return { label: "~Page 2",    color: "#F97316", bg: "rgba(249,115,22,0.1)" };
  return             { label: "Page 2+",       color: "#EF4444", bg: "rgba(239,68,68,0.1)"  };
}

// ─── Info block ────────────────────────────────────────────────────────────────
function InfoBlock({
  posFrom, setPosFrom, posTo, setPosTo, days, setDays,
}: {
  posFrom: number; setPosFrom: (v: number) => void;
  posTo: number;   setPosTo:   (v: number) => void;
  days: number;    setDays:    (v: number) => void;
}) {
  const { t } = useLanguage();
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px",
      padding: "24px 28px", borderBottom: "1px solid var(--color-border)",
      background: "var(--color-card)",
    }}>
      {/* Position range + period */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "rgba(245,158,11,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="20" x2="12" y2="10"/><line x1="12" y1="6" x2="12" y2="6"/>
              <polyline points="8 14 12 10 16 14"/>
            </svg>
          </div>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("sdkPosRange")}</span>
        </div>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.6", margin: "0 0 16px" }}>
          {t("sdkPosRangeDesc")}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-secondary)" }}>{t("sdkFrom")}</span>
          <input type="number" value={posFrom} min={1} max={100}
            onChange={e => setPosFrom(Math.max(1, Number(e.target.value)))}
            style={{ width: "70px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "14px", fontWeight: 600, outline: "none", textAlign: "center" }} />
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-secondary)" }}>{t("sdkTo")}</span>
          <input type="number" value={posTo} min={1} max={100}
            onChange={e => setPosTo(Math.max(1, Number(e.target.value)))}
            style={{ width: "70px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "14px", fontWeight: 600, outline: "none", textAlign: "center" }} />
        </div>
        <div style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "13px", color: "var(--color-text-secondary)", fontWeight: 500 }}>Period:</span>
          {([30, 60, 90, 180] as const).map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: "4px 11px", borderRadius: "6px", fontSize: "12px", fontWeight: 600,
              border: `1px solid ${days === d ? "#F59E0B" : "var(--color-border)"}`,
              background: days === d ? "rgba(245,158,11,0.1)" : "transparent",
              color: days === d ? "#F59E0B" : "var(--color-text-secondary)",
              cursor: "pointer", transition: "all 0.15s",
            }}>{d}d</button>
          ))}
        </div>
      </div>

      {/* What to do */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "rgba(16,185,129,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
          </div>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("cdmWhatToDo")}</span>
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "10px" }}>
          {[t("sdkWhatToDo1"), t("sdkWhatToDo2")].map((text, i) => (
            <li key={i} style={{ display: "flex", gap: "10px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.55" }}>
              <span style={{ width: "18px", height: "18px", borderRadius: "50%", background: "rgba(16,185,129,0.1)", color: "#10B981", fontSize: "11px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "1px" }}>{i + 1}</span>
              {text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Two more numeric columns than before (volume, KD, potential). They are always present, even
// with no data behind them: a column that appears only once you have paid for it is a feature
// nobody discovers.
const GRID = "1.3fr 0.9fr 92px 78px 68px 62px 74px 82px 54px 80px";

// ─── Table ─────────────────────────────────────────────────────────────────────
function KeywordsTable({ data, loading, siteDbId, weights, country }: {
  data: StrikingKeyword[]; loading: boolean; siteDbId: string;
  weights: UseKeywordWeights; country: string;
}) {
  const { t } = useLanguage();
  const [search,  setSearch]  = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("impressions");

  // Rank tracker integration: one-click "Track" per keyword
  const [tracked, setTracked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!siteDbId) return;
    if (isGuestView()) return; // guests don't see the Track buttons
    fetch(`/api/rank/keywords?siteId=${encodeURIComponent(siteDbId)}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.keywords)) setTracked(new Set(d.keywords.map((k: any) => String(k.keyword).toLowerCase()))); })
      .catch(() => {});
  }, [siteDbId]);

  const track = (query: string, siteIdOverride?: string) => {
    if (isGuestView()) return;
    const targetSiteId = siteIdOverride || siteDbId;
    const kw = query.trim().toLowerCase();
    if (!kw || tracked.has(kw) || !targetSiteId) return;
    setTracked(prev => new Set(prev).add(kw));
    fetch("/api/rank/keywords", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId: targetSiteId, keywords: [kw] }),
    })
      .then(() => fetch("/api/rank/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: targetSiteId }),
      }))
      .catch(() => {});
  };

  const filtered = useMemo(() => {
    const rows = data.filter(k =>
      !search ||
      k.query.toLowerCase().includes(search.toLowerCase()) ||
      k.page.toLowerCase().includes(search.toLowerCase()));

    if (sortKey === "potential") {
      // Rows without a weight sort last rather than as zero — "unknown" and "nothing to gain"
      // are different answers, and mixing them hides the keywords worth loading next.
      return [...rows].sort((a, b) => {
        const pa = potentialOf(a, weights.get(a.query, country));
        const pb = potentialOf(b, weights.get(b.query, country));
        if (pa == null && pb == null) return b.impressions - a.impressions;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pb - pa;
      });
    }
    return [...rows].sort((a, b) => sortKey === "position" ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey]);
  }, [data, search, sortKey, weights, country]);

  const SortBtn = ({ k, label }: { k: SortKey; label: string }) => (
    <button onClick={() => setSortKey(k)} style={{
      padding: "4px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: 600,
      border: `1px solid ${sortKey === k ? "#3B82F6" : "var(--color-border)"}`,
      background: sortKey === k ? "rgba(59,130,246,0.1)" : "transparent",
      color: sortKey === k ? "#3B82F6" : "var(--color-text-secondary)",
      cursor: "pointer", transition: "all 0.15s",
    }}>{label}</button>
  );

  return (
    <div style={{ padding: "20px 28px" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 200px", maxWidth: "320px" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="2" style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)" }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("sdkSearch")}
            style={{ width: "100%", padding: "7px 12px 7px 30px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("kcSortBy")}</span>
          <SortBtn k="impressions" label={t("impressions")} />
          <SortBtn k="clicks"      label={t("clicks")} />
          <SortBtn k="position"    label={t("position")} />
          <SortBtn k="ctr"         label="CTR" />
          <SortBtn k="potential"   label={t("kwColPotential")} />
        </div>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            <div style={{ width: "14px", height: "14px", border: "2px solid var(--color-border)", borderTopColor: "#F59E0B", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
      </div>

      {/* Summary badge */}
      <div style={{ marginBottom: "16px" }}>
        <div style={{ display: "inline-block", padding: "4px 12px", borderRadius: "20px", background: "rgba(245,158,11,0.1)", fontSize: "12px", fontWeight: 600, color: "#F59E0B" }}>
          {filtered.length} {t("sdkBadge")}
        </div>
      </div>

      {/* Table header */}
      <div style={{
        display: "grid", gridTemplateColumns: GRID,
        padding: "8px 14px", background: "var(--color-bg)",
        borderRadius: "8px 8px 0 0", border: "1px solid var(--color-border)", borderBottom: "none",
        fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)",
        textTransform: "uppercase", letterSpacing: "0.05em", gap: "10px",
      }}>
        <div>{t("sdkColQuery")}</div>
        <div>{t("cdmPage")}</div>
        <div>Proximity</div>
        <div style={{ textAlign: "right" }}>{t("impressions")}</div>
        <div style={{ textAlign: "right" }}>{t("clicks")}</div>
        <div style={{ textAlign: "right" }}>CTR</div>
        <div style={{ textAlign: "right" }}>{t("position")}</div>
        <div style={{ textAlign: "right" }}>{t("kwColVolume")}</div>
        <div style={{ textAlign: "right" }}>{t("kwColKd")}</div>
        <div style={{ textAlign: "right" }} title={t("kwPotentialHint")}>{t("kwColPotential")}</div>
      </div>

      {/* Rows */}
      {!loading && filtered.length === 0 ? (
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px", padding: "60px 32px", textAlign: "center", background: "var(--color-card)" }}>
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>🎯</div>
          <p style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 6px" }}>
            No keywords in this range
          </p>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>
            Try adjusting the position range or syncing GSC data first.
          </p>
        </div>
      ) : (
        <div className="privacy-blur-all" style={{ border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
          {filtered.map((item, i) => {
            const prox = proximityLabel(item.position);
            const w = weights.get(item.query, country);
            const potential = potentialOf(item, w);
            return (
              <div key={`${item.query}-${item.page}-${i}`} style={{
                display: "grid", gridTemplateColumns: GRID,
                padding: "11px 14px", gap: "10px",
                borderBottom: i < filtered.length - 1 ? "1px solid var(--color-border)" : "none",
                background: i % 2 === 0 ? "var(--color-card)" : "rgba(255,255,255,0.02)",
                alignItems: "center", fontSize: "13px",
              }}>
                {/* Query */}
                <div style={{ display: "flex", alignItems: "center", gap: "6px", overflow: "hidden" }}>
                  {tracked.has(item.query.toLowerCase()) ? (
                    <span title={t("rankTracked")} style={{ color: "#10B981", flexShrink: 0, fontSize: "12px" }}>✓</span>
                  ) : (
                    <button onClick={() => track(item.query, item.siteId)} title={t("rankTrack")}
                      style={{ width: "17px", height: "17px", borderRadius: "4px", border: "1px solid var(--color-border)", background: "none", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: "12px", lineHeight: 1, padding: 0, flexShrink: 0 }}
                      onMouseEnter={e => { e.currentTarget.style.color = "#3B82F6"; e.currentTarget.style.borderColor = "#3B82F6"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "var(--color-text-secondary)"; e.currentTarget.style.borderColor = "var(--color-border)"; }}>+</button>
                  )}
                  <span style={{ fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.query}>
                    {item.query}
                  </span>
                  {item.siteName && (
                    <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: "4px", marginLeft: "4px", flexShrink: 0 }} title={item.siteName}>
                      {item.siteName}
                    </span>
                  )}
                </div>
                {/* Page */}
                <div style={{ display: "flex", alignItems: "center", gap: "4px", overflow: "hidden" }}>
                  <a href={item.fullUrl} target="_blank" rel="noreferrer"
                    style={{ color: "#3B82F6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textDecoration: "none" }}
                    title={item.fullUrl}
                    onMouseOver={e => (e.currentTarget.style.textDecoration = "underline")}
                    onMouseOut={e => (e.currentTarget.style.textDecoration = "none")}
                  >{item.page}</a>
                  <ExternalLink size={11} style={{ flexShrink: 0, opacity: 0.4 }} />
                </div>
                {/* Proximity badge */}
                <div>
                  <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "20px", color: prox.color, background: prox.bg, whiteSpace: "nowrap" }}>
                    {prox.label}
                  </span>
                </div>
                {/* Metrics */}
                <div style={{ textAlign: "right", fontWeight: 600 }}>{fmtK(item.impressions)}</div>
                <div style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>{item.clicks}</div>
                <div style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>{item.ctr}%</div>
                <div style={{ textAlign: "right", fontWeight: 700, color: posColor(item.position) }}>
                  {item.position.toFixed(1)}
                </div>

                {/* Weights. An em dash rather than a zero: no data and no demand must not look
                    the same, or the whole point of loading them is lost. */}
                <div style={{ textAlign: "right", fontWeight: 600, color: w?.volume != null ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}
                  title={w ? `${w.cpc != null ? `CPC ${w.cpc}` : ""}${w.cpc != null ? " · " : ""}${w.source === "csv" ? t("kwSourceCsv") : t("kwSourceApi")}` : undefined}>
                  {w?.volume != null ? fmtK(w.volume) : "—"}
                </div>
                <div style={{ textAlign: "right", fontWeight: 700, color: w?.difficulty != null ? kdColor(w.difficulty) : "var(--color-text-tertiary)" }}>
                  {w?.difficulty != null ? w.difficulty : "—"}
                </div>
                <div style={{ textAlign: "right", fontWeight: 600, color: potential != null && potential > 0 ? "var(--color-success)" : "var(--color-text-tertiary)" }}>
                  {potential != null ? `+${fmtK(potential)}` : "—"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────
export default function StrikingDistanceKeywords({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [posFrom, setPosFrom] = useState(4);
  const [posTo,   setPosTo]   = useState(20);
  const [days,    setDays]    = useState(90);

  const [keywords, setKeywords] = useState<StrikingKeyword[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  // Weights live beside the GSC rows rather than inside them: they arrive later, from a
  // different source, and may never arrive at all. All the paid-fetch logic is in the shared
  // hook so this view and Rank Tracker cannot drift apart on pricing or cache keys.
  const [country, setCountryS] = useState("us");

  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // localStorage only after mount — reading it during render would make the first client pass
  // disagree with the server-rendered HTML.
  useEffect(() => { setCountryS(localStorage.getItem("seoMetricsCountry") || "us"); }, []);
  const setCountry = (v: string) => { setCountryS(v); localStorage.setItem("seoMetricsCountry", v); };

  const queries = useMemo(
    () => [...new Set(keywords.map(k => wKey(k.query)).filter(Boolean))],
    [keywords],
  );

  // One market for the whole list here, chosen in the toolbar — unlike Rank Tracker, GSC rows
  // carry no country of their own.
  const targets = useMemo(
    () => queries.map(keyword => ({ keyword, country })),
    [queries, country],
  );

  const weights = useKeywordWeights(targets, {
    // Guests on a share link have no session and the metrics endpoints are owner-scoped.
    enabled: !isGuestView(),
    onError: code => (code === "cap_exceeded" ? t("kwCapExceeded") : t("kwLoadFailed")),
  });

  const fetchData = useCallback(async (from: number, to: number, d: number) => {
    if (!siteDbId) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(withShare(
        `/api/gsc/striking?siteId=${encodeURIComponent(siteDbId)}&posFrom=${from}&posTo=${to}&days=${d}&minImpressions=10&limit=200`
      ));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setKeywords(data.keywords ?? []);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [siteDbId]);

  // Debounce position changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchData(posFrom, posTo, days), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [posFrom, posTo, days, fetchData]);

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden", marginTop: "20px", background: "var(--color-card)" }}>
      {error && (
        <div style={{ padding: "10px 20px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", fontSize: "12px", color: "#f87171" }}>
          {error}
        </div>
      )}
      <InfoBlock posFrom={posFrom} setPosFrom={setPosFrom} posTo={posTo} setPosTo={setPosTo} days={days} setDays={setDays} />
      {!isGuestView() && <KeywordWeightsBar w={weights} country={country} setCountry={setCountry} />}
      <KeywordsTable data={keywords} loading={loading} siteDbId={siteDbId} weights={weights} country={country} />
    </div>
  );
}
