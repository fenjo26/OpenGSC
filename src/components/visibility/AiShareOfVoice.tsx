"use client";

// «Доля голоса» sub-tab (T7): how often AI answer engines name us vs the competitors the user
// listed — computed entirely from answers the AEO tracker already stored. The demo this panel
// exists for: add a competitor, the whole history recomputes instantly, and the provider log
// stays empty. Every element here therefore reads; only the competitor list writes (local row),
// plus the one paid action — the sentiment pass (N7), whose price is shown before it runs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, TrendingUp, Gauge } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import { DrSparkline } from "@/components/DrSparkline";
import type { AiCompetitor, SovReport } from "@/lib/visibility/types";
import type { SentimentSlice } from "@/lib/visibility/sov";

const GREEN = "#10B981";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const VIOLET = "#8B5CF6";

const WINDOWS = [7, 30, 90] as const;

const inputStyle: React.CSSProperties = {
  padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
};
const labelStyle: React.CSSProperties = {
  fontSize: "10px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
  color: "var(--color-text-tertiary)", marginBottom: "4px", display: "block",
};

function engineName(e: string, t: (k: "aeoEngineAiOverview") => string): string {
  const known: Record<string, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", grok: "Grok", gemini: "Gemini" };
  return known[e] ?? (e === "ai_overview" ? t("aeoEngineAiOverview") : e);
}

// One fetch for the panel: the aggregated report and the competitor list it was built against.
// `sentiment.us` rides along — free, from the columns the sentiment pass already wrote.
async function fetchSov(siteDbId: string, days: number): Promise<{ report: SovReport | null; competitors: AiCompetitor[]; sentimentUs: SentimentSlice | null }> {
  const [sovR, compR] = await Promise.all([
    fetch(`/api/aeo/sov?siteId=${encodeURIComponent(siteDbId)}&days=${days}`),
    fetch(`/api/aeo/competitors?siteId=${encodeURIComponent(siteDbId)}`),
  ]);
  const sov = await sovR.json();
  const comp = await compR.json();
  return {
    report: sov?.report ? (sov.report as SovReport) : null,
    competitors: Array.isArray(comp?.competitors) ? (comp.competitors as AiCompetitor[]) : [],
    sentimentUs: sov?.sentiment?.us ?? null,
  };
}

// ─── Horizontal bar chart ─────────────────────────────────────────────────────

