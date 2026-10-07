"use client";

// «Доля голоса» sub-tab, lower half (T7): which domains the AI engines cite when answering this
// site's tracked questions. Pure aggregation over stored AeoCheck.citations — being mentioned
// on these sites is how a page gets into the answers, hence the "add to Outreach" action.
//
// Wave A adds the classification cut: each cited domain is badged with its heuristic category,
// and below the table the "Citation categories" chart + "Reddit & communities" block answer the
// question the raw table cannot — WHO crowds us out: Reddit, review sites, or competitors.

import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Handshake, MessageCircleQuestion } from "lucide-react";
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import type { CitedDomainRow } from "@/lib/visibility/types";
import type { CategoryCount, RedditCut } from "@/lib/seo/aeoCitationClassify";
import { CategoryBadge, CATEGORY_LABEL_KEY, CATEGORY_COLOR } from "./citationCategoryUi";

const VIOLET = "#8B5CF6";
const GREEN = "#10B981";
const AMBER = "#F59E0B";

// The "extend the domain lists" signal (plan §7.4): when more than this share of citations
// falls into "other", the classifier does not know the market. Deliberately a constant, not a
// setting — one more knob to not set — and deliberately printed next to the number when it
// fires, so the threshold is read, not guessed from the colour.
const OTHER_SHARE_WARN = 0.3;

const tooltipStyle: React.CSSProperties = { background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", fontSize: "12px", color: "var(--color-text-primary)" };

function engineName(e: string): string {
  const known: Record<string, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", grok: "Grok", gemini: "Gemini" };
  return known[e] ?? e;
}

async function fetchCited(siteDbId: string): Promise<{
  cited: CitedDomainRow[]; answers: number; categoryCounts: CategoryCount[]; reddit: RedditCut;
}> {
  const r = await fetch(`/api/aeo/sov?siteId=${encodeURIComponent(siteDbId)}&days=30`);
  const d = await r.json();
  return {
    cited: Array.isArray(d?.cited) ? (d.cited as CitedDomainRow[]) : [],
    answers: Number(d?.report?.answers ?? 0),
    categoryCounts: Array.isArray(d?.categoryCounts) ? (d.categoryCounts as CategoryCount[]) : [],
    reddit: d?.reddit ?? { count: 0, subreddits: [] },
  };
}

// The "other: NN%" chip for the categories header. Computed from the same counts the chart
// below draws, so the two can never disagree. Absent when nothing fell through — a chip that
// says "other: 0%" next to a chart with no "other" bar would claim a measurement twice.
function OtherShareChip({ counts }: { counts: CategoryCount[] }) {
  const { t } = useLanguage();
  const entry = counts.find(c => c.category === "other");
  if (!entry) return null;
  const pct = Math.round(entry.share * 1000) / 10;
  const warn = entry.share > OTHER_SHARE_WARN;
  const thresholdPct = Math.round(OTHER_SHARE_WARN * 100);
  // t() has no interpolation — the warn sentence and the threshold are joined by hand.
  const title = warn ? `${t("aeoOtherShareWarn")} (> ${thresholdPct}%)` : undefined;
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: "4px",
      fontSize: "10px", fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase",
      padding: "2px 8px", borderRadius: "999px", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
      ...(warn
        ? { color: AMBER, border: `1px solid ${AMBER}55`, background: `${AMBER}14` }
        : { color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", background: "transparent" }),
    }}>
      {warn && <AlertTriangle size={10} />}
      {t("aeoOtherShare")}: {pct}%{warn ? ` > ${thresholdPct}%` : ""}
    </span>
  );
}

