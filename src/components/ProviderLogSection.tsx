"use client";

// What every paid provider was actually asked, and what it said it cost.
//
// The screen exists to answer one question — "what did this run cost, and who served it" — so it
// is newest-first, unfiltered by default, and one row deep. Two of its rendering rules are not
// cosmetic:
//
//   - **A null cost renders as "not stated", never $0.00.** `costUsd` holds only what a provider
//     itself reported; most report nothing. A zero on screen is a claim, and it looks exactly like
//     a true one. The whole reason this column is never computed from a price table is that a
//     stale table produces confident wrong numbers, and rendering null as zero would reintroduce
//     that by the back door.
//   - **`complete: false` is not an error.** It means nobody closed the row — the process stopped,
//     or the caller returned early — so the tokens are unknown rather than absent. Coloured like a
//     failure it would send someone hunting a provider outage that never happened.
//
// The `feature` filter is the one that makes the log usable rather than merely complete: a "Test
// connection" click and a model-catalogue probe are real billable-path calls and belong here, but
// they are not the run whose cost is being reconciled. Filtering by feature is how they are told
// apart, which is why the facet list comes from the server rather than being guessed here.

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, ScrollText } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

interface LogRow {
  id: string;
  at: string;
  userId: string | null;
  feature: string | null;
  provider: string;
  model: string | null;
  endpoint: string;
  status: number;
  ms: number;
  attempt: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  error: string | null;
  complete: boolean;
  hasBodies: boolean;
}

interface Bodies { requestBody: string | null; responseBody: string | null }

const PAGE = 50;

/**
 * A stated cost, at the precision it was stated.
 *
 * Fixed decimals are wrong in both directions here: two would round a $0.0004 SERP call to
 * nothing, and six would print $1.500000 for a dollar and a half. Trailing zeros are trimmed
 * instead, so each number is as long as it needs to be and no longer.
 */
function usd(v: number): string {
  const s = v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `$${s === "0" || s === "-0" ? v.toExponential(1) : s}`;
}

const th: React.CSSProperties = {
  textAlign: "left", padding: "9px 10px", color: "var(--color-text-secondary)", fontWeight: 600,
  fontSize: "10.5px", letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap",
};
const td: React.CSSProperties = { padding: "9px 10px", verticalAlign: "top", whiteSpace: "nowrap" };
const sel: React.CSSProperties = {
  padding: "6px 9px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none",
};

