"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { withShare } from "@/lib/shareParam";
import RelatedIntentCannibalization from "@/components/RelatedIntentCannibalization";

// ─── Types ─────────────────────────────────────────────────────────────────────
interface CannibalPage {
  url: string; fullUrl: string; topQuery: string;
  impressions: number; clicks: number; ctr: number; position: number;
}
interface CannibalGroup {
  query: string; pages: CannibalPage[]; isTrue: boolean;
  siteId?: string; siteName?: string;
}

type SortKey = "impressions" | "clicks" | "position";

// ─── Helpers ───────────────────────────────────────────────────────────────────
function fmtK(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function posColor(p: number) {
  if (p <= 5)  return "#10B981";
  if (p <= 10) return "#F59E0B";
  return "#EF4444";
}

// ─── Info block ────────────────────────────────────────────────────────────────
function InfoBlock() {
  const { t } = useLanguage();
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px",
      padding: "24px 28px", borderBottom: "1px solid var(--color-border)",
      background: "var(--color-card)",
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "rgba(59,130,246,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("cdmHowItWorks")}</span>
        </div>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.6", margin: "0 0 12px" }}>{t("kcHowItWorks1")}</p>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" }}>
          {[t("kcHowItWorks2"), t("kcHowItWorks3"), t("kcHowItWorks4")].map((text, i) => (
            <li key={i} style={{ display: "flex", gap: "8px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.5" }}>
              <span style={{ color: "#3B82F6", fontWeight: 700, flexShrink: 0 }}>•</span>{text}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "6px", background: "rgba(16,185,129,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </div>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("cdmWhatToDo")}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[t("kcWhatToDo1"), t("kcWhatToDo2"), t("kcWhatToDo3")].map((text, i) => (
            <div key={i} style={{ display: "flex", gap: "10px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: "1.55" }}>
              <span style={{ width: "18px", height: "18px", borderRadius: "50%", background: "rgba(16,185,129,0.1)", color: "#10B981", fontSize: "11px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "1px" }}>{i + 1}</span>
              {text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Cannibalization table ─────────────────────────────────────────────────────
function CannibalizationTable({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();

  const [groups,   setGroups]   = useState<CannibalGroup[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [days,     setDays]     = useState(90);

  const [search,         setSearch]         = useState("");
  const [sortKey,        setSortKey]        = useState<SortKey>("impressions");
  const [filterSeverity, setFilterSeverity] = useState<"all" | "true" | "possible">("all");
  const [expanded,       setExpanded]       = useState<Set<string>>(new Set());

  const fetchData = useCallback(async (d: number) => {
    if (!siteDbId) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(withShare(
        `/api/gsc/cannibalization?siteId=${encodeURIComponent(siteDbId)}&days=${d}&minImpressions=30&limit=60`
      ));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setGroups(data.groups ?? []);
      // Auto-expand all groups
      setExpanded(new Set((data.groups ?? []).map((g: CannibalGroup) => g.query)));
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [siteDbId]);

  useEffect(() => { fetchData(days); }, [days, fetchData]);

  const filtered = useMemo(() => {
    return groups
      .filter(g => {
        if (search && !g.query.toLowerCase().includes(search.toLowerCase())) return false;
        if (filterSeverity === "true"     && !g.isTrue) return false;
        if (filterSeverity === "possible" &&  g.isTrue) return false;
        return true;
      })
      .map(g => {
        const pages = [...g.pages].sort((a, b) => {
          if (sortKey === "position") return a[sortKey] - b[sortKey];
          return b[sortKey] - a[sortKey];
        });
        const groupSortValue = sortKey === "position"
          ? Math.min(...pages.map(p => p.position))
          : pages.reduce((s, p) => s + p[sortKey], 0);
        return { ...g, pages, groupSortValue };
      })
      .sort((a, b) => sortKey === "position"
        ? a.groupSortValue - b.groupSortValue
        : b.groupSortValue - a.groupSortValue
      );
  }, [groups, search, sortKey, filterSeverity]);

  const toggleExpand = (query: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(query) ? n.delete(query) : n.add(query); return n; });

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
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="2" style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)" }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("kcSearch")}
            style={{ width: "100%", padding: "7px 12px 7px 30px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box" }} />
        </div>

        {/* Severity filter */}
        <div style={{ display: "flex", gap: "4px" }}>
          {(["all", "true", "possible"] as const).map(v => {
            const labels = { all: t("kcFilterAll"), true: t("kcFilterTrue"), possible: t("kcFilterPossible") };
            return (
              <button key={v} onClick={() => setFilterSeverity(v)} style={{
                padding: "6px 12px", borderRadius: "8px", fontSize: "12px", fontWeight: 500,
                border: `1px solid ${filterSeverity === v ? "#3B82F6" : "var(--color-border)"}`,
                background: filterSeverity === v ? "rgba(59,130,246,0.1)" : "transparent",
                color: filterSeverity === v ? "#3B82F6" : "var(--color-text-secondary)",
                cursor: "pointer", transition: "all 0.15s",
              }}>{labels[v]}</button>
            );
          })}
        </div>

        {/* Days selector */}
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          style={{ padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", cursor: "pointer" }}>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
          <option value={180}>6 months</option>
        </select>

        {/* Sort */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("kcSortBy")}</span>
          <SortBtn k="impressions" label={t("impressions")} />
          <SortBtn k="clicks"      label={t("clicks")} />
          <SortBtn k="position"    label={t("position")} />
        </div>

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
            <div style={{ width: "14px", height: "14px", border: "2px solid var(--color-border)", borderTopColor: "#3B82F6", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: "10px 14px", borderRadius: "8px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", fontSize: "12px", color: "#f87171", marginBottom: "12px" }}>
          {error}
        </div>
      )}

      {/* Summary badges */}
      {!loading && (
        <div style={{ display: "flex", gap: "10px", marginBottom: "16px" }}>
          {[
            { label: `${filtered.length} ${t("kcQueries")}`,           bg: "rgba(59,130,246,0.1)",  color: "#3B82F6" },
            { label: `${filtered.reduce((s, g) => s + g.pages.length, 0)} ${t("kcCompetingPages")}`, bg: "rgba(245,158,11,0.1)", color: "#F59E0B" },
            { label: `${filtered.filter(g => g.isTrue).length} ${t("kcTrueCannibalization")}`,       bg: "rgba(239,68,68,0.1)",  color: "#EF4444" },
          ].map(({ label, bg, color }) => (
            <div key={label} style={{ padding: "4px 12px", borderRadius: "20px", background: bg, fontSize: "12px", fontWeight: 600, color }}>
              {label}
            </div>
          ))}
        </div>
      )}

      {/* Table header */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 200px 90px 90px 80px 90px",
        padding: "8px 14px", background: "var(--color-bg)",
        borderRadius: "8px 8px 0 0", border: "1px solid var(--color-border)", borderBottom: "none",
        fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)",
        textTransform: "uppercase", letterSpacing: "0.05em",
      }}>
        <div>{t("kcColQueryPage")}</div>
        <div>{t("kcColTopQuery")}</div>
        <div style={{ textAlign: "right" }}>{t("impressions")}</div>
        <div style={{ textAlign: "right" }}>{t("clicks")}</div>
        <div style={{ textAlign: "right" }}>{t("kcColCtr")}</div>
        <div style={{ textAlign: "right" }}>{t("position")}</div>
      </div>

      {/* Empty/loading states */}
      {loading && groups.length === 0 ? (
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px", padding: "60px 32px", textAlign: "center", background: "var(--color-card)" }}>
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>Analyzing your GSC data…</div>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px", padding: "60px 32px", textAlign: "center", background: "var(--color-card)" }}>
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>✅</div>
          <p style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 6px" }}>{t("kcEmptyTitle")}</p>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("kcEmptyDesc")}</p>
        </div>
      ) : (
        <div className="privacy-blur-all" style={{ border: "1px solid var(--color-border)", borderRadius: "0 0 8px 8px", overflow: "hidden" }}>
          {filtered.map((group, gi) => {
            const isOpen = expanded.has(group.query);
            const topImpr = group.pages[0]?.impressions ?? 1;

            return (
              <div key={group.query} style={{ borderBottom: gi < filtered.length - 1 ? "1px solid var(--color-border)" : "none" }}>
                {/* Query header row */}
                <div onClick={() => toggleExpand(group.query)} style={{
                  display: "grid", gridTemplateColumns: "1fr 200px 90px 90px 80px 90px",
                  padding: "12px 14px", cursor: "pointer",
                  background: isOpen ? "rgba(59,130,246,0.04)" : "var(--color-card)",
                  alignItems: "center", transition: "background 0.15s",
                }}
                  onMouseOver={e => { if (!isOpen) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.03)"; }}
                  onMouseOut={e => { if (!isOpen) (e.currentTarget as HTMLDivElement).style.background = "var(--color-card)"; }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }}>
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                    <div style={{ width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0,
                      background: group.isTrue ? "#EF4444" : "#F59E0B",
                      boxShadow: group.isTrue ? "0 0 6px rgba(239,68,68,0.5)" : "0 0 6px rgba(245,158,11,0.5)" }} />
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{group.query}</span>
                    {group.siteName && (
                      <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.06)", padding: "2px 6px", borderRadius: "4px", flexShrink: 0 }} title={group.siteName}>
                        {group.siteName}
                      </span>
                    )}
                    <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "20px",
                      background: group.isTrue ? "rgba(239,68,68,0.1)" : "rgba(245,158,11,0.1)",
                      color: group.isTrue ? "#EF4444" : "#F59E0B",
                      border: `1px solid ${group.isTrue ? "rgba(239,68,68,0.25)" : "rgba(245,158,11,0.25)"}`,
                    }}>
                      {group.isTrue ? t("kcFilterTrue").replace("🔴 ", "") : t("kcFilterPossible").replace("🟡 ", "")}
                    </span>
                    <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                      {group.pages.length} {t("kcCompetingPages")}
                    </span>
                  </div>
                  <div />
                  <div style={{ textAlign: "right", fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {fmtK(group.pages.reduce((s, p) => s + p.impressions, 0))}
                  </div>
                  <div style={{ textAlign: "right", fontSize: "13px", color: "var(--color-text-secondary)" }}>
                    {group.pages.reduce((s, p) => s + p.clicks, 0)}
                  </div>
                  <div /><div />
                </div>

                {/* Expanded page rows */}
                {isOpen && group.pages.map((page, pi) => {
                  const isWinner = pi === 0;
                  const share = Math.round((page.impressions / topImpr) * 100);
                  return (
                    <div key={page.fullUrl} style={{
                      display: "grid", gridTemplateColumns: "1fr 200px 90px 90px 80px 90px",
                      padding: "10px 14px 10px 38px",
                      background: isWinner ? "rgba(16,185,129,0.03)" : "rgba(239,68,68,0.02)",
                      borderTop: "1px solid var(--color-border)", alignItems: "center", fontSize: "13px",
                    }}>
                      {/* URL */}
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                        <div style={{ width: "6px", height: "6px", borderRadius: "50%", flexShrink: 0, background: isWinner ? "#10B981" : "#EF4444" }} />
                        <a href={page.fullUrl} target="_blank" rel="noreferrer"
                          style={{ color: "#3B82F6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: "none" }}
                          onMouseOver={e => (e.currentTarget.style.textDecoration = "underline")}
                          onMouseOut={e => (e.currentTarget.style.textDecoration = "none")}
                          title={page.fullUrl}
                        >{page.url}</a>
                        {isWinner && (
                          <span style={{ fontSize: "10px", fontWeight: 700, color: "#10B981", background: "rgba(16,185,129,0.1)", padding: "1px 6px", borderRadius: "10px", flexShrink: 0 }}>
                            dominant
                          </span>
                        )}
                        <div style={{ flex: 1, maxWidth: "80px", height: "4px", background: "var(--color-border)", borderRadius: "2px", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${share}%`, background: isWinner ? "#10B981" : "#EF4444", borderRadius: "2px" }} />
                        </div>
                        <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", flexShrink: 0 }}>{share}%</span>
                      </div>

                      {/* Top query */}
                      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {page.topQuery}
                        {page.topQuery.toLowerCase().includes(group.query.split(" ")[0].toLowerCase()) && (
                          <span style={{ marginLeft: "5px", fontSize: "10px", color: "#EF4444", fontWeight: 700 }}>⚠</span>
                        )}
                      </div>

                      <div style={{ textAlign: "right", fontWeight: 600 }}>{fmtK(page.impressions)}</div>
                      <div style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>{page.clicks}</div>
                      <div style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>{page.ctr}%</div>
                      <div style={{ textAlign: "right", fontWeight: 600, color: posColor(page.position) }}>{page.position.toFixed(1)}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main export ───────────────────────────────────────────────────────────────
export default function KeywordCannibalization({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<"exact" | "related">("exact");
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden", marginTop: "20px", background: "var(--color-card)" }}>
      <div style={{ display: "flex", gap: "4px", padding: "10px 14px 0", borderBottom: "1px solid var(--color-border)", overflowX: "auto" }}>
        {(["exact", "related"] as const).map(value => <button key={value} onClick={() => setMode(value)} style={{ padding: "8px 13px", border: "none", borderBottom: mode === value ? "2px solid #3B82F6" : "2px solid transparent", background: "transparent", color: mode === value ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: mode === value ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap" }}>{t(value === "exact" ? "kcModeExact" : "kcModeRelated")}</button>)}
      </div>
      {mode === "exact" ? <><InfoBlock /><CannibalizationTable siteDbId={siteDbId} /></> : <RelatedIntentCannibalization siteDbId={siteDbId} />}
    </div>
  );
}
