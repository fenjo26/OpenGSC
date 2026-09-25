"use client";

// Plagiarism check (N6) — "where was this text copied from?".
//
// The existing analyze_text answers uniqueness against one keyword's SERP; this page searches
// the WHOLE web for exact fragments of the text: ≤ 10 rare sentences, each one a quoted query
// through the user's SERP provider, matched by 4-word shingles, aggregated into sources.
//
// CONTRACT.md §0.5 shapes the flow: the price is computed and shown BEFORE the button does
// anything (the estimate endpoint sends no SERP query at all), the run needs an explicit press,
// and a cached re-check of the same text is free and instant. The score is an estimate, not a
// sentence — the hint under the title says so out loud.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyX, Loader2, Search, ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { readUrlParam, writeUrlParam } from "@/lib/urlParam";
import { formatUsd } from "@/lib/seo/metricsClient";
import { normalizeTextForPlagiarism } from "@/lib/plagiarism/text";

interface FragmentMatchUi {
  url: string;
  title: string;
  coverage: number;
  ownSite: boolean;
  reason: "snippet" | "repeat";
}

interface ResultUi {
  fragments: { index: number; fragment: string; matches: FragmentMatchUi[] }[];
  matchedFragments: number;
  sampledFragments: number;
  matchedPct: number;
  sources: { url: string; title: string; fragments: number; ownSite: boolean }[];
  provider: string;
  queries: number;
  checkedAt: string;
  providerErrors: string[];
  offsets: { index: number; start: number }[];
}

interface EstimateUi {
  provider: string;
  providerName: string;
  queries: number;
  costUsd: number | null;
  free: boolean;
  unknownPrice: boolean;
  cached: boolean;
  cachedAt: string | null;
  error?: string;
}

interface HistoryItem { id: string; type: string; keyword: string; createdAt: number }

const RED = "var(--color-accent-red)";
const BLUE = "var(--color-accent-blue)";
const GREEN = "var(--color-accent-green)";

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** "{n} searches via {provider} · {cost}" — the cost slot says "self-hosted · no per-request
 *  cost" for A-Parser (aparserNoCost) and "—" for a price this build does not know. Never $0.00. */
function CostLine({ est }: { est: EstimateUi }) {
  const { t } = useLanguage();
  if (est.error === "no_serp_key") return <span style={{ color: RED }}>{t("seoErrNoSerpKey")}</span>;
  const cost = est.cached
    ? t("plgCached").replace("{time}", est.cachedAt ? fmtTime(est.cachedAt) : "")
    : est.free
      ? t("aparserNoCost")
      : est.costUsd != null
        ? formatUsd(est.costUsd)
        : "—";
  return <>{t("plgEstimate").replace("{n}", String(est.queries)).replace("{provider}", est.providerName).replace("{cost}", cost)}</>;
}

