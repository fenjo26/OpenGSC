"use client";

// Trend radar (N5) — the block on the Demand page (src/app/seo-tools/demand). Two free
// sources no paid trends API has: the portfolio's own Search Console (what impressions are
// actually rising) and Google autocomplete for the operator's seeds (what people start
// typing). Rows carry three actions: hide, push to Rank Tracker, hand over to the Outline
// generator via the same sessionStorage slot the Cluster tool uses.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Crosshair, EyeOff, Loader2, PenLine, Plus, RefreshCw, Sprout, TrendingUp, X,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { TREND_SOURCES, type TrendRow, type TrendSeedRow, type TrendSource } from "@/lib/trends/types";

interface SiteOption { id: string; url: string }

interface Feed {
  items: TrendRow[];
  seeds: TrendSeedRow[];
  lastRunAt: string | null;
  suggestUnavailableToday: boolean;
}

type Filter = TrendSource | "all";

const SOURCE_ICON: Record<TrendSource, typeof TrendingUp> = {
  gsc_rising: TrendingUp,
  gsc_new: Sprout,
  suggest: PenLine,
};

const SOURCE_COLOR: Record<TrendSource, string> = {
  gsc_rising: "var(--color-accent-green)",
  gsc_new: "var(--color-accent-blue)",
  suggest: "var(--color-accent-purple)",
};

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });

const cell: React.CSSProperties = { padding: "8px 10px", fontSize: "13px" };
const th: React.CSSProperties = {
  ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)",
  textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left", whiteSpace: "nowrap",
};
const actionBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "4px", padding: "4px 8px", borderRadius: "7px",
  border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)",
  fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap",
};

