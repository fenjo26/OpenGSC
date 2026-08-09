"use client";

// AI Visibility tab ("AEO Tracker") for the site detail page.
//
// Tracked questions are asked to ChatGPT, Perplexity, Claude and Grok on the user's own keys —
// all four with live web search — and the tab reports whether the site came back cited.
//
// The design constraint that shapes this file: the user can always open ChatGPT in another tab
// and check the same question by hand. When the two disagree, a green tick or a grey dash is
// useless — the tab has to be able to show its work. So a row expands into the full answer the
// engine gave, every domain it cited, where we placed among them, which model produced it and
// whether a live search actually ran. "Not cited" stops being an assertion and becomes
// something the user can read for themselves.
//
// The competitor panel falls out of the same data for free: the domains cited instead of us,
// counted across every tracked question, is the most actionable thing an AEO report can say.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus, RefreshCw, Trash2, ChevronDown, ChevronUp, ChevronsUpDown, Search,
  Sparkles, Check, Minus, Settings2, ExternalLink, Globe, AlertTriangle, MessageSquareQuote,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import { getOpenAiKey } from "@/lib/seo/geoClient";
import { rankModels, OPENAI_FALLBACK_MODELS, type ModelOpt } from "@/lib/seo/models";
import BrandVisibility from "@/components/BrandVisibility";

const ENGINES = ["chatgpt", "perplexity", "claude", "grok"] as const;
type Engine = typeof ENGINES[number];
const ENGINE_LABEL: Record<Engine, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", grok: "Grok" };
const ENGINE_COLOR: Record<Engine, string> = { chatgpt: "#10A37F", perplexity: "#20808D", claude: "#CF6B4A", grok: "#6B7280" };

const GREEN = "#10B981";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const VIOLET = "#8B5CF6";


type Status = "cited" | "mentioned" | "absent";

type EngineResult = {
  cited: boolean; status: Status; url: string | null; rank: number | null;
  citedDomains: string[]; searched: boolean; model: string | null;
  checkedAt: string; error?: string | null;
} | undefined;

type AeoRow = {
  id: string; question: string; createdAt: string; lastCheckedAt: string | null;
  results: Partial<Record<Engine, EngineResult>>;
};

type Settings = {
  model: string; country: string | null; inheritedCountry: string | null;
  city: string | null; language: string | null; auto: boolean;
};

type Citation = { url: string; domain: string; title: string };
type Check = {
  id: string; engine: Engine; checkedAt: string; cited: boolean; status: Status | null;
  url: string | null; snippet: string | null; rank: number | null; model: string | null;
  searched: boolean | null; error: string | null;
};

type SortKey = "question" | "score" | "checked";

// ─── Small shared bits ───────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
};
const primaryBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
  border: "1.5px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.08)", color: VIOLET,
  fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};
const ghostBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
  border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)",
  fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};
const labelStyle: React.CSSProperties = {
  fontSize: "10px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
  color: "var(--color-text-tertiary)", marginBottom: "4px", display: "block",
};

function statusOf(r: NonNullable<EngineResult>): Status {
  return r.status ?? (r.cited ? "cited" : "absent");
}