// Horizontal share of the citation categories (recharts, vertical layout). The bar's LENGTH is
// the share; the axis count and the tooltip carry the fact — colour alone never decides meaning.
function CategoryChart({ counts }: { counts: CategoryCount[] }) {
  const { t } = useLanguage();
  if (!counts.length) return null;
  const data = counts.map(c => ({
    category: c.category,
    label: t(CATEGORY_LABEL_KEY[c.category]),
    count: c.count,
    pct: Math.round(c.share * 1000) / 10,
  }));
  const height = data.length * 26 + 8;
  return (
    <ResponsiveContainer width="100%" height={height} initialDimension={{ width: 520, height }}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 30, bottom: 4, left: 4 }}>
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="label" width={116} tick={{ fontSize: 11, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={tooltipStyle} cursor={{ fill: "rgba(128,128,128,0.06)" }}
          formatter={(value, _name, item) => [`${value} · ${item.payload.pct}%`, ""] as [string, string]}
        />
        <Bar dataKey="count" name="count" radius={[0, 3, 3, 0]} barSize={14}>
          {data.map(d => <Cell key={d.category} fill={CATEGORY_COLOR[d.category]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// The communities cut: how much citation mass is Reddit, and which subreddits it sits in. Shown
// only when Reddit actually appears — an empty block would claim a measurement that was not made.
function RedditBlock({ reddit }: { reddit: RedditCut }) {
  const { t } = useLanguage();
  if (!reddit || !reddit.count) return null;
  const max = Math.max(...reddit.subreddits.map(s => s.count), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <MessageCircleQuestion size={14} color="#F59E0B" />
        <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aeoRedditBlock")}</span>
        <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{reddit.count}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
        {reddit.subreddits.map(s => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ width: "116px", flexShrink: 0, fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={`r/${s.name}`}>r/{s.name}</span>
            <div style={{ flex: 1, height: "8px", borderRadius: "4px", background: "var(--color-bg)", overflow: "hidden" }}>
              <div style={{ width: `${Math.max(4, (s.count / max) * 100)}%`, height: "100%", borderRadius: "4px", background: "#F59E0B", opacity: 0.75 }} />
            </div>
            <span style={{ width: "34px", textAlign: "right", flexShrink: 0, fontSize: "11px", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CitedDomains({ siteDbId, domain, readOnly = false }: { siteDbId: string; domain: string; readOnly?: boolean }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};
  void domain;

  const [rows, setRows] = useState<CitedDomainRow[]>([]);
  const [answers, setAnswers] = useState(0);
  const [counts, setCounts] = useState<CategoryCount[]>([]);
  const [reddit, setReddit] = useState<RedditCut>({ count: 0, subreddits: [] });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());

  // setState only inside promise callbacks — never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetchCited(siteDbId)
      .then(d => { if (!cancelled) { setRows(d.cited); setAnswers(d.answers); setCounts(d.categoryCounts); setReddit(d.reddit); } })
      .catch(() => { /* keep the last list */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteDbId]);

  const toOutreach = async (row: CitedDomainRow) => {
    setSending(row.domain);
    try {
      const r = await fetch("/api/aeo/cited-to-outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, domain: row.domain }),
      });
      if (r.ok) setSentTo(s => new Set([...s, row.domain]));
    } finally { setSending(null); }
  };

  return (
    <div className="card" style={{ padding: "16px" }}>
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aiCitedTitle")}</div>
      <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", marginTop: "4px", marginBottom: "12px", lineHeight: 1.5 }}>
        {t("aiCitedHint")}
      </div>

      {loading ? (
        <div style={{ padding: "20px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>…</div>
      ) : !answers || !rows.length ? (
        <div style={{ padding: "20px", textAlign: "center", fontSize: "13px", color: "var(--color-text-tertiary)" }}>{t("aiSovNoData")}</div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px", minWidth: "640px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>#</th>
                  <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>domain</th>
                  <th style={{ textAlign: "center", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiCitedCitations")}</th>
                  <th style={{ textAlign: "center", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiCitedAnswers")}</th>
                  <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiCitedEngines")}</th>
                  <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aeoColQuestion")}</th>
                  <th style={{ padding: "7px 10px" }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.domain} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "7px 10px", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{i + 1}</td>
                    <td style={{ padding: "7px 10px", ...blurStyle }}>
                      <span style={{
                        fontWeight: row.isUs ? 700 : 600,
                        color: row.isUs ? GREEN : row.competitor ? VIOLET : "var(--color-text-primary)",
                      }}>
                        {row.domain}
                      </span>
                      {row.category && <CategoryBadge category={row.category} t={t} />}
                      {row.isUs && <span style={{ marginLeft: "6px", fontSize: "9.5px", fontWeight: 700, color: GREEN, textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("aiSovUs")}</span>}
                      {row.competitor && <span className="pill" style={{ marginLeft: "6px", fontSize: "9.5px", padding: "1px 7px", color: VIOLET }}>{row.competitor}</span>}
                    </td>
                    <td style={{ padding: "7px 10px", textAlign: "center", color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{row.citations}</td>
                    <td style={{ padding: "7px 10px", textAlign: "center", color: "var(--color-text-primary)", fontVariantNumeric: "tabular-nums" }}>{row.answers}</td>
                    <td style={{ padding: "7px 10px", color: "var(--color-text-tertiary)", fontSize: "11px", whiteSpace: "nowrap" }}>
                      {row.engines.map(engineName).join(" · ")}
                    </td>
                    <td style={{ padding: "7px 10px", maxWidth: "220px" }}>
                      {row.exampleUrl ? (
                        <a href={row.exampleUrl} target="_blank" rel="noreferrer"
                          style={{ color: "var(--color-text-secondary)", textDecoration: "none", fontSize: "11.5px", display: "flex", alignItems: "center", gap: "4px", ...blurStyle }}
                          title={`${row.exampleQuestion}\n${row.exampleUrl}`}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.exampleQuestion}</span>
                          <ExternalLink size={10} style={{ flexShrink: 0 }} />
                        </a>
                      ) : (
                        <span style={{ color: "var(--color-text-tertiary)", fontSize: "11.5px" }} title={row.exampleQuestion}>{row.exampleQuestion}</span>
                      )}
                    </td>
                    <td style={{ padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                      {(sentTo.has(row.domain) || row.isUs || readOnly) ? (
                        sentTo.has(row.domain) && <span style={{ fontSize: "10.5px", fontWeight: 700, color: GREEN }}>✓</span>
                      ) : (
                        <button
                          onClick={() => toOutreach(row)}
                          disabled={sending === row.domain}
                          title={t("aiCitedToOutreach")}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 10px", borderRadius: "7px",
                            border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)",
                            fontSize: "11px", fontWeight: 600, cursor: sending === row.domain ? "not-allowed" : "pointer",
                          }}>
                          <Handshake size={11} /> {sending === row.domain ? "…" : t("aiCitedToOutreach")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(counts.length > 0 || reddit.count > 0) && (
            <div style={{ borderTop: "1px solid var(--color-border)", marginTop: "14px", paddingTop: "14px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "18px" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "2px", flexWrap: "wrap" }}>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aeoCitationsCategories")}</div>
                  <OtherShareChip counts={counts} />
                </div>
                <div style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", marginBottom: "10px", lineHeight: 1.5 }}>{t("aeoCitationsCategoriesDesc")}</div>
                <CategoryChart counts={counts} />
              </div>
              <div>
                <RedditBlock reddit={reddit} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
