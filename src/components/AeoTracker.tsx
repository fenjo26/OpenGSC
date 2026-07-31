"use client";

// AI Visibility tab ("AEO Tracker") for the site detail page.
// Tracked questions are checked across AI answer engines (ChatGPT, Perplexity, Claude, Grok)
// via the user's configured keys (Settings → SEO Tools) by the in-app scheduler, or on demand
// with "Check now". ChatGPT/Perplexity use live web search (a citation URL on our domain is
// the strongest signal); Claude/Grok fall back to brand-mention matching in the plain answer.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, RefreshCw, Trash2, ChevronDown, ChevronUp, ChevronsUpDown, Search,
  Sparkles, Check, Minus,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import BrandVisibility from "@/components/BrandVisibility";

const ENGINES = ["chatgpt", "perplexity", "claude", "grok"] as const;
type Engine = typeof ENGINES[number];
const ENGINE_LABEL: Record<Engine, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", grok: "Grok" };
const ENGINE_COLOR: Record<Engine, string> = { chatgpt: "#10A37F", perplexity: "#20808D", claude: "#CF6B4A", grok: "#6B7280" };

type EngineResult = { cited: boolean; url: string | null; checkedAt: string; error?: string | null } | undefined;

type AeoRow = {
  id: string; question: string; createdAt: string; lastCheckedAt: string | null;
  results: Partial<Record<Engine, EngineResult>>;
};

type SortKey = "question" | "score" | "checked";

function EngineCell({ engine, result, configured, blurStyle }: {
  engine: Engine; result: EngineResult; configured: boolean; blurStyle: React.CSSProperties;
}) {
  const { t } = useLanguage();
  if (!configured) {
    return <span title={t("aeoEngineOff")} style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>—</span>;
  }
  if (!result) return <span style={{ color: "var(--color-text-secondary)", fontSize: "12px" }}>…</span>;
  if (result.error) return <span title={result.error} style={{ color: "#EF4444", fontSize: "11px" }}>error</span>;

  const chip = (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", fontWeight: 700,
      color: result.cited ? "#10B981" : "var(--color-text-secondary)",
    }}>
      {result.cited ? <Check size={13} /> : <Minus size={13} />} {result.cited ? t("aeoCited") : t("aeoNotCited")}
    </span>
  );

  if (result.cited && result.url) {
    return (
      <a href={result.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
        style={{ textDecoration: "none", ...blurStyle }} title={result.url}>
        {chip}
      </a>
    );
  }
  return chip;
}

// Compact per-engine history strip: last N checks as small colored squares (cited = green,
// not cited = muted, error = red), most recent last.
function EngineHistoryRow({ engine, checks }: {
  engine: Engine; checks: { checkedAt: string; cited: boolean; url: string | null; error: string | null }[];
}) {
  const { t } = useLanguage();
  if (!checks.length) return null;
  const recent = checks.slice(-30);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "6px 0" }}>
      <span style={{ width: "84px", flexShrink: 0, fontSize: "12px", fontWeight: 700, color: ENGINE_COLOR[engine] }}>{ENGINE_LABEL[engine]}</span>
      <div style={{ display: "flex", gap: "2px", alignItems: "center" }}>
        {recent.map((c, i) => (
          <span key={i}
            title={`${new Date(c.checkedAt).toLocaleDateString()} — ${c.error ? "error" : c.cited ? t("aeoCited") : t("aeoNotCited")}`}
            style={{
              width: "8px", height: "8px", borderRadius: "2px", flexShrink: 0,
              background: c.error ? "#EF4444" : c.cited ? "#10B981" : "var(--color-border)",
            }} />
        ))}
      </div>
      <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
        {recent.filter(c => c.cited).length}/{recent.length}
      </span>
    </div>
  );
}