function EngineCell({ result, configured, blurStyle }: {
  result: EngineResult; configured: boolean; blurStyle: React.CSSProperties;
}) {
  const { t } = useLanguage();
  if (!configured) return <span title={t("aeoEngineOff")} style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>—</span>;
  if (!result) return <span style={{ color: "var(--color-text-secondary)", fontSize: "12px" }}>…</span>;
  if (result.error) return <span title={result.error} style={{ color: RED, fontSize: "11px", fontWeight: 600 }}>error</span>;

  const st = statusOf(result);
  const body = st === "cited" ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", fontWeight: 700, color: GREEN }}>
      <Check size={13} /> {t("aeoCited")}{result.rank ? <span style={{ opacity: 0.7, fontWeight: 600 }}>#{result.rank}</span> : null}
    </span>
  ) : st === "mentioned" ? (
    <span title={t("aeoMentionedHint")} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", fontWeight: 700, color: AMBER }}>
      <MessageSquareQuote size={13} /> {t("aeoMentioned")}
    </span>
  ) : (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", fontWeight: 700, color: "var(--color-text-secondary)" }}>
      <Minus size={13} /> {t("aeoNotCited")}
    </span>
  );

  // A "not cited" verdict from an answer where the model never searched is not the same claim,
  // and saying so here is cheaper than making the user open the row to find out.
  const warn = !result.searched && st !== "cited"
    ? <AlertTriangle size={11} color={AMBER} style={{ marginLeft: "4px", verticalAlign: "-1px" }} />
    : null;

  const inner = <>{body}{warn}</>;
  if (st === "cited" && result.url) {
    return (
      <a href={result.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
        style={{ textDecoration: "none", ...blurStyle }} title={result.url}>{inner}</a>
    );
  }
  return <span title={!result.searched ? t("aeoNoSearchHint") : undefined}>{inner}</span>;
}

// ─── Settings panel ──────────────────────────────────────────────────────────

function SettingsPanel({ siteDbId, settings, onChange }: {
  siteDbId: string; settings: Settings; onChange: (s: Settings) => void;
}) {
  const { t } = useLanguage();
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [modelsState, setModelsState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // The live model list is pulled from the account with the user's own key, exactly like the
  // provider picker in Settings. Nothing here knows this month's model id: whatever OpenAI
  // currently serves shows up, newest generation first.
  useEffect(() => {
    const apiKey = getOpenAiKey();
    if (!apiKey) { setModelsState("error"); return; }
    setModelsState("loading");
    fetch("/api/seo/models", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey }),
    })
      .then(r => r.json())
      .then(d => {
        const list: ModelOpt[] = Array.isArray(d?.models) ? d.models : [];
        setModels(rankModels(list));
        setModelsState(list.length ? "ok" : "error");
      })
      .catch(() => setModelsState("error"));
  }, []);

  // The site may have been created before the model field existed, or be pinned to a model the
  // account no longer offers. Either way, resolve to a live one rather than sending a dead id
  // to the API and reporting the 404 as "not cited".
  const options: ModelOpt[] = models.length
    ? (models.some(m => m.id === settings.model) ? models : [{ id: settings.model, label: `${settings.model} — ${t("aeoSettingsModelUnavailable")}` }, ...models])
    : OPENAI_FALLBACK_MODELS.map(id => ({ id, label: id }));

  const save = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    onChange(next);
    setSaving(true); setSaved(false);
    try {
      const r = await fetch("/api/aeo/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId: siteDbId, model: next.model, country: next.country ?? "",
          city: next.city ?? "", language: next.language ?? "", auto: next.auto,
        }),
      });
      if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1600); }
    } finally { setSaving(false); }
  }, [settings, onChange, siteDbId]);

  const effectiveCountry = settings.country || settings.inheritedCountry;

  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
        <Settings2 size={14} color="var(--color-text-secondary)" />
        <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--color-text-secondary)" }}>
          {t("aeoSettings")}
        </span>
        {saving && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>…</span>}
        {saved && <span style={{ fontSize: "11px", color: GREEN, fontWeight: 600 }}>{t("aeoSettingsSaved")}</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}>
        <div>
          <label style={labelStyle}>
            {t("aeoSettingsModel")}
            {modelsState === "loading" && <span style={{ marginLeft: "6px", textTransform: "none", fontWeight: 500 }}>…</span>}
          </label>
          <select value={settings.model} onChange={e => save({ model: e.target.value })} style={{ ...inputStyle, width: "100%" }}>
            {options.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {modelsState === "error" && (
            <div style={{ fontSize: "10.5px", color: AMBER, marginTop: "4px", lineHeight: 1.45 }}>{t("aeoSettingsModelOffline")}</div>
          )}
        </div>

        <div>
          <label style={labelStyle}>{t("aeoSettingsCountry")}</label>
          <select value={settings.country ?? ""} onChange={e => save({ country: e.target.value || null })} style={{ ...inputStyle, width: "100%" }}>
            <option value="">
              {settings.inheritedCountry
                ? `${t("aeoSettingsCountryInherit")} — ${settings.inheritedCountry.toUpperCase()}`
                : t("aeoSettingsNoLocation")}
            </option>
            {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>

        <div>
          <label style={labelStyle}>{t("aeoSettingsCity")}</label>
          <input
            defaultValue={settings.city ?? ""}
            onBlur={e => { const v = e.target.value.trim(); if (v !== (settings.city ?? "")) save({ city: v || null }); }}
            placeholder={t("aeoSettingsCityPlaceholder")}
            disabled={!effectiveCountry}
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box", opacity: effectiveCountry ? 1 : 0.5 }}
          />
        </div>

        <div>
          <label style={labelStyle}>{t("aeoSettingsLanguage")}</label>
          <select value={settings.language ?? ""} onChange={e => save({ language: e.target.value || null })} style={{ ...inputStyle, width: "100%" }}>
            <option value="">{t("aeoSettingsLanguageAuto")}</option>
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--color-border)" }}>
        <input id="aeo-auto" type="checkbox" checked={settings.auto} onChange={e => save({ auto: e.target.checked })}
          style={{ marginTop: "2px", cursor: "pointer", accentColor: VIOLET }} />
        <label htmlFor="aeo-auto" style={{ cursor: "pointer" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("aeoSettingsAuto")}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5, marginTop: "2px" }}>{t("aeoSettingsAutoHint")}</div>
        </label>
      </div>

      <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.55, marginTop: "10px" }}>
        {t("aeoSettingsGeoHint")}
      </div>
    </div>
  );
}

