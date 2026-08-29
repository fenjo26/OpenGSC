"use client";

import { useEffect, useState } from "react";
import { Globe, Loader2, AlertTriangle, Plus, Trash2, Clock, ArrowRight, FileDown } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES, LANGUAGES, defaultLanguageFor } from "@/lib/seo/regions";
import { readUrlParam } from "@/lib/urlParam";
import { buildGeoMarkdown } from "@/lib/seo/geoExportMd";
import GeoAuditReport from "@/components/GeoAuditReport";
import type { GeoReport } from "@/lib/seo/geo";
import {
  startGeoAudit, getGeoAudit, listGeoAudits, deleteGeoAudit, parseReport,
  getOpenAiKey, getOpenAiBaseUrl, getKieKeyForGeo, getGeminiKeyForGeo, getGeminiBaseUrl,
  getGeoEngine, setGeoEngine, getGeoApiKey, GeoEngineChoice, getAparserCreds,
  getGeoModel, setGeoModel, GeoAuditRec,
} from "@/lib/seo/geoClient";
import { rankModels, resolveModel, OPENAI_FALLBACK_MODELS, type ModelOpt } from "@/lib/seo/models";
import { getTaskCreds } from "@/lib/seo/keys";

// Fallback lists only — used until the live /api/seo/models call resolves (or if it fails).
// The provider's actual current lineup is fetched live below, same as the global model picker.
const OPENAI_MODELS_FALLBACK = OPENAI_FALLBACK_MODELS;
const KIE_MODELS_FALLBACK = ["gpt-5-5", "gpt-5-4", "gpt-5-2"];
const GEMINI_MODELS_FALLBACK = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"];
// A-Parser is absent on purpose: its model is reported by the run, never picked, so there is
// no list to fall back to and the picker is hidden for it entirely.
const modelsFallbackFor = (eng: GeoEngineChoice): string[] =>
  eng === "kie" ? KIE_MODELS_FALLBACK : eng === "gemini" ? GEMINI_MODELS_FALLBACK : OPENAI_MODELS_FALLBACK;