export default function TrendRadar({ sites }: { sites: SiteOption[] }) {
  const { t } = useLanguage();
  // Extra N5 i18n keys not in the locales yet (wave rule: use, report, R adds them later) —
  // one typed alias keeps the call sites clean without `any`.
  const tt = (key: string) => t(key as never);
  const router = useRouter();

  // Derived default: the first site until the user picks one — adjusted during render, not in
  // an effect, so the first feed load and the selector always agree.
  const [selected, setSelected] = useState("");
  const siteId = selected || sites[0]?.id || "";

  const [feed, setFeed] = useState<Feed | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [seedInput, setSeedInput] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tracked, setTracked] = useState<Set<string>>(new Set());
  // Guard against setState after a site switch races a slow load.
  const loadSeq = useRef(0);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/trends?siteId=${encodeURIComponent(id)}&limit=200`);
      const d = await res.json().catch(() => ({}));
      if (seq !== loadSeq.current) return;
      if (d?.notMigrated) { setNotMigrated(true); setFeed(null); return; }
      setNotMigrated(false);
      if (Array.isArray(d?.items)) {
        setFeed({ items: d.items, seeds: d.seeds ?? [], lastRunAt: d.lastRunAt ?? null, suggestUnavailableToday: !!d.suggestUnavailableToday });
      }
    } catch {
      if (seq === loadSeq.current) setNotice(t("dmFailed"));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [t]);

  // Deferred by a tick: load() flips loading state synchronously, and setState in an effect
  // body cascades renders — the demand page debounces its cache reads the same way.
  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    const id = setTimeout(() => { if (!cancelled) void load(siteId); }, 0);
    return () => { cancelled = true; clearTimeout(id); };
  }, [siteId, load]);

  async function run(opts: { deep?: boolean } = {}) {
    if (!siteId || running) return;
    setRunning(true);
    setNotice("");
    try {
      const res = await fetch("/api/trends/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, ...(opts.deep ? { deep: true, sources: ["suggest"] } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.error) { setNotice(t("dmFailed")); return; }
      await load(siteId);
      // A deep run that came back with suggest skipped is Google refusing — say so plainly.
      if (opts.deep && d?.sources?.suggest?.status === "skipped_unavailable") setNotice(t("trUnavailable"));
    } catch {
      setNotice(t("dmFailed"));
    } finally {
      setRunning(false);
    }
  }

  async function addSeed() {
    const seed = seedInput.trim();
    if (!siteId || !seed) return;
    setNotice("");
    const res = await fetch("/api/trends/seeds", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, seed }),
    }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok || d?.error) {
      setNotice(d?.error === "too_many_seeds" ? tt("trTooManySeeds") : t("dmFailed"));
      return;
    }
    setSeedInput("");
    await load(siteId);
  }

  async function removeSeed(seed: string) {
    if (!siteId) return;
    await fetch("/api/trends/seeds", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, seed }),
    }).catch(() => {});
    await load(siteId);
  }

  async function hide(item: TrendRow) {
    if (!siteId) return;
    await fetch("/api/trends", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, ids: [item.id], dismissed: true }),
    }).catch(() => {});
    setFeed(prev => (prev ? { ...prev, items: prev.items.filter(x => x.id !== item.id) } : prev));
  }

  async function trackPosition(item: TrendRow) {
    if (!siteId) return;
    // The existing Rank Tracker API: creates the keyword (unique — a repeat click is a no-op).
    const res = await fetch("/api/rank/keywords", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId, keywords: [item.query] }),
    }).catch(() => null);
    if (res?.ok) setTracked(prev => new Set([...prev, item.query]));
  }

  function makeOutline(item: TrendRow) {
    // The Outline generator reads this slot on mount (the Cluster tool's handover mechanism):
    // the keyword lands in the seed field, ready to run.
    try {
      sessionStorage.setItem("seoClusterSeed", JSON.stringify({ keyword: item.query }));
    } catch { /* private mode — the button just navigates without the prefill */ }
    router.push("/seo-tools/outline");
  }

  const items = feed?.items ?? [];
  const counts = TREND_SOURCES.reduce<Record<string, number>>((acc, s) => {
    acc[s] = items.filter(i => i.source === s).length;
    return acc;
  }, {});
  const visible = filter === "all" ? items : items.filter(i => i.source === filter);
  const siteName = (id: string) =>
    (sites.find(s => s.id === id)?.url ?? "").replace(/^https?:\/\//, "").replace(/^sc-domain:/, "");

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <TrendingUp size={18} style={{ color: "var(--color-accent-green)" }} />
        <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("trTitle")}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
          <select className="tool-input inline" value={siteId} onChange={e => setSelected(e.target.value)}
            aria-label={t("importSite")}>
            {sites.map(s => <option key={s.id} value={s.id}>{siteName(s.id)}</option>)}
          </select>
          <button className="metric-action" onClick={() => run()} disabled={running || !siteId}
            title={t("trRunNow")}>
            {running ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {t("trRunNow")}
          </button>
        </span>
      </div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "6px" }}>{t("trHint")}</div>

      {notMigrated ? (
        <div className="panel" style={{ marginTop: "10px", padding: "14px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("serpmonNotMigrated")}
        </div>
      ) : (
        <>
          {/* Seeds: chips with remove, input to add. */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
            <span className="tool-section-label" style={{ marginBottom: 0 }}>{t("trSeeds")}</span>
            {(feed?.seeds ?? []).map(s => (
              <span key={s.id} className="pill" style={{ cursor: "default", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                {s.seed}
                <button onClick={() => removeSeed(s.seed)} aria-label={`${t("remove")} ${s.seed}`}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--color-text-secondary)", display: "inline-flex" }}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <span style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              <input className="tool-input inline" value={seedInput} onChange={e => setSeedInput(e.target.value)}
                placeholder={t("trSeedAdd")} style={{ minWidth: "140px" }}
                onKeyDown={e => { if (e.key === "Enter") addSeed(); }} />
              <button className="metric-action" onClick={addSeed} disabled={!seedInput.trim() || !siteId}>
                <Plus size={13} />
                {t("trSeedAdd")}
              </button>
              <button className="metric-action" onClick={() => run({ deep: true })} disabled={running || !siteId}
                title={t("trDeep")}>
                <RefreshCw size={13} />
                {t("trDeep")}
              </button>
            </span>
          </div>

          {notice && <div style={{ fontSize: "12px", color: "var(--color-danger)", marginTop: "8px" }}>{notice}</div>}
          {feed?.suggestUnavailableToday && !notice && (
            <div style={{ fontSize: "12px", color: "var(--color-warning)", marginTop: "8px" }}>{t("trUnavailable")}</div>
          )}

          {/* Source filter + deep state. */}
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
            <button className={filter === "all" ? "pill active" : "pill"} onClick={() => setFilter("all")} style={{ cursor: "pointer" }}>
              {t("gapAll")} ({items.length})
            </button>
            {TREND_SOURCES.map(s => {
              const Icon = SOURCE_ICON[s];
              return (
                <button key={s} className={filter === s ? "pill active" : "pill"} onClick={() => setFilter(s)}
                  style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                  <Icon size={11} />
                  {t(`trSource_${s}`)} ({counts[s] ?? 0})
                </button>
              );
            })}
          </div>

          {loading && !feed ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "24px 0", color: "var(--color-text-secondary)", fontSize: "13px" }}>
              <Loader2 size={14} className="spin" />
            </div>
          ) : visible.length === 0 ? (
            <div style={{ padding: "24px 0", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("trEmpty")}
            </div>
          ) : (
            <div style={{ marginTop: "10px", overflowX: "auto" }}>
              <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <th style={th}>{t("sdkColQuery")}</th>
                    <th style={{ ...th, width: "120px" }}>{tt("trColSource")}</th>
                    <th style={{ ...th, width: "70px", textAlign: "right" }}>×</th>
                    <th style={{ ...th, width: "150px" }}>{t("digestColImpr")}</th>
                    <th style={{ ...th, width: "100px" }}>{t("trFirstSeen")}</th>
                    <th style={{ ...th, width: "210px", textAlign: "right" }} />
                  </tr>
                </thead>
                <tbody>
                  {visible.map(item => {
                    const Icon = SOURCE_ICON[item.source];
                    const growth = item.impressions != null && item.prevImpressions && item.prevImpressions > 0
                      ? item.impressions / item.prevImpressions
                      : null;
                    return (
                      <tr key={item.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                        <td style={{ ...cell, fontWeight: 600 }}>
                          {item.query}
                          {item.seed && (
                            <span style={{ marginLeft: "6px", fontSize: "11px", color: "var(--color-text-tertiary)" }}>· {item.seed}</span>
                          )}
                        </td>
                        <td style={cell}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600, color: SOURCE_COLOR[item.source] }}>
                            <Icon size={11} />
                            {t(`trSource_${item.source}`)}
                          </span>
                        </td>
                        <td style={{ ...cell, textAlign: "right", fontWeight: 700, color: growth ? "var(--color-success)" : "var(--color-text-secondary)" }}>
                          {growth != null ? t("trGrowth").replace("{x}", growth.toFixed(1)) : "—"}
                        </td>
                        <td style={{ ...cell, color: "var(--color-text-secondary)" }}>
                          {item.impressions == null
                            ? <span title={tt("trNoVolume")}>—</span>
                            : t("trImpr")
                              .replace("{now}", String(item.impressions))
                              .replace("{before}", String(item.prevImpressions ?? 0))}
                        </td>
                        <td style={{ ...cell, color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>{fmtDate(item.firstSeenAt)}</td>
                        <td style={{ ...cell, textAlign: "right" }}>
                          <span style={{ display: "inline-flex", gap: "6px" }}>
                            <button style={actionBtn} onClick={() => trackPosition(item)}
                              disabled={tracked.has(item.query)}
                              title={t("trTrack")}>
                              <Crosshair size={11} />
                              {tracked.has(item.query) ? "✓" : t("trTrack")}
                            </button>
                            <button style={actionBtn} onClick={() => makeOutline(item)} title={t("trOutline")}>
                              <PenLine size={11} />
                              {t("trOutline")}
                            </button>
                            <button style={actionBtn} onClick={() => hide(item)} title={t("trHide")}>
                              <EyeOff size={11} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