export default function PlagiarismPage() {
  const { t } = useLanguage();

  const [text, setText] = useState("");
  const [historyId, setHistoryId] = useState("");
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);
  const [estimate, setEstimate] = useState<EstimateUi | null>(null);
  const [run, setRun] = useState<ResultUi | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const estSeq = useRef(0);

  // Deep link ?history=<id>: load the record's article body into the textarea so the whole
  // flow (estimate → run → highlight) works from one pasted link. Deferred one tick — the
  // react-hooks/set-state-in-effect rule this repo lints with flags a setState called straight
  // from the effect body; the timeout is a genuine async boundary and the cleanup keeps a fast
  // unmount from setting state on a dead component (same pattern as IndexAutoPanel).
  useEffect(() => {
    const id = setTimeout(() => {
      const hid = readUrlParam("history");
      if (!hid) return;
      setHistoryId(hid);
      void (async () => {
        try {
          const res = await fetch(`/api/seo/history?id=${encodeURIComponent(hid)}`);
          if (!res.ok) return;
          const d = await res.json();
          const data = d?.record?.data;
          const body = typeof data === "string" ? data
            : data && typeof data === "object"
              ? String((data as Record<string, unknown>).text ?? (data as Record<string, unknown>).body ?? "")
              : "";
          if (body) setText(body);
        } catch { /* bad link falls back to an empty textarea */ }
      })();
    }, 0);
    return () => clearTimeout(id);
  }, []);

  // The history picker: recent article records only (their `data` is the markdown body).
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/seo/history?index=1");
        if (!res.ok) return;
        const d = await res.json();
        setHistoryList(((d?.rows ?? []) as HistoryItem[]).filter((r) => r.type === "text").slice(0, 50));
      } catch { /* picker stays empty; pasting always works */ }
    })();
  }, []);

  // Debounced, free estimate whenever the input changes. This is the price-before-run display:
  // the endpoint counts fragments and reads provider settings — it sends no SERP query.
  const refreshEstimate = useCallback(async (body: { text?: string; historyId?: string }) => {
    const seq = ++estSeq.current;
    try {
      const res = await fetch("/api/seo/plagiarism/estimate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (seq === estSeq.current) setEstimate(d as EstimateUi);
    } catch {
      if (seq === estSeq.current) setEstimate(null);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      void refreshEstimate(historyId ? { historyId } : { text });
    }, 400);
    return () => clearTimeout(id);
  }, [text, historyId, refreshEstimate]);

  const loadHistoryBody = async (id: string): Promise<string> => {
    try {
      const res = await fetch(`/api/seo/history?id=${encodeURIComponent(id)}`);
      if (res.ok) {
        const d = await res.json();
        const data = d?.record?.data;
        if (typeof data === "string") return data;
        if (data && typeof data === "object") return String((data as Record<string, unknown>).text ?? "");
      }
    } catch { /* fall back to historyId-only checking */ }
    return "";
  };

  const pickHistory = async (id: string) => {
    if (!id) { setHistoryId(""); writeUrlParam("history", null); return; }
    setHistoryId(id);
    writeUrlParam("history", id);
    const body = await loadHistoryBody(id);
    if (body) setText(body);
  };

  const doRun = async () => {
    if (busy) return;
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/seo/plagiarism", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(historyId ? { historyId, confirm: true } : { text, confirm: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.notMigrated) { setMsg(t("autoSyncNotMigrated")); setBusy(false); return; }
      if (!res.ok || d.error) {
        setMsg(
          d.error === "no_serp_key" ? t("seoErrNoSerpKey")
          : d.error === "no_text" || d.error === "no_fragments" ? t("plgPaste")
          : d.error === "cap_exceeded" ? t("dmCapExceeded")
          : d.error === "provider_failed" ? `${t("errGeneric")}: ${d.detail ?? d.error}`
          : t("errGeneric"),
        );
        setBusy(false);
        return;
      }
      setRun(d.result as ResultUi);
      void refreshEstimate(historyId ? { historyId } : { text });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  // Highlighting: the run carries each fragment's offset into the NORMALIZED text, and the
  // normalizer is pure, so the same normalization runs here and the marks land exactly where
  // the checked sentences sat. Stale offsets (text edited after the run) are skipped, never
  // shown in the wrong place.
  const highlighted = useMemo(() => {
    if (!run) return null;
    const norm = normalizeTextForPlagiarism(text);
    if (!norm) return null;
    const byIndex = new Map(run.fragments.map((f) => [f.index, f]));
    const parts: { str: string; color: string | null }[] = [];
    let pos = 0;
    for (const off of [...run.offsets].sort((a, b) => a.start - b.start)) {
      const frag = byIndex.get(off.index);
      if (!frag) continue;
      const end = off.start + frag.fragment.length;
      if (off.start < pos || end > norm.length) continue;
      const ext = frag.matches.some((m) => !m.ownSite);
      const own = !ext && frag.matches.length > 0;
      if (off.start > pos) parts.push({ str: norm.slice(pos, off.start), color: null });
      parts.push({ str: norm.slice(off.start, end), color: ext ? RED : own ? BLUE : null });
      pos = end;
    }
    if (pos < norm.length) parts.push({ str: norm.slice(pos), color: null });
    return parts;
  }, [run, text]);

  const canRun = !busy && !!estimate && !estimate.error && (estimate.cached || estimate.queries > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <CopyX size={22} style={{ color: RED }} />
        <h1 className="title" style={{ margin: 0 }}>{t("plgTitle")}</h1>
      </div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("plgHint")}</div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span className="tool-field-label">{t("plgPaste")}</span>
          <span style={{ flex: 1 }} />
          <select
            className="tool-input"
            style={{ maxWidth: "320px" }}
            value={historyId}
            onChange={(e) => void pickHistory(e.target.value)}
          >
            <option value="">—</option>
            {historyList.map((h) => (
              <option key={h.id} value={h.id}>
                {(h.keyword || h.id).slice(0, 48)} · {new Date(h.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        </div>
        <textarea
          className="tool-input"
          style={{ minHeight: "180px", resize: "vertical", fontFamily: "inherit" }}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (historyId) { setHistoryId(""); writeUrlParam("history", null); }
          }}
          placeholder={t("plgPaste")}
        />

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {estimate && (
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <CostLine est={estimate} />
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="metric-action" onClick={() => void doRun()} disabled={!canRun} style={{ opacity: canRun ? 1 : 0.5 }}>
            {busy ? <Loader2 size={13} className="spin" /> : <Search size={13} />} {t("plgRun")}
          </button>
        </div>
        {msg && <div style={{ fontSize: "12px", color: RED, wordBreak: "break-word" }}>{msg}</div>}
      </div>

      {run && (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "18px", fontWeight: 700, color: run.matchedPct > 0 ? RED : GREEN }}>
              {t("plgScore").replace("{pct}", String(run.matchedPct))}
            </span>
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {run.matchedPct === 0 ? t("plgClean") : `${run.matchedFragments}/${run.sampledFragments}`}
            </span>
          </div>

          {run.sources.length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 6px", fontSize: "12px", fontWeight: 700 }}>{t("plgSources")}</h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {run.sources.map((s) => (
                  <div key={s.url} style={{ display: "flex", alignItems: "baseline", gap: "8px", fontSize: "12px", flexWrap: "wrap" }}>
                    <a href={s.url} target="_blank" rel="noreferrer" style={{ color: s.ownSite ? BLUE : "var(--color-text-primary)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }} title={s.url}>
                      {s.title || s.url} <ExternalLink size={10} style={{ display: "inline", verticalAlign: "baseline" }} />
                    </a>
                    {s.ownSite && <span className="pill" style={{ fontSize: "10px", padding: "1px 8px" }}>{t("plgOwnSite")}</span>}
                    <b style={{ marginLeft: "auto", color: "var(--color-text-primary)" }}>{s.fragments}</b>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 style={{ margin: "0 0 6px", fontSize: "12px", fontWeight: 700 }}>{t("plgFragments")}</h4>
            {highlighted && highlighted.length > 0 && (
              <p style={{ margin: "0 0 8px", fontSize: "12px", lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
                {highlighted.map((p, i) =>
                  p.color ? (
                    <mark key={i} style={{ background: "transparent", color: p.color, fontWeight: 700, textDecoration: "underline", textDecorationStyle: "dotted" }}>
                      {p.str}
                    </mark>
                  ) : (
                    <span key={i}>{p.str}</span>
                  ),
                )}
              </p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", maxHeight: "320px", overflowY: "auto" }}>
              {run.fragments.map((f) => {
                const ext = f.matches.some((m) => !m.ownSite);
                const ownOnly = !ext && f.matches.length > 0;
                const color = ext ? RED : ownOnly ? BLUE : GREEN;
                const hosts = f.matches.filter((m) => !m.ownSite).map((m) => hostOf(m.url)).filter(Boolean).slice(0, 2).join(", ");
                return (
                  <div key={f.index} style={{ display: "flex", gap: "8px", fontSize: "12px", alignItems: "baseline" }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: "999px", background: color, flexShrink: 0, alignSelf: "center" }} />
                    <span style={{ color: "var(--color-text-primary)", flex: 1 }}>{f.fragment}</span>
                    <span style={{ color: "var(--color-text-secondary)", fontSize: "11px", whiteSpace: "nowrap" }}>
                      {ext ? hosts : ownOnly ? t("plgOwnSite") : t("plgClean")}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {run.providerErrors.length > 0 && (
            <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
              {run.providerErrors.slice(0, 2).join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