export default function GeoAuditPage() {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  // Optional: the page the user wants cited for this query. Stage 2 fetches it and answers
  // "what do I fix on MY page" instead of only describing the niche. ?url= prefills it, so any
  // other screen can open the form with the target already set.
  const [pageUrl, setPageUrl] = useState("");
  useEffect(() => { const u = readUrlParam("url"); if (u) setPageUrl(u); }, []);
  const [language, setLanguage] = useState("en");
  const [country, setCountry] = useState("us");
  // Language follows the country's market default until the user picks one explicitly.
  const [langTouched, setLangTouched] = useState(false);
  const [engine, setEngine] = useState<GeoEngineChoice>("openai");
  const [model, setModel] = useState(OPENAI_FALLBACK_MODELS[0]);
  const [modelOpts, setModelOpts] = useState<ModelOpt[]>(OPENAI_MODELS_FALLBACK.map(id => ({ id, label: id })));
  const [modelsLoading, setModelsLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [err, setErr] = useState("");
  const [report, setReport] = useState<GeoReport | null>(null);
  const [recent, setRecent] = useState<GeoAuditRec[]>([]);
  const [hasKey, setHasKey] = useState(true);
  const [hasOpenAi, setHasOpenAi] = useState(false);
  const [hasKie, setHasKie] = useState(false);
  const [hasGemini, setHasGemini] = useState(false);
  const [hasAparser, setHasAparser] = useState(false);

  useEffect(() => {
    const oa = !!getOpenAiKey(), kie = !!getKieKeyForGeo(), gem = !!getGeminiKeyForGeo();
    const ap = getAparserCreds();
    const apOk = !!ap.url.trim() && !!ap.password.trim();
    setHasOpenAi(oa); setHasKie(kie); setHasGemini(gem); setHasAparser(apOk);
    setHasKey(oa || kie || gem || apOk);
    const eng = getGeoEngine();
    setEngine(eng);
    // A stored choice is kept as-is even when it is absent from the fallback list — the fallback
    // is a stopgap for "no key to list models with", not a whitelist of allowed models.
    // loadModels() replaces it if the account no longer offers it.
    setModel(eng === "aparser" ? "" : getGeoModel() || modelsFallbackFor(eng)[0]);
    loadModels(eng);
    refreshRecent();
  }, []);

  // Pull the provider's actual current model list with the user's own key (mirrors the global
  // AI-provider settings picker) instead of trusting a hardcoded, easily stale id list.
  async function loadModels(eng: GeoEngineChoice) {
    // /api/seo/models knows AI providers only. A-Parser is not one — asking it would return an
    // empty list and leave an empty dropdown on screen for a choice that does not exist.
    if (eng === "aparser") { setModelOpts([]); return; }
    const apiKey = getGeoApiKey(eng);
    const fallback = modelsFallbackFor(eng);
    if (!apiKey) { setModelOpts(fallback.map(id => ({ id, label: id }))); return; }
    setModelsLoading(true);
    try {
      // baseUrl rides along for the openai/gemini engines: with a gateway endpoint override the
      // key is a gateway key, and the catalogue must come from the gateway too — the vendor's
      // own /models 401s on it and the picker silently falls back to ids the gateway doesn't serve.
      const override = eng === "openai" ? getOpenAiBaseUrl() || undefined : eng === "gemini" ? getGeminiBaseUrl() || undefined : undefined;
      const res = await fetch("/api/seo/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: eng, apiKey, baseUrl: override }),
      });
      const data = await res.json();
      const live: ModelOpt[] = Array.isArray(data.models) ? rankModels(data.models) : [];
      if (live.length) {
        setModelOpts(live);
        // A GEO audit is a deliberate one-off, so it takes the best model the account has
        // rather than the everyday tier — and resolves it from the live list instead of
        // looking for a model id hardcoded here months ago.
        setModel(cur => resolveModel(cur, live, "quality"));
      } else {
        setModelOpts(fallback.map(id => ({ id, label: id })));
      }
    } catch {
      setModelOpts(fallback.map(id => ({ id, label: id })));
    } finally {
      setModelsLoading(false);
    }
  }

  function chooseEngine(e: GeoEngineChoice) {
    setEngine(e);
    setGeoEngine(e);
    if (e === "aparser") { setModel(""); setModelOpts([]); return; }
    const fallback = modelsFallbackFor(e);
    setModel(fallback[0]);
    setModelOpts(fallback.map(id => ({ id, label: id })));
    loadModels(e);
  }

  async function refreshRecent() { setRecent(await listGeoAudits()); }

  async function run() {
    setErr("");
    const q = query.trim();
    if (!q) { setErr(t("geoErrEmpty")); return; }
    const apiKey = getGeoApiKey(engine);
    if (!apiKey) { setErr(t("geoNoKey")); return; }
    // Not on A-Parser: there is no model to remember, and storing "" here would wipe the choice
    // the user made for the engines that do have one.
    if (engine !== "aparser") setGeoModel(model);
    setRunning(true);
    setReport(null);
    setStage(t("geoStageSearching"));

    // Stage 1 (search) uses the model picked above and must stay on a provider that hosts a
    // `web_search` tool — OpenAI or kie.ai. Stage 2 only reads the resulting trace and writes
    // JSON, so it runs on the `utility` task like every other mechanical pass in the app: the
    // user's provider, the user's key, the user's model.
    //
    // Sending the whole cred set rather than just the model is what actually makes that true.
    // Before, only the model id travelled, so choosing a `utility` provider other than the
    // searching one asked OpenAI for a model id belonging to somebody else — the settings screen
    // said one thing and the request did another.
    const util = getTaskCreds("utility");
    const analysis = util.provider && util.apiKey
      ? { provider: util.provider, apiKey: util.apiKey, model: util.model || undefined, baseUrl: util.baseUrl }
      : undefined;
    // `analysisModel` is the legacy field and only reaches the searching provider, so it may only
    // carry a model id that provider owns. Sending it unconditionally is what broke this before:
    // a user whose SEO provider is Z.AI had `glm-5.2` posted to api.openai.com, which 404s — and
    // a failed analysis is not an error here, it silently assembles a report with the whole
    // qualitative half empty. Omitted when the utility provider is someone else, so the server
    // falls back to its own cheap default instead of an id from the wrong vendor.
    // "aparser" is deliberately not a provider id here: no AI provider can equal it, so
    // `legacyModel` stays undefined and no model id from another vendor can travel to it.
    const engineProvider = engine === "kie" ? "kie" : engine === "gemini" ? "gemini" : engine === "aparser" ? "aparser" : "openai";
    const legacyModel = util.provider === engineProvider ? (util.model || undefined) : undefined;
    const aparser = getAparserCreds();
    // On A-Parser the endpoint rides the same `baseUrl` field every other engine override uses,
    // and the "key" sent above is that instance's password.
    const engineBaseUrl = engine === "openai" ? getOpenAiBaseUrl() || undefined
      : engine === "gemini" ? getGeminiBaseUrl() || undefined
      : engine === "aparser" ? aparser.url.trim() || undefined
      : undefined;
    const { id, error } = await startGeoAudit({
      query: q, language, country, model: engine === "aparser" ? "" : model, apiKey, engine,
      baseUrl: engineBaseUrl,
      analysisModel: legacyModel,
      analysis,
      aparserConfig: engine === "aparser" ? aparser.config.trim() || undefined : undefined,
      pageUrl: pageUrl.trim() || undefined,
    });
    if (error || !id) { setRunning(false); setErr(error || "audit_failed"); return; }

    // Poll until done.
    let tries = 0;
    const poll = async () => {
      const rec = await getGeoAudit(id);
      tries++;
      if (tries > 4) setStage(t("geoStageAnalyzing"));
      if (!rec || rec.status === "processing") {
        // 400 tries × 3s = 20 min — the search call itself may legitimately run 15 minutes
        // (SEARCH_TIMEOUT_MS) plus the analysis stage, so the poller must outlast both.
        if (tries > 400) { setRunning(false); setErr(t("geoErrTimeout")); return; }
        setTimeout(poll, 3000);
        return;
      }
      setRunning(false);
      refreshRecent();
      if (rec.status === "error") { setErr(rec.error || "audit_failed"); return; }
      const rep = parseReport(rec);
      if (rep) setReport(rep); else setErr("parse_failed");
    };
    setTimeout(poll, 3000);
  }

  async function openAudit(id: string) {
    setErr(""); setReport(null); setRunning(true); setStage(t("geoStageLoading"));
    const rec = await getGeoAudit(id);
    setRunning(false);
    if (!rec) { setErr("not_found"); return; }
    if (rec.status === "error") { setErr(rec.error || "audit_failed"); return; }
    const rep = parseReport(rec);
    if (rep) { setReport(rep); setQuery(rec.query); } else setErr("parse_failed");
  }

  async function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteGeoAudit(id);
    refreshRecent();
  }

  function reset() { setReport(null); setErr(""); setQuery(""); }

  // The "feed the conclusions somewhere" path: hand the report to a brief, a client or a doc
  // instead of making the user select-and-copy from the screen.
  function downloadMd() {
    if (!report) return;
    const blob = new Blob([buildGeoMarkdown(report)], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `geo-audit-${new Date(report.createdAt).toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const card: React.CSSProperties = { background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "14px", padding: "22px" };

  // ── Results view ──
  if (report) {
    return (
      <div>
        <button onClick={reset} style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "9px 15px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 600, cursor: "pointer", marginBottom: "22px" }}>
          <Plus size={15} /> {t("geoNewAudit")}
        </button>
        <button onClick={downloadMd} style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "9px 15px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 600, cursor: "pointer", marginBottom: "22px", marginLeft: "10px" }}>
          <FileDown size={15} /> {t("geoDownloadMd")}
        </button>
        <GeoAuditReport report={report} />
      </div>
    );
  }

  // ── Launch / loading view ──
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {!hasKey && (
        <div style={{ ...card, padding: "14px 18px", borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <AlertTriangle size={16} color="var(--color-accent-orange)" /> {t("geoNoKey")}
        </div>
      )}

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "18px" }}>
          <Globe size={20} color="var(--color-accent-purple)" />
          <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("geoLaunchTitle")}</h2>
        </div>

        <label className="tool-field-label">{t("geoFieldKeyword")}</label>
        <input className="tool-input" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !running) run(); }}
          placeholder={t("geoFieldKeywordPh")} disabled={running} />

        <label className="tool-field-label" style={{ marginTop: "14px", display: "block" }}>{t("geoYourPageLabel")}</label>
        <input className="tool-input" value={pageUrl} onChange={e => setPageUrl(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !running) run(); }}
          placeholder={t("geoYourPagePh")} disabled={running} />

        {([hasOpenAi, hasKie, hasGemini, hasAparser].filter(Boolean).length > 1) && (
          <div style={{ display: "flex", gap: "8px", marginTop: "14px", flexWrap: "wrap" }}>
            {(["openai", "gemini", "kie", "aparser"] as GeoEngineChoice[])
              .filter(e => (e === "openai" && hasOpenAi) || (e === "gemini" && hasGemini) || (e === "kie" && hasKie) || (e === "aparser" && hasAparser))
              .map(e => (
              <button key={e} onClick={() => !running && chooseEngine(e)} disabled={running}
                style={{
                  padding: "7px 13px", borderRadius: "8px", fontSize: "12px", fontWeight: 700, cursor: running ? "default" : "pointer",
                  border: `1px solid ${engine === e ? "var(--color-accent-purple)" : "var(--color-border)"}`,
                  background: engine === e ? "rgba(191,90,242,0.12)" : "var(--color-card)",
                  color: engine === e ? "var(--color-accent-purple)" : "var(--color-text-secondary)",
                }}>
                {e === "openai" ? "OpenAI" : e === "gemini" ? "Gemini" : e === "kie" ? "Kie.ai" : "A-Parser"}
              </button>
            ))}
          </div>
        )}

        {/* Said once, on screen, rather than left for the reader to infer from an empty panel:
            this engine costs nothing per run, does not let you pin a model, and cannot report
            the search steps — so the batch and deep-read panels stay empty by construction. */}
        {engine === "aparser" && (
          <p style={{ marginTop: "10px", marginBottom: 0, fontSize: "12px", color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
            {t("geoAparserNote")}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginTop: "14px" }}>
          <div>
            <label className="tool-field-label">{t("geoFieldLanguage")}</label>
            <select className="tool-input" value={language} onChange={e => { setLangTouched(true); setLanguage(e.target.value); }} disabled={running}>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
          <div>
            <label className="tool-field-label">{t("geoFieldCountry")}</label>
            <select className="tool-input" value={country} onChange={e => { const gl = e.target.value; setCountry(gl); if (!langTouched) setLanguage(defaultLanguageFor(gl)); }} disabled={running}>
              {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="tool-field-label">{t("geoModel")}{modelsLoading && engine !== "aparser" ? " …" : ""}</label>
            {engine === "aparser" ? (
              // A disabled field rather than a hidden one: the report will name a model, and the
              // user should learn here — before paying for the analysis pass — that the free
              // session picks it, not them.
              <input className="tool-input" value={t("geoAparserModelAuto")} readOnly disabled />
            ) : (
              <select className="tool-input" value={model} onChange={e => setModel(e.target.value)} disabled={running || modelsLoading}>
                {modelOpts.map(mm => <option key={mm.id} value={mm.id}>{mm.label}</option>)}
              </select>
            )}
          </div>
        </div>

        {/* Server error codes that mean "we gave up waiting" (timeout_after_15m, stale_timeout)
            get the same human sentence as the client-side poll cap — the raw code alone reads as
            a broken key when the real story is a long agentic search. */}
        {err && <div style={{ marginTop: "14px", fontSize: "13px", color: "var(--color-accent-red)", display: "flex", gap: "8px", alignItems: "center" }}><AlertTriangle size={15} /> {/timeout/i.test(err) ? t("geoErrTimeout") : err}</div>}

        <button onClick={run} disabled={running || !query.trim()}
          style={{ marginTop: "18px", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", padding: "12px", borderRadius: "10px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "14px", fontWeight: 700, cursor: running || !query.trim() ? "default" : "pointer", opacity: running || !query.trim() ? 0.6 : 1 }}>
          {running ? <><Loader2 size={16} className="spin" /> {stage || t("geoRunning")}</> : <>{t("geoRun")} <ArrowRight size={16} /></>}
        </button>
        {running && <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)", textAlign: "center", marginTop: "10px" }}>{t("geoRunningHint")}</p>}
      </div>

      {/* Recent audits */}
      {recent.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", margin: "8px 0 12px" }}>
            <Clock size={16} color="var(--color-text-secondary)" />
            <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("geoRecentTitle")}</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {recent.map(r => (
              <div key={r.id} onClick={() => r.status === "completed" && openAudit(r.id)}
                style={{ ...card, padding: "13px 16px", display: "flex", alignItems: "center", gap: "12px", cursor: r.status === "completed" ? "pointer" : "default" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.query}</div>
                  <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginTop: "3px" }}>
                    {r.language} · {r.country.toUpperCase()} · {r.model} · {new Date(r.createdAt).toLocaleString()}
                  </div>
                </div>
                <StatusBadge status={r.status} t={t} />
                <button onClick={e => remove(r.id, e)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-tertiary)", padding: "4px", display: "flex" }}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, t }: { status: string; t: (k: any) => string }) {
  const map: Record<string, { c: string; k: string }> = {
    completed: { c: "var(--color-accent-green)", k: "geoStatusDone" },
    processing: { c: "var(--color-accent-orange)", k: "geoStatusProcessing" },
    error: { c: "var(--color-accent-red)", k: "geoStatusError" },
  };
  const s = map[status] ?? map.error;
  return <span style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: s.c, padding: "4px 9px", borderRadius: "7px", border: `1px solid ${s.c}`, whiteSpace: "nowrap" }}>{status === "processing" ? <Loader2 size={11} className="spin" style={{ marginRight: 4, verticalAlign: "middle" }} /> : null}{t(s.k)}</span>;
}
