"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { withShare } from "@/lib/shareParam";
import { usePersistedState, isReportDays } from "@/lib/usePersistedState";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface CtrQuery {
  query:       string;
  page:        string;
  fullUrl:     string;
  impressions: number;
  clicks:      number;
  position:    number;
  actualCtr:   number;
  expectedCtr: number;
  diff:        number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────
const BENCHMARKS: Record<number, number> = {
  1: 27.6, 2: 15.8, 3: 11.0, 4: 8.4, 5: 6.3,
  6: 4.9,  7: 3.9,  8: 3.3,  9: 2.7, 10: 2.4,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────
function fmtK(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

// ─── Info Blocks ───────────────────────────────────────────────────────────────
function InfoBlocks() {
  const { t } = useLanguage();
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "24px",
      padding: "24px 28px",
      borderBottom: "1px solid var(--color-border)",
      background: "var(--color-bg)",
    }}>
      {/* How it works */}
      <div style={{ background: "var(--color-card)", borderRadius: "8px", border: "1px solid var(--color-border)", padding: "20px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 14px" }}>{t("cdmHowItWorks")}</h3>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.6", margin: "0 0 12px" }}>
          <span style={{ color: "#3B82F6" }}>{t("ctrHowItWorks1")}</span>{t("ctrHowItWorks2")}
        </p>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.6", margin: "0 0 12px" }}>
          {t("ctrHowItWorks3")}
        </p>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.6", margin: "0" }}>
          {t("ctrHowItWorks4")}
        </p>
      </div>

      {/* How to improve CTR */}
      <div style={{ background: "var(--color-card)", borderRadius: "8px", border: "1px solid var(--color-border)", padding: "20px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 14px" }}>{t("ctrImprove")}</h3>
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "10px" }}>
          {[t("ctrImprove1"), t("ctrImprove2"), t("ctrImprove3"), t("ctrImprove4")].map((text, i) => (
            <li key={i} style={{ display: "flex", gap: "8px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.5" }}>
              <span style={{ color: "var(--color-text-primary)", fontWeight: 600 }}>{i + 1}.</span>
              {text}
            </li>
          ))}
        </ol>
      </div>

      {/* Benchmark */}
      <div style={{ background: "var(--color-card)", borderRadius: "8px", border: "1px solid var(--color-border)", padding: "20px" }}>
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 14px" }}>{t("ctrBenchmark")}</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {Object.entries(BENCHMARKS).map(([pos, ctr]) => {
            const widthPct = (ctr / 27.6) * 100;
            return (
              <div key={pos} style={{ display: "flex", alignItems: "center", gap: "10px", height: "16px" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-secondary)", width: "16px", textAlign: "right" }}>#{pos}</span>
                <div style={{ flex: 1, height: "100%", background: "rgba(147,197,253,0.15)", borderRadius: "3px", display: "flex", overflow: "hidden" }}>
                  <div style={{ width: `${widthPct}%`, height: "100%", background: "#3B82F6", borderRadius: "3px" }} />
                </div>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", width: "40px", textAlign: "right" }}>{ctr}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Table ─────────────────────────────────────────────────────────────────────
type SortKey = "impressions" | "clicks" | "position" | "actualCtr" | "diff";

const PERIOD_OPTIONS = [
  { label: "30d", days: 30 },
  { label: "60d", days: 60 },
  { label: "90d", days: 90 },
  { label: "180d", days: 180 },
];

function CtrTable({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [search,  setSearch]  = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("diff");
  // Same stored window as the other report panels, so it follows the user between tabs.
  const [days,    setDays]    = usePersistedState<number>("gsc_report_days", 90, isReportDays);
  const [data,    setData]    = useState<CtrQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!siteDbId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withShare(`/api/gsc/ctr?siteId=${siteDbId}&days=${days}&minImpressions=10&limit=200`));
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setData(json.keywords ?? []);
    } catch (e: any) {
      setError(e.message ?? 'Error');
    } finally {
      setLoading(false);
    }
  }, [siteDbId, days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = useMemo(() => {
    return data
      .filter(k => {
        if (!search) return true;
        const q = search.toLowerCase();
        return k.query.toLowerCase().includes(q) || k.page.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (sortKey === "position") return a.position - b.position;
        if (sortKey === "diff")     return a.diff - b.diff; // most negative first
        return b[sortKey] - a[sortKey];
      });
  }, [data, search, sortKey]);

  const SortBtn = ({ k, label }: { k: SortKey; label: string }) => (
    <button
      onClick={() => setSortKey(k)}
      style={{
        padding: "4px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: 600,
        border: `1px solid ${sortKey === k ? "#3B82F6" : "var(--color-border)"}`,
        background: sortKey === k ? "rgba(59,130,246,0.1)" : "transparent",
        color: sortKey === k ? "#3B82F6" : "var(--color-text-secondary)",
        cursor: "pointer", transition: "all 0.15s",
      }}
    >{label}</button>
  );

  return (
    <div style={{ padding: "20px 28px" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px", maxWidth: "300px" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="2"
            style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)" }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t("sdkSearch")}
            style={{
              width: "100%", padding: "7px 12px 7px 30px", borderRadius: "8px",
              border: "1px solid var(--color-border)", background: "var(--color-bg)",
              color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Period */}
        <div style={{ display: "flex", gap: "4px" }}>
          {PERIOD_OPTIONS.map(o => (
            <button key={o.days} onClick={() => setDays(o.days)} style={{
              padding: "4px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: 600,
              border: `1px solid ${days === o.days ? "#8B5CF6" : "var(--color-border)"}`,
              background: days === o.days ? "rgba(139,92,246,0.1)" : "transparent",
              color: days === o.days ? "#8B5CF6" : "var(--color-text-secondary)",
              cursor: "pointer",
            }}>{o.label}</button>
          ))}
        </div>

        {/* Sort */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("kcSortBy")}</span>
          <SortBtn k="diff"        label={t("ctrSortWorst")} />
          <SortBtn k="impressions" label={t("impressions")} />
          <SortBtn k="position"    label={t("position")} />
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <div style={{
            width: "32px", height: "32px", borderRadius: "50%",
            border: "3px solid var(--color-border)", borderTopColor: "#3B82F6",
            animation: "spin 0.7s linear infinite", margin: "0 auto 12px",
          }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>Loading CTR data…</p>
        </div>
      ) : error ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <p style={{ fontSize: "14px", color: "#EF4444", margin: 0 }}>{error}</p>
        </div>
      ) : (
        <>
          {/* Summary badge */}
          <div style={{ marginBottom: "16px" }}>
            <div style={{ display: "inline-block", padding: "4px 12px", borderRadius: "20px", background: "rgba(239,68,68,0.1)", fontSize: "12px", fontWeight: 600, color: "#EF4444" }}>
              {filtered.filter(k => k.diff < 0).length} {t("ctrBadge")}
            </div>
          </div>

          {/* Table header */}
          <div style={{
            display: "grid", gridTemplateColumns: "1.5fr 1fr 90px 90px 80px 80px 80px",
            padding: "8px 14px", background: "var(--color-bg)",
            borderRadius: "8px 8px 0 0", border: "1px solid var(--color-border)",
            borderBottom: "none", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)",
            textTransform: "uppercase", letterSpacing: "0.05em", gap: "10px",
          }}>
            <div>{t("sdkColQuery")}</div>
            <div>{t("cdmPage")}</div>
            <div style={{ textAlign: "right" }}>{t("impressions")}</div>
            <div style={{ textAlign: "right" }}>{t("position")}</div>
            <div style={{ textAlign: "right" }}>{t("ctrColExpected")}</div>
            <div style={{ textAlign: "right" }}>{t("ctrColActual")}</div>
            <div style={{ textAlign: "right" }}>{t("ctrColDiff")}</div>
          </div>

          {/* Rows */}
          {filtered.length === 0 ? (
            <div style={{
              border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px",
              padding: "60px 32px", textAlign: "center", background: "var(--color-card)",
            }}>
              <div style={{ fontSize: "32px", marginBottom: "12px" }}>✅</div>
              <p style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 6px" }}>{t("kcEmptyTitle")}</p>
              <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("ctrEmptyDesc")}</p>
            </div>
          ) : (
            <div style={{ border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
              {filtered.map((item, i) => (
                <div key={`${item.query}-${item.page}`} style={{
                  display: "grid", gridTemplateColumns: "1.5fr 1fr 90px 90px 80px 80px 80px",
                  padding: "12px 14px", gap: "10px",
                  borderBottom: i < filtered.length - 1 ? "1px solid var(--color-border)" : "none",
                  background: i % 2 === 0 ? "var(--color-card)" : "rgba(255,255,255,0.02)",
                  alignItems: "center", fontSize: "13px",
                }}>
                  <div style={{ fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.query}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px", overflow: "hidden" }}>
                    <a
                      href={item.fullUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#3B82F6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textDecoration: "none" }}
                    >
                      {item.page}
                    </a>
                    <ExternalLink size={12} style={{ flexShrink: 0, opacity: 0.5, color: "#3B82F6" }} />
                  </div>
                  <div style={{ textAlign: "right", fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {fmtK(item.impressions)}
                  </div>
                  <div style={{ textAlign: "right", fontWeight: 600, color: "#F59E0B" }}>
                    {item.position.toFixed(1)}
                  </div>
                  <div style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>
                    {item.expectedCtr.toFixed(1)}%
                  </div>
                  <div style={{ textAlign: "right", fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {item.actualCtr.toFixed(1)}%
                  </div>
                  <div style={{ textAlign: "right", fontWeight: 700, color: item.diff < 0 ? "#EF4444" : "#10B981" }}>
                    {item.diff > 0 ? "+" : ""}{item.diff.toFixed(1)}%
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────
export default function CtrBenchmark({ siteDbId }: { siteDbId: string }) {
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden", marginTop: "20px", background: "var(--color-card)" }}>
      <InfoBlocks />
      <CtrTable siteDbId={siteDbId} />
    </div>
  );
}