export default function ProviderLogSection() {
  const { t } = useLanguage();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [providers, setProviders] = useState<string[]>([]);
  const [features, setFeatures] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  const [feature, setFeature] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [notMigrated, setNotMigrated] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, Bodies>>({});

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    setFailed(false);
    setForbidden(false);
    try {
      const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (provider) q.set("provider", provider);
      if (feature) q.set("feature", feature);
      const res = await fetch(`/api/provider-log?${q}`, { cache: "no-store" });
      // 403 is not a malfunction: the log holds captured prompts and what the owner was billed,
      // so it is owner-only. Saying which of the two happened is the difference between "ask the
      // owner" and "something is broken".
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { setFailed(true); return; }
      const d = await res.json();
      setNotMigrated(!!d.notMigrated);
      setTotal(d.total ?? 0);
      // The facets describe the whole log, not the filtered page, so they are only refreshed on a
      // first page — otherwise selecting a provider would erase every other option from the list
      // that was used to select it.
      if (offset === 0) {
        setProviders(d.providers ?? []);
        setFeatures(d.features ?? []);
      }
      setRows(prev => (offset === 0 ? d.rows : [...prev, ...d.rows]));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [provider, feature]);

  useEffect(() => { void load(0); }, [load]);

  const toggle = async (r: LogRow) => {
    if (expanded === r.id) { setExpanded(null); return; }
    setExpanded(r.id);
    if (!r.hasBodies || bodies[r.id]) return;
    try {
      const res = await fetch(`/api/provider-log?id=${encodeURIComponent(r.id)}`, { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      setBodies(b => ({ ...b, [r.id]: { requestBody: d.row?.requestBody ?? null, responseBody: d.row?.responseBody ?? null } }));
    } catch { /* the row still shows everything it already had */ }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <ScrollText size={17} color="#2997ff" />
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("plogTitle")}</h2>
      </div>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 14px", lineHeight: 1.55 }}>{t("plogSub")}</p>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }}>
        <select style={sel} value={provider} onChange={e => setProvider(e.target.value)}>
          <option value="">{t("plogAllProviders")}</option>
          {providers.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select style={{ ...sel, maxWidth: "260px" }} value={feature} onChange={e => setFeature(e.target.value)}>
          <option value="">{t("plogAllFeatures")}</option>
          {features.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <button onClick={() => void load(0)} disabled={loading}
          style={{ display: "flex", alignItems: "center", gap: "5px", padding: "6px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "11px", cursor: "pointer" }}>
          <RefreshCw size={12} className={loading ? "spin" : undefined} /> {t("plogRefresh")}
        </button>
        <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginLeft: "auto" }}>
          {t("plogShowing").replace("{n}", String(rows.length)).replace("{total}", String(total))}
        </span>
      </div>

      {forbidden ? (
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{t("plogForbidden")}</div>
      ) : failed ? (
        <div style={{ fontSize: "13px", color: "var(--color-accent-orange)" }}>{t("plogFailed")}</div>
      ) : notMigrated ? (
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{t("plogNotMigrated")}</div>
      ) : !rows.length && !loading ? (
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{t("plogEmpty")}</div>
      ) : (
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "12px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
                <th style={th}>{t("plogColTime")}</th>
                <th style={th}>{t("plogColProvider")}</th>
                <th style={th}>{t("plogColFeature")}</th>
                <th style={th}>{t("plogColStatus")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("plogColDuration")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("plogColTokens")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("plogColCost")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Fragment key={r.id}>
                  <tr onClick={() => void toggle(r)}
                    style={{ borderBottom: "1px solid var(--color-border)", cursor: "pointer", background: expanded === r.id ? "rgba(41,151,255,0.05)" : i % 2 === 1 ? "rgba(128,128,128,0.03)" : "transparent" }}>
                    <td style={{ ...td, color: "var(--color-text-secondary)" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                        {expanded === r.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        {new Date(r.at).toLocaleString()}
                      </span>
                    </td>
                    <td style={{ ...td, color: "var(--color-text-primary)", fontWeight: 600 }}>
                      {r.provider}
                      {r.attempt > 1 && <span style={{ marginLeft: "6px", fontSize: "10.5px", color: "var(--color-text-tertiary)" }}>#{r.attempt}</span>}
                      {r.model && <div style={{ fontSize: "11px", fontWeight: 400, color: "var(--color-text-tertiary)" }}>{r.model}</div>}
                    </td>
                    <td style={{ ...td, color: "var(--color-text-secondary)", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.feature ?? <span style={{ color: "var(--color-text-tertiary)" }}>{t("plogNoFeature")}</span>}
                      {r.userId === null && (
                        <div style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)" }}>{t("plogUnattributed")}</div>
                      )}
                    </td>
                    <td style={td}>
                      {r.status === 0
                        ? <span style={{ color: "var(--color-accent-orange)" }}>{t("plogNoStatus")}</span>
                        : <span style={{ color: r.status >= 400 ? "var(--color-accent-orange)" : "var(--color-text-secondary)" }}>{r.status}</span>}
                      {!r.complete && (
                        // Grey, not orange: unfinished is a gap in what we know, not a failure.
                        <div style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)" }} title={t("plogUnfinishedHint")}>{t("plogUnfinished")}</div>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "var(--color-text-secondary)" }}>{r.ms} ms</td>
                    <td style={{ ...td, textAlign: "right", color: "var(--color-text-secondary)" }}>
                      {r.promptTokens == null && r.completionTokens == null
                        ? <span style={{ color: "var(--color-text-tertiary)" }}>—</span>
                        : `${r.promptTokens ?? "—"} / ${r.completionTokens ?? "—"}`}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {r.costUsd == null
                        // Never $0.00. The provider said nothing, and saying nothing is the fact.
                        ? <span style={{ color: "var(--color-text-tertiary)" }} title={t("plogCostNotStatedHint")}>{t("plogCostNotStated")}</span>
                        : <span style={{ color: "var(--color-text-primary)" }}>{usd(r.costUsd)}</span>}
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr style={{ borderBottom: "1px solid var(--color-border)", background: "rgba(41,151,255,0.03)" }}>
                      <td colSpan={7} style={{ padding: "12px 14px" }}>
                        <div style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", fontFamily: "monospace", wordBreak: "break-all", marginBottom: "8px" }}>{r.endpoint}</div>
                        {r.error && (
                          <div style={{ fontSize: "12px", color: "var(--color-accent-orange)", marginBottom: "8px", whiteSpace: "pre-wrap" }}>{r.error}</div>
                        )}
                        {!r.hasBodies ? (
                          <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", lineHeight: 1.6 }}>{t("plogNoBodies")}</div>
                        ) : (
                          <div style={{ display: "grid", gap: "10px" }}>
                            <BodyBlock label={t("plogRequestBody")} value={bodies[r.id]?.requestBody} loading={!bodies[r.id]} />
                            <BodyBlock label={t("plogResponseBody")} value={bodies[r.id]?.responseBody} loading={!bodies[r.id]} />
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length < total && !failed && (
        <button onClick={() => void load(rows.length)} disabled={loading}
          style={{ marginTop: "12px", padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer" }}>
          {t("plogMore")}
        </button>
      )}

      <div style={{ marginTop: "12px", fontSize: "11.5px", color: "var(--color-text-tertiary)", lineHeight: 1.6 }}>{t("plogBodiesHint")}</div>
    </div>
  );
}

function BodyBlock({ label, value, loading }: { label: string; value: string | null | undefined; loading: boolean }) {
  return (
    <div>
      <div style={{ fontSize: "10.5px", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-secondary)", marginBottom: "4px" }}>{label}</div>
      <pre style={{ margin: 0, padding: "10px 12px", borderRadius: "8px", background: "var(--color-bg)", border: "1px solid var(--color-border)", fontSize: "11.5px", color: "var(--color-text-secondary)", maxHeight: "240px", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {loading ? "…" : (value ?? "—")}
      </pre>
    </div>
  );
}