// Two token-styled divs per row, no chart library: the bar's WIDTH compares values (relative to
// the largest), the text LABEL states the true value — the bar is a shape, the number is the
// fact, so colour or width alone never carries the meaning.
function ShareBars({ rows }: {
  rows: { name: string; isUs: boolean; count: number; share: number }[];
}) {
  const { t } = useLanguage();
  const max = Math.max(...rows.map(r => r.share), 0.0001);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
      {rows.map(r => {
        const pct = Math.round(r.share * 1000) / 10;
        const barPct = Math.max(r.share > 0 ? 4 : 1, (r.share / max) * 100);
        return (
          <div key={r.name + (r.isUs ? "-us" : "")} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              title={r.name}
              style={{
                width: "150px", flexShrink: 0, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                fontWeight: r.isUs ? 700 : 600, color: r.isUs ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              }}>
              {r.isUs ? `${t("aiSovUs")} · ${r.name}` : r.name}
            </span>
            <div style={{ flex: 1, height: "16px", borderRadius: "4px", background: "var(--color-bg)", overflow: "hidden", minWidth: 0 }}>
              <div style={{
                width: `${barPct}%`, height: "100%", borderRadius: "4px",
                background: r.isUs ? VIOLET : "var(--color-border)",
                display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: "6px", boxSizing: "border-box",
              }}>
                {r.share > 0 && (
                  <span style={{ fontSize: "10px", fontWeight: 700, color: r.isUs ? "#fff" : "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                    {pct}%
                  </span>
                )}
              </div>
            </div>
            <span style={{ width: "72px", textAlign: "right", flexShrink: 0, fontSize: "11px", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}
              title={`${r.name}: ${r.count}`}>
              {r.count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Sentiment distribution (N7) ──────────────────────────────────────────────

// Same philosophy as ShareBars: the stacked bar is the shape, the numbers in the title/aria
// are the fact. Grey = mentions the pass has not measured (null ≠ 0 ≠ neutral).
function SentimentRow({ name, slice, isUs, blurStyle, t }: {
  name: string; slice: SentimentSlice; isUs: boolean; blurStyle: React.CSSProperties;
  t: (k: "aiSent_positive" | "aiSent_neutral" | "aiSent_negative" | "aiSent_mixed" | "aiSentTitle") => string;
}) {
  const total = slice.positive + slice.neutral + slice.negative + slice.mixed;
  const parts = [
    { n: slice.positive, color: GREEN, label: t("aiSent_positive") },
    { n: slice.neutral, color: "#94A3B8", label: t("aiSent_neutral") },
    { n: slice.negative, color: RED, label: t("aiSent_negative") },
    { n: slice.mixed, color: AMBER, label: t("aiSent_mixed") },
  ];
  const title = `${t("aiSentTitle")}: ${name} — ${parts.map(p => `${p.label} ${p.n}`).join(", ")}`
    + (slice.notAnalysed ? ` · ? ${slice.notAnalysed}` : "");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }} title={title} aria-label={title}>
      <span style={{
        width: "150px", flexShrink: 0, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontWeight: isUs ? 700 : 600, color: isUs ? "var(--color-text-primary)" : "var(--color-text-secondary)", ...blurStyle,
      }}>
        {name}
      </span>
      <div style={{ flex: 1, height: "16px", borderRadius: "4px", background: "var(--color-bg)", overflow: "hidden", display: "flex", minWidth: 0 }}>
        {total > 0 && parts.map((p, i) => (
          p.n > 0 ? <div key={i} style={{ width: `${(p.n / total) * 100}%`, height: "100%", background: p.color, opacity: 0.85, minWidth: "3px" }} /> : null
        ))}
      </div>
      <span style={{ width: "72px", textAlign: "right", flexShrink: 0, fontSize: "11px", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
        {total}{slice.notAnalysed ? ` +?${slice.notAnalysed}` : ""}
      </span>
    </div>
  );
}

function addSlices(a: SentimentSlice, b: SentimentSlice): SentimentSlice {
  return {
    positive: a.positive + b.positive,
    neutral: a.neutral + b.neutral,
    negative: a.negative + b.negative,
    mixed: a.mixed + b.mixed,
    notAnalysed: a.notAnalysed + b.notAnalysed,
  };
}

const EMPTY_SLICE: SentimentSlice = { positive: 0, neutral: 0, negative: 0, mixed: 0, notAnalysed: 0 };

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AiShareOfVoice({ siteDbId, domain, readOnly = false }: { siteDbId: string; domain: string; readOnly?: boolean }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};

  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<SovReport | null>(null);
  const [competitors, setCompetitors] = useState<AiCompetitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // N7 sentiment: the free slice from the stored columns, the price of a full run, and the
  // result of the last paid run (competitor verdicts have no column — they live here only).
  const [sentimentUs, setSentimentUs] = useState<SentimentSlice | null>(null);
  const [sentEstimate, setSentEstimate] = useState<number | null>(null);
  const [sentBusy, setSentBusy] = useState(false);
  const [sentCompetitors, setSentCompetitors] = useState<Record<string, SentimentSlice> | null>(null);

  // add-competitor form
  const [name, setName] = useState("");
  const [compDomain, setCompDomain] = useState("");
  const [terms, setTerms] = useState<string[]>([]);
  const [termDraft, setTermDraft] = useState("");

  // Initial/window load. setState only in promise callbacks (never synchronously in the effect
  // body): the previous report stays on screen while the new window fetches.
  useEffect(() => {
    let cancelled = false;
    fetchSov(siteDbId, days)
      .then(d => { if (!cancelled) { setReport(d.report); setCompetitors(d.competitors); setSentimentUs(d.sentimentUs); } })
      .catch(() => { /* leave the last good report in place */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteDbId, days]);

  // The price tag for the sentiment button — how many answers a scope="all" run would examine.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/aeo/sentiment?siteId=${encodeURIComponent(siteDbId)}&days=${days}`)
      .then(r => r.json())
      .then(d => { if (!cancelled && d && !d.error && !d.notMigrated) setSentEstimate(Number(d.all?.answers ?? 0)); })
      .catch(() => { if (!cancelled) setSentEstimate(null); });
    return () => { cancelled = true; };
  }, [siteDbId, days, competitors.length]);

  // The paid pass: one LLM call per answer that names us or any competitor, verdicts per brand
  // from that one call. Loops while the server reports more candidates.
  const runSentiment = useCallback(async () => {
    if (sentBusy || readOnly) return;
    const n = sentEstimate ?? 0;
    if (!confirm(t("aiSentEstimate").replace("{n}", String(n)).replace("{cost}", `≈${n} × LLM`))) return;
    setSentBusy(true);
    try {
      let acc: Record<string, SentimentSlice> | null = null;
      let us: SentimentSlice | null = null;
      for (let i = 0; i < 20; i++) {
        const r = await fetch("/api/aeo/sentiment", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: siteDbId, days, scope: "all" }),
        });
        const d = await r.json();
        if (!r.ok) break;
        us = d.us ?? us;
        const comps = (d.competitors ?? {}) as Record<string, SentimentSlice>;
        // Competitor verdicts have no column: slices from earlier POSTs of this loop are
        // accumulated client-side, brand by brand.
        const merged: Record<string, SentimentSlice> = { ...(acc ?? {}), ...comps };
        acc = Object.fromEntries(Object.keys(merged).map(k => [k, addSlices(merged[k] ?? EMPTY_SLICE, comps[k] ?? EMPTY_SLICE)]));
        if (!d.remaining) break;
      }
      if (us) setSentimentUs(us);
      setSentCompetitors(acc ?? {});
      // The next run's price: everything it just covered is still "all" scope (competitor
      // verdicts are not persisted), so the count stays — refreshed for the new window state.
      fetch(`/api/aeo/sentiment?siteId=${encodeURIComponent(siteDbId)}&days=${days}`)
        .then(r => r.json()).then(d => { if (d && !d.error && !d.notMigrated) setSentEstimate(Number(d.all?.answers ?? 0)); }).catch(() => {});
    } finally { setSentBusy(false); }
  }, [sentBusy, readOnly, sentEstimate, siteDbId, days, t]);

  const saveList = useCallback(async (next: AiCompetitor[]) => {
    setSaving(true);
    try {
      const r = await fetch(`/api/aeo/competitors?siteId=${encodeURIComponent(siteDbId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, competitors: next }),
      });
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d.competitors)) setCompetitors(d.competitors);
        // Recompute immediately — this is the proof of the panel's promise: free re-aggregation.
        const fresh = await fetchSov(siteDbId, days).catch(() => null);
        if (fresh?.report) setReport(fresh.report);
      }
    } finally { setSaving(false); }
  }, [siteDbId, days]);

  const addCompetitor = () => {
    const n = name.trim();
    if (!n || competitors.length >= 10) return;
    saveList([...competitors, { name: n, domain: compDomain.trim(), terms }]);
    setName(""); setCompDomain(""); setTerms([]); setTermDraft("");
  };

  const addTerm = () => {
    const v = termDraft.trim();
    if (!v || terms.includes(v) || terms.length >= 10) return;
    setTerms(ts => [...ts, v]);
    setTermDraft("");
  };

  const sovRows = useMemo(() => (report?.shareOfVoice ?? []).map(r => ({
    name: r.name, isUs: r.isUs, count: r.mentions, share: r.share,
  })), [report]);
  const citRows = useMemo(() => (report?.citationShare ?? []).map(r => ({
    name: r.name, isUs: r.isUs, count: r.citations, share: r.share,
  })), [report]);

  const totalMentions = sovRows.reduce((s, r) => s + r.count, 0);
  const totalCitations = citRows.reduce((s, r) => s + r.count, 0);
  const noAnswers = !report || report.answers === 0;
  // "No brand mentioned anywhere" is no data, not 0 % — the shares are all zero precisely
  // because there was nothing to divide, and the panel must say so instead of drawing zeros.
  const noMentions = report && report.answers > 0 && totalMentions === 0;
  const noCitations = report && report.answers > 0 && totalCitations === 0;

  const trendPoints = useMemo(
    () => (report?.trend ?? [])
      .filter(w => w.usShare !== null)
      .map(w => ({ month: w.week, dr: Math.round((w.usShare ?? 0) * 1000) / 10 })),
    [report],
  );

  return (
    <div className="card" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* header + window switcher */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aiSovTitle")}</div>
          <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", marginTop: "4px", maxWidth: "560px", lineHeight: 1.5 }}>{t("aiSovHint")}</div>
        </div>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          {WINDOWS.map(w => (
            <button key={w} onClick={() => setDays(w)} className={days === w ? "pill active" : "pill"} style={{ cursor: "pointer" }}>
              {t("aiSovWindow").replace("{n}", String(w))}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: "24px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>…</div>
      ) : noAnswers ? (
        <div style={{ padding: "28px 20px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "10px" }}>
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{t("aiSovNoData")}</div>
          <a href={`?tab=aeo&vis=ai`} style={{ fontSize: "12px", fontWeight: 700, color: VIOLET, textDecoration: "underline" }}>
            {t("visTabAi")} →
          </a>
        </div>
      ) : (
        <>
          {/* two bar charts */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "16px" }}>
            <div>
              <div style={labelStyle}>{t("aiSovShare")}</div>
              {noMentions
                ? <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", padding: "8px 0" }}>{t("aiSovNoData")}</div>
                : <div style={blurStyle}><ShareBars rows={sovRows} /></div>}
            </div>
            <div>
              <div style={labelStyle}>{t("aiSovCitationShare")}</div>
              {noCitations
                ? <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", padding: "8px 0" }}>{t("aiSovNoData")}</div>
                : <div style={blurStyle}><ShareBars rows={citRows} /></div>}
            </div>
          </div>

          {/* by engine */}
          <div>
            <div style={labelStyle}>{t("aiSovByEngine")}</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px", minWidth: "560px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}></th>
                    <th style={{ textAlign: "center", padding: "6px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiCitedAnswers")}</th>
                    <th style={{ textAlign: "center", padding: "6px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiSovUs")} · {t("aiSovShare")}</th>
                    <th style={{ textAlign: "center", padding: "6px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiSovUs")} · {t("aiCitedCitations")}</th>
                    <th style={{ textAlign: "center", padding: "6px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiSovAvgRank")}</th>
                    <th style={{ textAlign: "left", padding: "6px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiSovCompetitors")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(report?.byEngine ?? []).map(row => {
                    const best = [...row.competitors].sort((a, b) => b.mentioned - a.mentioned)[0];
                    return (
                      <tr key={row.engine} style={{ borderBottom: "1px solid var(--color-border)" }}>
                        <td style={{ padding: "7px 10px", fontWeight: 700, color: "var(--color-text-primary)" }}>{engineName(row.engine, t)}</td>
                        <td style={{ padding: "7px 10px", textAlign: "center", color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{row.answers}</td>
                        <td style={{ padding: "7px 10px", textAlign: "center", color: "var(--color-text-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{row.us.mentioned}</td>
                        <td style={{ padding: "7px 10px", textAlign: "center", color: GREEN, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{row.us.cited}</td>
                        <td style={{ padding: "7px 10px", textAlign: "center", color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                          {row.us.avgRank === null ? "—" : `#${Math.round(row.us.avgRank * 10) / 10}`}
                        </td>
                        <td style={{ padding: "7px 10px", color: "var(--color-text-secondary)", ...blurStyle }}>
                          {best && best.mentioned > 0 ? `${best.name} · ${best.mentioned}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* weekly trend */}
          <div>
            <div style={labelStyle}>{t("aiSovTrend")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", minHeight: "20px" }}>
              <TrendingUp size={13} color={VIOLET} />
              {trendPoints.length >= 2 ? (
                <span
                  title={trendPoints.map(p => `${p.month}: ${p.dr}%`).join("\n")}
                  style={{ ...blurStyle, lineHeight: 0 }}>
                  <DrSparkline points={trendPoints} width={120} height={20} />
                </span>
              ) : (
                <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("aiSovNoData")}</span>
              )}
              {trendPoints.length >= 2 && (
                <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums", ...blurStyle }}>
                  {trendPoints[0].dr}% → {trendPoints[trendPoints.length - 1].dr}%
                </span>
              )}
            </div>
          </div>

          {/* N7: sentiment, us vs competitors. Our slice is free (stored columns); competitor
              verdicts exist only after the paid pass — the button, with its price up front. */}
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <Gauge size={13} color={VIOLET} />
                <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aiSentDistribution")}</span>
              </div>
              {!readOnly && (
                <button
                  onClick={runSentiment}
                  disabled={sentBusy || !competitors.length || sentEstimate === 0}
                  title={sentEstimate !== null ? t("aiSentEstimate").replace("{n}", String(sentEstimate)).replace("{cost}", `≈${sentEstimate} × LLM`) : t("aiSentRun")}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 12px", borderRadius: "8px",
                    border: "1px solid var(--color-border)", background: "var(--color-bg)", color: VIOLET,
                    fontSize: "11.5px", fontWeight: 600,
                    cursor: sentBusy || sentEstimate === 0 ? "not-allowed" : "pointer",
                    opacity: sentBusy || sentEstimate === 0 ? 0.6 : 1,
                  }}>
                  <Gauge size={12} style={{ animation: sentBusy ? "spin 1.2s linear infinite" : "none" }} />
                  {sentBusy ? "…" : t("aiSentRun")}
                </button>
              )}
            </div>
            {sentimentUs ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <SentimentRow name={`${t("aiSovUs")} · ${domain}`} slice={sentimentUs} isUs blurStyle={blurStyle} t={t} />
                {Object.entries(sentCompetitors ?? {}).map(([name, slice]) => (
                  <SentimentRow key={name} name={name} slice={slice} isUs={false} blurStyle={blurStyle} t={t} />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", padding: "4px 0" }}>{t("aiSovNoData")}</div>
            )}
          </div>
        </>
      )}

      {/* competitors */}
      <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "14px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "10px" }}>
          {t("aiSovCompetitors")} <span style={{ fontWeight: 500, color: "var(--color-text-tertiary)" }}>({competitors.length}/10)</span>
        </div>

        {competitors.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
            {competitors.map((c, i) => (
              <div key={`${c.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "12.5px", fontWeight: 700, color: "var(--color-text-primary)" }}>{c.name}</span>
                {c.domain && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{c.domain}</span>}
                {c.terms.map(term => (
                  <span key={term} className="pill" style={{ fontSize: "10.5px", padding: "2px 8px" }}>{term}</span>
                ))}
                {!readOnly && (
                  <button
                    onClick={() => saveList(competitors.filter((_, j) => j !== i))}
                    disabled={saving}
                    title={c.name}
                    style={{ marginLeft: "auto", background: "none", border: "none", cursor: saving ? "not-allowed" : "pointer", color: "#EF4444", padding: "2px", opacity: 0.7 }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {!readOnly && (
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={labelStyle}>{t("aiSovCompName")}</label>
            <input value={name} onChange={e => setName(e.target.value)} style={{ ...inputStyle, width: "150px" }} />
          </div>
          <div>
            <label style={labelStyle}>{t("aiSovCompDomain")}</label>
            <input value={compDomain} onChange={e => setCompDomain(e.target.value)} placeholder={domain}
              style={{ ...inputStyle, width: "180px" }} />
          </div>
          <div>
            <label style={labelStyle}>{t("aiSovCompTerms")}</label>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              {terms.map(term => (
                <span key={term} className="pill" style={{ fontSize: "11px", padding: "3px 8px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  {term}
                  <button onClick={() => setTerms(ts => ts.filter(x => x !== term))}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-tertiary)", padding: 0, fontSize: "12px", lineHeight: 1 }}>×</button>
                </span>
              ))}
              <input
                value={termDraft}
                onChange={e => setTermDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTerm(); } }}
                onBlur={addTerm}
                style={{ ...inputStyle, width: "150px" }} />
            </div>
          </div>
          <button
            onClick={addCompetitor}
            disabled={!name.trim() || saving || competitors.length >= 10}
            style={{
              display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
              border: "1.5px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.08)", color: VIOLET,
              fontSize: "12px", fontWeight: 600, cursor: name.trim() && !saving ? "pointer" : "not-allowed",
              opacity: name.trim() && !saving ? 1 : 0.5,
            }}>
            <Plus size={13} /> {saving ? "…" : t("aiSovAddCompetitor")}
          </button>
          </div>
        )}
      </div>
    </div>
  );
}