// ─── Expanded row: the evidence ──────────────────────────────────────────────

function EngineHistoryStrip({ checks }: { checks: Check[] }) {
  const { t } = useLanguage();
  if (!checks.length) return null;
  const recent = checks.slice(-40);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <div style={{ display: "flex", gap: "2px", alignItems: "center" }}>
        {recent.map((c, i) => {
          const st = c.status ?? (c.cited ? "cited" : "absent");
          return (
            <span key={i}
              title={`${new Date(c.checkedAt).toLocaleDateString()} — ${c.error ? "error" : st === "cited" ? t("aeoCited") : st === "mentioned" ? t("aeoMentioned") : t("aeoNotCited")}`}
              style={{
                width: "8px", height: "8px", borderRadius: "2px", flexShrink: 0,
                background: c.error ? RED : st === "cited" ? GREEN : st === "mentioned" ? AMBER : "var(--color-border)",
              }} />
          );
        })}
      </div>
      <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
        {recent.filter(c => (c.status ?? (c.cited ? "cited" : "absent")) === "cited").length}/{recent.length}
      </span>
    </div>
  );
}

function CitationList({ citations, host, blurStyle }: { citations: Citation[]; host: string; blurStyle: React.CSSProperties }) {
  const { t } = useLanguage();
  if (!citations.length) return null;

  // Deduped by domain, in the order the engine cited them — position in this list is the rank
  // the row header reports, so the two must be built the same way.
  const seen = new Set<string>();
  const rows: { n: number; c: Citation; ours: boolean }[] = [];
  for (const c of citations) {
    if (seen.has(c.domain)) continue;
    seen.add(c.domain);
    rows.push({ n: rows.length + 1, c, ours: !!host && (c.domain === host || c.domain.endsWith("." + host)) });
  }

  return (
    <div>
      <div style={labelStyle}>{t("aeoCitedSources")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        {rows.map(({ n, c, ours }) => (
          <a key={c.url} href={c.url} target="_blank" rel="noreferrer"
            style={{
              display: "flex", alignItems: "center", gap: "8px", padding: "5px 8px", borderRadius: "6px",
              textDecoration: "none", fontSize: "12px",
              background: ours ? "rgba(16,185,129,0.1)" : "transparent",
              border: ours ? "1px solid rgba(16,185,129,0.3)" : "1px solid transparent",
            }}>
            <span style={{ width: "18px", flexShrink: 0, color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{n}</span>
            <span style={{ fontWeight: ours ? 700 : 600, color: ours ? GREEN : "var(--color-text-primary)", ...blurStyle }}>{c.domain}</span>
            {ours && <span style={{ fontSize: "10px", fontWeight: 700, color: GREEN, textTransform: "uppercase" }}>{t("aeoYourSite")}</span>}
            <span style={{ color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{c.title}</span>
            <ExternalLink size={11} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
          </a>
        ))}
      </div>
    </div>
  );
}

function DetailPanel({ questionId, host, configured, blurStyle }: {
  questionId: string; host: string; configured: Engine[]; blurStyle: React.CSSProperties;
}) {
  const { t } = useLanguage();
  const [data, setData] = useState<{ checks: Check[]; latest: Record<string, { answerText: string | null; citations: Citation[] }> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Engine | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/aeo/history?questionId=${encodeURIComponent(questionId)}&days=90`)
      .then(r => r.json())
      .then(d => {
        setData(d);
        const withAnswer = ENGINES.find(e => d?.latest?.[e]?.answerText);
        setTab(withAnswer ?? configured[0] ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [questionId, configured]);

  if (loading) return <div style={{ padding: "20px", fontSize: "13px", color: "var(--color-text-secondary)" }}>Loading…</div>;

  const checks = data?.checks ?? [];
  if (!checks.length) return <div style={{ padding: "20px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("aeoNoHistory")}</div>;

  const present = ENGINES.filter(e => checks.some(c => c.engine === e));
  const active = tab && present.includes(tab) ? tab : present[0];
  const latest = active ? [...checks].reverse().find(c => c.engine === active) ?? null : null;
  const detail = active ? data?.latest?.[active] : undefined;

  return (
    <div style={{ padding: "14px 16px 18px" }}>
      <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
        {present.map(e => (
          <button key={e} onClick={() => setTab(e)}
            style={{
              padding: "5px 12px", borderRadius: "999px", fontSize: "12px", fontWeight: 700, cursor: "pointer",
              border: `1px solid ${active === e ? ENGINE_COLOR[e] : "var(--color-border)"}`,
              background: active === e ? `${ENGINE_COLOR[e]}1A` : "transparent",
              color: active === e ? ENGINE_COLOR[e] : "var(--color-text-secondary)",
            }}>
            {ENGINE_LABEL[e]}
          </button>
        ))}
      </div>

      {latest?.error && (
        <div style={{ padding: "10px 12px", borderRadius: "8px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", color: RED, fontSize: "12px", marginBottom: "12px", wordBreak: "break-word" }}>
          {latest.error}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap", fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "12px" }}>
        {latest?.model && <span>{t("aeoDetailModel")}: <b style={{ color: "var(--color-text-secondary)" }}>{latest.model}</b></span>}
        <span>
          {t("aeoDetailSearch")}:{" "}
          <b style={{ color: latest?.searched ? GREEN : AMBER }}>{latest?.searched ? t("aeoDetailSearchYes") : t("aeoDetailSearchNo")}</b>
        </span>
        {latest?.rank && <span>{t("aeoDetailRank")}: <b style={{ color: "var(--color-text-secondary)" }}>#{latest.rank}</b></span>}
        <EngineHistoryStrip checks={checks.filter(c => c.engine === active)} />
      </div>

      {latest && latest.searched === false && (
        <div style={{ padding: "10px 12px", borderRadius: "8px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)", color: AMBER, fontSize: "12px", marginBottom: "12px", lineHeight: 1.55 }}>
          {t("aeoNoSearchHint")}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: "18px" }}>
        <div>
          <div style={labelStyle}>{t("aeoAnswerText")}</div>
          {detail?.answerText ? (
            <div style={{
              fontSize: "12.5px", lineHeight: 1.65, color: "var(--color-text-primary)", whiteSpace: "pre-wrap",
              maxHeight: "340px", overflowY: "auto", padding: "10px 12px", borderRadius: "8px",
              background: "var(--color-bg)", border: "1px solid var(--color-border)", ...blurStyle,
            }}>
              {detail.answerText}
            </div>
          ) : (
            <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", lineHeight: 1.6 }}>{t("aeoNoAnswerStored")}</div>
          )}
        </div>
        <CitationList citations={detail?.citations ?? []} host={host} blurStyle={blurStyle} />
      </div>
    </div>
  );
}

// ─── Competitor panel ────────────────────────────────────────────────────────

function Competitors({ rows, host, configured, blurStyle }: {
  rows: AeoRow[]; host: string; configured: Engine[]; blurStyle: React.CSSProperties;
}) {
  const { t } = useLanguage();

  const list = useMemo(() => {
    const counts = new Map<string, number>();
    let citedAnswers = 0;
    for (const r of rows) {
      for (const e of configured) {
        const res = r.results[e];
        if (!res || res.error || !res.citedDomains?.length) continue;
        citedAnswers++;
        for (const d of new Set(res.citedDomains)) {
          if (!d || d === host || d.endsWith("." + host)) continue;
          counts.set(d, (counts.get(d) ?? 0) + 1);
        }
      }
    }
    const total = Math.max(1, citedAnswers);
    return [...counts.entries()]
      .map(([domain, n]) => ({ domain, n, share: Math.round((n / total) * 100) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12);
  }, [rows, host, configured]);

  if (!list.length) return null;
  const max = list[0].n;

  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
        <Globe size={14} color={VIOLET} />
        <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aeoCompetitors")}</span>
      </div>
      <div style={{ fontSize: "11.5px", color: "var(--color-text-secondary)", marginBottom: "12px", lineHeight: 1.5 }}>{t("aeoCompetitorsHint")}</div>

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {list.map(({ domain, n, share }) => (
          <div key={domain} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ width: "190px", flexShrink: 0, fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...blurStyle }} title={domain}>
              {domain}
            </span>
            <div style={{ flex: 1, height: "8px", borderRadius: "4px", background: "var(--color-bg)", overflow: "hidden" }}>
              <div style={{ width: `${Math.max(4, (n / max) * 100)}%`, height: "100%", borderRadius: "4px", background: VIOLET, opacity: 0.75 }} />
            </div>
            <span style={{ width: "72px", textAlign: "right", flexShrink: 0, fontSize: "11px", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
              {n} · {share}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Table header ────────────────────────────────────────────────────────────

function SortableTh({ label, active, dir, align = "center", onClick }: {
  label: string; active: boolean; dir: "asc" | "desc"; align?: "left" | "center"; onClick: () => void;
}) {
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

// ─── Main ────────────────────────────────────────────────────────────────────

export default function AeoTracker({ siteDbId }: { siteDbId: string; domain?: string }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};

  const [rows, setRows] = useState<AeoRow[]>([]);
  const [host, setHost] = useState("");
  const [configuredEngines, setConfiguredEngines] = useState<Engine[]>([]);
  const [hasAnyKey, setHasAnyKey] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
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
        setHost(d.host ?? "");
      }
    } catch { /* ignore */ }
  }, [siteDbId]);

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  useEffect(() => {
    if (!siteDbId) return;
    fetch(`/api/aeo/settings?siteId=${encodeURIComponent(siteDbId)}`)
      .then(r => r.json()).then(d => { if (d && !d.error) setSettings(d); }).catch(() => {});
  }, [siteDbId]);

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
        // Deliberately not auto-checking here: a paste of thirty questions is four billed API
        // calls each on the user's own key. Adding a question and paying for it are separate
        // decisions, and the user makes the second one with the button.
      }
    } finally { setBusy(null); }
  };

  const checkAll = async () => {
    if (busy) return;
    if (!confirm(t("aeoCheckAllConfirm"))) return;
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
  const scoreOf = useCallback(
    (r: AeoRow) => configuredEngines.filter(e => r.results[e] && statusOf(r.results[e]!) === "cited").length,
    [configuredEngines],
  );

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
  }, [rows, search, sortKey, sortDir, scoreOf]);

  const stats = useMemo(() => {
    const citedAnywhere = rows.filter(r => scoreOf(r) > 0).length;
    const mentionedOnly = rows.filter(r =>
      scoreOf(r) === 0 && configuredEngines.some(e => r.results[e] && statusOf(r.results[e]!) === "mentioned"),
    ).length;
    const perEngine = configuredEngines.map(e => ({
      engine: e, cited: rows.filter(r => r.results[e] && statusOf(r.results[e]!) === "cited").length,
    }));
    return { total: rows.length, citedAnywhere, mentionedOnly, perEngine };
  }, [rows, configuredEngines, scoreOf]);

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: "24px", width: "100%", boxSizing: "border-box" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={17} color={VIOLET} /> {t("aeoTitle")}
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
          <button onClick={() => setShowSettings(s => !s)} style={ghostBtn}>
            <Settings2 size={13} /> {t("aeoSettings")}
          </button>
          <button onClick={checkAll} disabled={!!busy || !rows.length}
            style={{ ...(rows.length ? primaryBtn : ghostBtn), cursor: busy || !rows.length ? "not-allowed" : "pointer", opacity: busy || !rows.length ? 0.6 : 1 }}>
            <RefreshCw size={13} style={{ animation: busy === "check" ? "spin 1.2s linear infinite" : "none" }} />
            {busy === "check" ? (progress || t("aeoChecking")) : t("aeoCheckAll")}
          </button>
        </div>
      </div>

      {/* ── No key warning ── */}
      {!loading && !hasAnyKey && (
        <div style={{ padding: "12px 16px", borderRadius: "10px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", color: AMBER, fontSize: "13px" }}>
          ⚠ {t("aeoNoKey")}{" "}
          <a href="/settings?tab=api-keys" style={{ color: AMBER, fontWeight: 700, textDecoration: "underline" }}>{t("aeoNoKeyLink")}</a>
        </div>
      )}

      {showSettings && settings && (
        <SettingsPanel siteDbId={siteDbId} settings={settings} onChange={setSettings} />
      )}

      {/* ── Summary stats ── */}
      {rows.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "36px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1.2 }}>{stats.total}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("aeoStatQuestions")}</div>
          </div>
          <div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: GREEN, lineHeight: 1.2 }}>{stats.citedAnywhere}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("aeoStatCitedAnywhere")}</div>
          </div>
          {stats.mentionedOnly > 0 && (
            <div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: AMBER, lineHeight: 1.2 }}>{stats.mentionedOnly}</div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("aeoStatMentionedOnly")}</div>
            </div>
          )}
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
            <Sparkles size={22} color={VIOLET} />
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
                        <EngineCell result={r.results[e]} configured={configuredEngines.includes(e)} blurStyle={blurStyle} />
                      </td>
                    ))}
                    <td style={{ padding: "10px 12px", color: "var(--color-text-secondary)", fontSize: "11px", whiteSpace: "nowrap" }}>
                      {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => checkOne(r.id)} disabled={!!busy} title={t("aeoCheckOne")}
                        style={{ background: "none", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--color-text-secondary)", padding: "4px" }}>
                        <RefreshCw size={13} />
                      </button>
                      <button onClick={() => del(r.id)} title={t("aeoDeleteConfirm")}
                        style={{ background: "none", border: "none", cursor: "pointer", color: RED, padding: "4px", opacity: 0.7 }}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr>
                      <td colSpan={ENGINES.length + 3} style={{ padding: 0, borderBottom: "1px solid var(--color-border)", background: "rgba(139,92,246,0.02)" }}>
                        <DetailPanel questionId={r.id} host={host} configured={configuredEngines} blurStyle={blurStyle} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && <Competitors rows={rows} host={host} configured={configuredEngines} blurStyle={blurStyle} />}

      {/* Second source, deliberately below the live checks rather than merged into them. The
          table above is today's answer to questions you chose; this is an index of what models
          have been answering generally, including questions you never thought to track. */}
      <BrandVisibility siteDbId={siteDbId} />
    </div>
  );
}