function HistoryPanel({ questionId }: { questionId: string }) {
  const { t } = useLanguage();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/aeo/history?questionId=${encodeURIComponent(questionId)}&days=90`)
      .then(r => r.json()).then(d => setData(d)).catch(() => {}).finally(() => setLoading(false));
  }, [questionId]);

  if (loading) return <div style={{ padding: "20px", fontSize: "13px", color: "var(--color-text-secondary)" }}>Loading…</div>;
  const checks: any[] = data?.checks ?? [];
  if (!checks.length) return <div style={{ padding: "20px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("aeoNoHistory")}</div>;

  return (
    <div style={{ padding: "12px 16px" }}>
      {ENGINES.map(e => (
        <EngineHistoryRow key={e} engine={e} checks={checks.filter((c: any) => c.engine === e)} />
      ))}
    </div>
  );
}

type SortableThProps = { label: string; active: boolean; dir: "asc" | "desc"; align?: "left" | "center"; onClick: () => void };
function SortableTh({ label, active, dir, align = "center", onClick }: SortableThProps) {
  return (
    <th onClick={onClick} style={{
      textAlign: align, padding: "10px 12px", cursor: "pointer", userSelect: "none",
      color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
      fontWeight: 600, fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap",
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", justifyContent: align === "center" ? "center" : "flex-start" }}>
        {label}
        {active ? (dir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <ChevronsUpDown size={11} style={{ opacity: 0.35 }} />}
      </span>
    </th>
  );
}

export default function AeoTracker({ siteDbId }: { siteDbId: string; domain?: string }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};

  const [rows, setRows] = useState<AeoRow[]>([]);
  const [configuredEngines, setConfiguredEngines] = useState<Engine[]>([]);
  const [hasAnyKey, setHasAnyKey] = useState(true);
  const [loading, setLoading] = useState(true);
  const [qText, setQText] = useState("");
  const [busy, setBusy] = useState<null | "add" | "check">(null);
  const [progress, setProgress] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "question" ? "asc" : "desc"); }
  };

  const load = useCallback(async () => {
    if (!siteDbId) return;
    try {
      const r = await fetch(`/api/aeo/questions?siteId=${encodeURIComponent(siteDbId)}`);
      const d = await r.json();
      if (Array.isArray(d.questions)) {
        setRows(d.questions);
        setConfiguredEngines(d.engines ?? []);
        setHasAnyKey(!!d.hasAnyKey);
      }
    } catch { /* ignore */ }
  }, [siteDbId]);

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  // Run /api/aeo/check in a loop until nothing remains (5 questions per call).
  const runChecks = useCallback(async (body: Record<string, unknown>) => {
    for (let i = 0; i < 40; i++) {
      const r = await fetch("/api/aeo/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, ...body }),
      });
      const d = await r.json();
      if (!r.ok) { setProgress(d?.error === "no_aeo_key" ? t("aeoNoKey") : (d?.error || "error")); return; }
      await load();
      if (!d.remaining) break;
      setProgress(`${t("aeoChecking")} ${d.remaining}…`);
    }
    setProgress("");
  }, [siteDbId, load, t]);

  const addQuestions = async () => {
    const list = qText.split("\n").map(s => s.trim()).filter(Boolean);
    if (!list.length || busy) return;
    setBusy("add");
    try {
      const r = await fetch("/api/aeo/questions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, questions: list }),
      });
      if (r.ok) {
        setQText("");
        await load();
        await runChecks({});
      }
    } finally { setBusy(null); }
  };

  const checkAll = async () => {
    if (busy) return;
    setBusy("check");
    setProgress(t("aeoChecking"));
    try { await runChecks({ force: true }); } finally { setBusy(null); setProgress(""); }
  };

  const checkOne = async (id: string) => {
    if (busy) return;
    setBusy("check");
    try { await runChecks({ questionId: id }); } finally { setBusy(null); }
  };

  const del = async (id: string) => {
    if (!confirm(t("aeoDeleteConfirm"))) return;
    await fetch("/api/aeo/questions", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteId: siteDbId, ids: [id] }),
    });
    setRows(rs => rs.filter(r => r.id !== id));
  };

  // "Score" = how many configured engines currently cite us for this question.
  const scoreOf = (r: AeoRow) => configuredEngines.filter(e => r.results[e]?.cited).length;

  const visible = useMemo(() => {
    let list = rows;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r => r.question.toLowerCase().includes(q));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "question": return a.question.localeCompare(b.question) * dir;
        case "score": return (scoreOf(a) - scoreOf(b)) * dir;
        case "checked": {
          const av = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : -1;
          const bv = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : -1;
          return (av - bv) * dir;
        }
        default: return 0;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, sortKey, sortDir, configuredEngines]);

  const stats = useMemo(() => {
    const citedAnywhere = rows.filter(r => scoreOf(r) > 0).length;
    const perEngine = configuredEngines.map(e => ({
      engine: e, cited: rows.filter(r => r.results[e]?.cited).length,
    }));
    return { total: rows.length, citedAnywhere, perEngine };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, configuredEngines]);

  const primaryBtn: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
    border: "1.5px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.08)", color: "#8B5CF6",
    fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  };
  const ghostBtn: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
    border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)",
    fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
  };
  const inputStyle: React.CSSProperties = {
    padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
    background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
  };

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: "24px", width: "100%", boxSizing: "border-box" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={17} color="#8B5CF6" /> {t("aeoTitle")}
          </h2>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("aeoSubtitle")}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <a href="/settings?tab=api-keys" title={t("aeoEnginesHint")}
            style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", padding: "6px 12px", borderRadius: "999px", border: "1px solid var(--color-border)", background: "var(--color-card)", textDecoration: "none" }}>
            {ENGINES.map(e => (
              <span key={e} style={{ width: "7px", height: "7px", borderRadius: "50%", background: configuredEngines.includes(e) ? ENGINE_COLOR[e] : "var(--color-border)" }} title={ENGINE_LABEL[e]} />
            ))}
            {configuredEngines.length}/4
          </a>
          <button onClick={checkAll} disabled={!!busy || !rows.length}
            style={{ ...(rows.length ? primaryBtn : ghostBtn), cursor: busy || !rows.length ? "not-allowed" : "pointer", opacity: busy || !rows.length ? 0.6 : 1 }}>
            <RefreshCw size={13} style={{ animation: busy === "check" ? "spin 1.2s linear infinite" : "none" }} />
            {busy === "check" ? (progress || t("aeoChecking")) : t("aeoCheckAll")}
          </button>
        </div>
      </div>

      {/* ── No key warning ── */}
      {!loading && !hasAnyKey && (
        <div style={{ padding: "12px 16px", borderRadius: "10px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", color: "#F59E0B", fontSize: "13px" }}>
          ⚠ {t("aeoNoKey")}{" "}
          <a href="/settings?tab=api-keys" style={{ color: "#F59E0B", fontWeight: 700, textDecoration: "underline" }}>{t("aeoNoKeyLink")}</a>
        </div>
      )}

      {/* ── Summary stats ── */}
      {rows.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "36px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1.2 }}>{stats.total}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("aeoStatQuestions")}</div>
          </div>
          <div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: "#10B981", lineHeight: 1.2 }}>{stats.citedAnywhere}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("aeoStatCitedAnywhere")}</div>
          </div>
          {stats.perEngine.map(({ engine, cited }) => (
            <div key={engine}>
              <div style={{ fontSize: "22px", fontWeight: 700, color: ENGINE_COLOR[engine], lineHeight: 1.2 }}>{cited}/{stats.total}</div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{ENGINE_LABEL[engine]}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Add questions card ── */}
      <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "16px" }}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "10px" }}>
          {t("aeoAddBtn")}
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "stretch", flexWrap: "wrap" }}>
          <textarea
            value={qText}
            onChange={e => setQText(e.target.value)}
            placeholder={t("aeoAddPlaceholder")}
            rows={2}
            style={{ ...inputStyle, flex: "1 1 340px", minHeight: "40px", maxHeight: "120px", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
          />
          <button onClick={addQuestions} disabled={!qText.trim() || !!busy}
            style={{ ...primaryBtn, height: "40px", opacity: qText.trim() && !busy ? 1 : 0.5, cursor: qText.trim() && !busy ? "pointer" : "not-allowed" }}>
            <Plus size={13} /> {busy === "add" ? "…" : t("aeoAddBtn")}
          </button>
        </div>
        <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "8px", lineHeight: 1.5 }}>
          💡 {t("aeoHintAdd")}
        </div>
      </div>

      {/* ── Search ── */}
      {rows.length > 8 && (
        <div style={{ position: "relative", maxWidth: "280px" }}>
          <Search size={13} style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--color-text-secondary)" }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            style={{ ...inputStyle, width: "100%", paddingLeft: "30px", boxSizing: "border-box" }} />
        </div>
      )}

      {/* ── Table / empty state ── */}
      {loading ? (
        <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: "56px 24px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "12px", background: "var(--color-card)" }}>
          <div style={{ width: "44px", height: "44px", borderRadius: "12px", background: "rgba(139,92,246,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
            <Sparkles size={22} color="#8B5CF6" />
          </div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "6px" }}>{t("aeoNoQuestions")}</div>
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", maxWidth: "440px", margin: "0 auto", lineHeight: 1.55 }}>{t("aeoNoQuestionsDesc")}</div>
        </div>
      ) : (
        <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
                <SortableTh label={t("aeoColQuestion")} align="left" active={sortKey === "question"} dir={sortDir} onClick={() => toggleSort("question")} />
                {ENGINES.map(e => (
                  <th key={e} style={{ textAlign: "center", padding: "10px 12px", color: "var(--color-text-secondary)", fontWeight: 600, fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                    {ENGINE_LABEL[e]}
                  </th>
                ))}
                <SortableTh label={t("aeoColChecked")} active={sortKey === "checked"} dir={sortDir} onClick={() => toggleSort("checked")} />
                <th style={{ padding: "10px 12px" }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => setExpanded(e => e === r.id ? null : r.id)}
                    style={{ borderBottom: "1px solid var(--color-border)", background: expanded === r.id ? "rgba(139,92,246,0.04)" : i % 2 === 1 ? "rgba(128,128,128,0.03)" : "transparent", cursor: "pointer" }}>
                    <td style={{ padding: "10px 12px", maxWidth: "320px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ color: "var(--color-text-secondary)", display: "flex", flexShrink: 0 }}>
                          {expanded === r.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </span>
                        <span style={{ fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...blurStyle }} title={r.question}>
                          {r.question}
                        </span>
                      </div>
                    </td>
                    {ENGINES.map(e => (
                      <td key={e} style={{ padding: "10px 12px", textAlign: "center" }}>
                        <EngineCell engine={e} result={r.results[e]} configured={configuredEngines.includes(e)} blurStyle={blurStyle} />
                      </td>
                    ))}
                    <td style={{ padding: "10px 12px", color: "var(--color-text-secondary)", fontSize: "11px", whiteSpace: "nowrap" }}>
                      {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => checkOne(r.id)} disabled={!!busy} title={t("aeoCheckAll")}
                        style={{ background: "none", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--color-text-secondary)", padding: "4px" }}>
                        <RefreshCw size={13} />
                      </button>
                      <button onClick={() => del(r.id)} title={t("aeoDeleteConfirm")}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#EF4444", padding: "4px", opacity: 0.7 }}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr>
                      <td colSpan={ENGINES.length + 3} style={{ padding: 0, borderBottom: "1px solid var(--color-border)", background: "rgba(139,92,246,0.02)" }}>
                        <HistoryPanel questionId={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Second source, deliberately below the live checks rather than merged into them. The
          table above is today's answer to questions you chose; this is an index of what models
          have been answering generally, including questions you never thought to track. */}
      <BrandVisibility siteDbId={siteDbId} />
    </div>
  );
}
