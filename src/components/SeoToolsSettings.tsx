"use client";

// Self-contained settings for the SEO Tools module — keys (SERP/scrape), model
// selection, and fact-check/generation behavior. Lives inside the SEO Tools tab so
// the tool is self-contained; no dependency on the main dashboard Settings page.
// All values are localStorage-only (same keys/logic as before — just relocated).

import { useEffect, useState } from "react";
import { Globe, RefreshCw, CheckCircle, Eye, X, Sparkles } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getConfiguredProviders, AI_PROVIDER_NAMES } from "@/lib/seo/keys";
import { rankModels, type ModelOpt } from "@/lib/seo/models";
import { AI_TASKS, pathsForTask } from "@/lib/seo/aiTasks";

interface KeyCardProvider {
  id: string; storageKey: string; name: string; roleKey: string; placeholder: string;
  hintKey: string; instrKey: string; docsUrl: string; color: string; logo: string;
}

/**
 * Where the "Get key" button on the Ahrefs/Semrush cards points.
 *
 * This is a referral link. It is disclosed in the README rather than hidden, it is the only one
 * in the project, and it changes nothing about how the code works: the official API hosts stay
 * the defaults, the base-URL field accepts any gateway, and the whole metrics module remains
 * usable with no key at all through CSV import.
 */
export const METRICS_GATEWAY_URL =
  "https://my.groupbuyseo.org/register?affiliate_key=8ino4XJTwJ7EJooF67JUOt2tmbcFk1";

export const SEO_PROVIDERS: KeyCardProvider[] = [
  { id: "serper", storageKey: "seoKey_serper", name: "Serper.dev", roleKey: "seoRoleSerp", placeholder: "Serper API key", hintKey: "seoSetHintSerper", instrKey: "seoSetInstrSerper", docsUrl: "https://serper.dev", color: "#10A37F", logo: "S" },
  { id: "dataforseo", storageKey: "seoKey_dataforseo", name: "DataForSEO", roleKey: "seoRoleDfs", placeholder: "login:password или Base64-токен", hintKey: "seoSetHintDfs", instrKey: "seoSetInstrDfs", docsUrl: "https://app.dataforseo.com/api-access", color: "#2997ff", logo: "D" },
  { id: "scrapingrobot", storageKey: "seoKey_scrapingrobot", name: "ScrapingRobot", roleKey: "seoRoleSr", placeholder: "ScrapingRobot API token", hintKey: "seoSetHintSr", instrKey: "seoSetInstrSr", docsUrl: "https://scrapingrobot.com", color: "#8B5CF6", logo: "R" },
  { id: "goanyapi", storageKey: "seoKey_goanyapi", name: "GoAnyAPI", roleKey: "seoRoleGoAny", placeholder: "GoAnyAPI key", hintKey: "seoSetHintGoAny", instrKey: "seoSetInstrGoAny", docsUrl: "https://goanyapi.com/docs", color: "#F59E0B", logo: "G" },
  { id: "firecrawl", storageKey: "seoKey_firecrawl", name: "Firecrawl", roleKey: "seoRoleFc", placeholder: "fc-...", hintKey: "seoSetHintFc", instrKey: "seoSetInstrFc", docsUrl: "https://www.firecrawl.dev/app/api-keys", color: "#ff9f0a", logo: "F" },
];

/**
 * Ahrefs and Semrush are deliberately NOT in SEO_PROVIDERS above.
 *
 * They are configured on their own settings screen together with the access mode, host and
 * spending cap, because those four things are one decision. Listing the key card here as well
 * would put half of that decision in a second place — which is exactly the confusion this split
 * was made to remove. The card definitions live here only so both screens share one component.
 */
export const METRICS_PROVIDER_CARDS: KeyCardProvider[] = [
  { id: "ahrefs", storageKey: "seoKey_ahrefs", name: "Ahrefs", roleKey: "seoRoleAhrefs", placeholder: "Ahrefs API v3 key", hintKey: "seoSetHintAhrefs", instrKey: "seoSetInstrAhrefs", docsUrl: "https://docs.ahrefs.com/", color: "#f76d01", logo: "A" },
  { id: "semrush", storageKey: "seoKey_semrush", name: "Semrush", roleKey: "seoRoleSemrush", placeholder: "Semrush API key", hintKey: "seoSetHintSemrush", instrKey: "seoSetInstrSemrush", docsUrl: "https://developer.semrush.com/api/", color: "#ff642d", logo: "S" },
];

// AEO citation-check engines that aren't already covered by the main AI provider keys
// (ChatGPT/Claude checks reuse aiKey_openai / aiKey_anthropic from Settings → API providers).
export const AEO_PROVIDERS: KeyCardProvider[] = [
  { id: "perplexity", storageKey: "seoKey_perplexity", name: "Perplexity", roleKey: "seoRolePerplexity", placeholder: "pplx-...", hintKey: "seoSetHintPerplexity", instrKey: "seoSetInstrPerplexity", docsUrl: "https://docs.perplexity.ai", color: "#20808D", logo: "P" },
  { id: "xai", storageKey: "seoKey_xai", name: "xAI (Grok)", roleKey: "seoRoleXai", placeholder: "xai-...", hintKey: "seoSetHintXai", instrKey: "seoSetInstrXai", docsUrl: "https://console.x.ai", color: "#000000", logo: "G" },
];

export function SeoKeyCard({ provider, hideDocsLink = false }: { provider: KeyCardProvider; hideDocsLink?: boolean }) {
  const { t } = useLanguage();
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const isConfigured = key.trim().length > 4;

  useEffect(() => { setKey(localStorage.getItem(provider.storageKey) || ""); }, [provider.storageKey]);

  const save = () => {
    localStorage.setItem(provider.storageKey, key.trim());
    if (key.trim() && (provider.id === "serper" || provider.id === "dataforseo" || provider.id === "scrapingrobot" || provider.id === "goanyapi")) {
      if (!localStorage.getItem("seoSerpProvider")) localStorage.setItem("seoSerpProvider", provider.id);
    }
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };
  const clear = () => { setKey(""); localStorage.removeItem(provider.storageKey); };

  return (
    <div style={{ padding: "16px", borderRadius: "10px", border: `1px solid ${isConfigured ? `${provider.color}40` : "var(--color-border)"}`, background: isConfigured ? `${provider.color}08` : "rgba(255,255,255,0.02)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
        <div style={{ width: "30px", height: "30px", borderRadius: "8px", background: `${provider.color}20`, border: `1px solid ${provider.color}40`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 700, color: provider.color, flexShrink: 0 }}>{provider.logo}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{provider.name}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t(provider.roleKey as any)}</div>
        </div>
        {isConfigured
          ? <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#10B981", fontWeight: 600 }}><CheckCircle size={12} color="#10B981" /> Connected</span>
          : <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>Not set</span>}
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <input type={visible ? "text" : "password"} placeholder={provider.placeholder} value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => e.key === "Enter" && save()}
            style={{ width: "100%", padding: "8px 36px 8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", boxSizing: "border-box", fontFamily: "monospace" }} />
          <button onClick={() => setVisible(v => !v)} style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 0, display: "flex" }}>
            <Eye size={14} style={{ opacity: visible ? 1 : 0.5 }} />
          </button>
        </div>
        {isConfigured && <button onClick={clear} style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.08)", color: "#f87171", fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center" }}><X size={13} /></button>}
        <button onClick={save} disabled={!key.trim()} style={{ padding: "8px 14px", borderRadius: "8px", border: "none", background: saved ? "rgba(16,185,129,0.2)" : key.trim() ? `${provider.color}25` : "rgba(255,255,255,0.06)", color: saved ? "#10B981" : key.trim() ? provider.color : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: key.trim() ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: "4px" }}>
          {saved ? <><CheckCircle size={12} /> Saved</> : "Save"}
        </button>
      </div>

      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5, marginBottom: "6px" }}>{t(provider.hintKey as any)}</div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
        <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.5, flex: 1 }}>📍 {t(provider.instrKey as any)}</span>
        {/* The Metrics screen renders its own, mode-aware link, so it suppresses this one
            rather than showing two destinations for the same thing. */}
        {!hideDocsLink && (
          <a href={provider.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: "11px", color: "var(--color-accent-blue)", display: "flex", alignItems: "center", gap: "3px", textDecoration: "none", flexShrink: 0, whiteSpace: "nowrap" }}>Get key ↗</a>
        )}
      </div>
    </div>
  );
}

function ModelSelector() {
  const { t } = useLanguage();
  const [groups, setGroups] = useState<{ provider: string; name: string; models: { id: string; label: string }[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchErr, setFetchErr] = useState(false);
  const [sel, setSel] = useState("");
  const [custom, setCustom] = useState("");
  const [saved, setSaved] = useState(false);
  // Read on mount only — reading localStorage during the initial render would make the
  // client's first pass diverge from the server-rendered (window-less) HTML and trigger
  // a hydration mismatch (React #418).
  const [hasProviders, setHasProviders] = useState(false);

  async function loadModels() {
    const providers = getConfiguredProviders();
    setHasProviders(providers.length > 0);
    if (!providers.length) { setGroups([]); return; }
    setLoading(true); setFetchErr(false);
    const results = await Promise.all(providers.map(async (p) => {
      try {
        const res = await fetch("/api/seo/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: p.id, apiKey: p.key }) });
        const data = await res.json();
        if (!res.ok || !data.models?.length) { if (!res.ok) setFetchErr(true); return null; }
        return { provider: p.id, name: AI_PROVIDER_NAMES[p.id] || p.id, models: data.models as { id: string; label: string }[] };
      } catch { setFetchErr(true); return null; }
    }));
    setGroups(results.filter(Boolean) as any);
    setLoading(false);
  }

  useEffect(() => {
    const provider = localStorage.getItem("seoProvider") || "";
    const model = localStorage.getItem("seoModel") || "";
    if (model) setSel(provider ? `${provider}::${model}` : "__custom__");
    if (model && !provider) setCustom(model);
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flash() { setSaved(true); setTimeout(() => setSaved(false), 1500); }
  function choose(v: string) {
    setSel(v);
    if (v === "") { localStorage.removeItem("seoProvider"); localStorage.removeItem("seoModel"); flash(); return; }
    if (v === "__custom__") { return; }
    const [provider, ...rest] = v.split("::"); const id = rest.join("::");
    localStorage.setItem("seoProvider", provider); localStorage.setItem("seoModel", id); flash();
  }
  function saveCustom(v: string) { localStorage.removeItem("seoProvider"); localStorage.setItem("seoModel", v.trim()); flash(); }

  const inputBase: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ marginBottom: "18px", paddingBottom: "16px", borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>
          {t("seoModelLabel")}{saved && <span style={{ marginLeft: "8px", fontSize: "11px", color: "var(--color-accent-green)" }}>✓ {t("seoModelSaved")}</span>}
        </div>
        <button onClick={loadModels} disabled={loading} style={{ display: "flex", alignItems: "center", gap: "5px", padding: "5px 10px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "11px", cursor: "pointer" }}>
          <RefreshCw size={12} className={loading ? "spin" : undefined} /> {t("seoModelRefresh")}
        </button>
      </div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "2px 0 8px" }}>{t("seoModelSub")}</div>

      <select value={sel} onChange={e => choose(e.target.value)} style={inputBase}>
        <option value="">{t("seoModelDefault")}</option>
        {groups.map(g => (
          <optgroup key={g.provider} label={g.name}>
            {g.models.map(m => <option key={g.provider + m.id} value={`${g.provider}::${m.id}`}>{m.label}</option>)}
          </optgroup>
        ))}
        <option value="__custom__">{t("seoModelCustom")}</option>
      </select>

      {sel === "__custom__" && (
        <input value={custom} onChange={e => setCustom(e.target.value)} onBlur={() => saveCustom(custom)} onKeyDown={e => e.key === "Enter" && saveCustom(custom)}
          placeholder={t("seoModelCustomPh")} style={{ ...inputBase, marginTop: "8px", fontFamily: "monospace" }} />
      )}

      <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "6px" }}>
        {loading ? t("seoModelLoading") : !hasProviders ? t("seoModelNoProviders") : fetchErr ? t("seoModelErrFetch") : t("seoModelLive")}
      </div>
    </div>
  );
}

function ToggleRowSetting({ label, desc, on, onToggle }: { label: string; desc: string; on: boolean; onToggle: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", padding: "10px 0" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{label}</div>
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{desc}</div>
      </div>
      <button onClick={onToggle} style={{ width: "42px", height: "24px", borderRadius: "999px", flexShrink: 0, border: "none", background: on ? "var(--color-accent-green)" : "var(--color-border)", position: "relative", cursor: "pointer", transition: "background 0.15s" }}>
        <span style={{ position: "absolute", top: "2px", left: on ? "20px" : "2px", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
      </button>
    </div>
  );
}

function FactCheckSettings() {
  const { t } = useLanguage();
  const [autoFc, setAutoFc] = useState(true);
  const [autoImg, setAutoImg] = useState(true);
  const [hardRedact, setHardRedact] = useState(false);
  const [bearingOnly, setBearingOnly] = useState(true);
  const [reuseCorpus, setReuseCorpus] = useState(false);
  const [srcCount, setSrcCount] = useState(6);
  useEffect(() => {
    setAutoFc((localStorage.getItem("seoAutoFactcheck") ?? "1") !== "0");
    setAutoImg((localStorage.getItem("seoAutoImages") ?? "1") !== "0");
    setHardRedact((localStorage.getItem("seoHardRedact") ?? "0") === "1");
    setBearingOnly((localStorage.getItem("seoFactBearingOnly") ?? "1") !== "0");
    setReuseCorpus((localStorage.getItem("seoFactReuseCorpus") ?? "0") === "1");
    setSrcCount(parseInt(localStorage.getItem("seoFactSources") ?? "6", 10) || 6);
  }, []);
  const toggleFc = () => { const v = !autoFc; setAutoFc(v); localStorage.setItem("seoAutoFactcheck", v ? "1" : "0"); };
  const toggleImg = () => { const v = !autoImg; setAutoImg(v); localStorage.setItem("seoAutoImages", v ? "1" : "0"); };
  const toggleRedact = () => { const v = !hardRedact; setHardRedact(v); localStorage.setItem("seoHardRedact", v ? "1" : "0"); };
  const toggleBearing = () => { const v = !bearingOnly; setBearingOnly(v); localStorage.setItem("seoFactBearingOnly", v ? "1" : "0"); };
  const toggleReuse = () => { const v = !reuseCorpus; setReuseCorpus(v); localStorage.setItem("seoFactReuseCorpus", v ? "1" : "0"); };
  const setSrc = (n: number) => { const v = Math.max(0, Math.min(10, n)); setSrcCount(v); localStorage.setItem("seoFactSources", String(v)); };

  return (
    <div style={{ marginBottom: "18px", paddingBottom: "16px", borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>🛡 {t("seoFcSettingsTitle")}</div>
      <ToggleRowSetting label={t("seoAutoFactcheckLabel")} desc={t("seoAutoFactcheckDesc")} on={autoFc} onToggle={toggleFc} />
      <ToggleRowSetting label={t("seoAutoImagesLabel")} desc={t("seoAutoImagesDesc")} on={autoImg} onToggle={toggleImg} />
      <ToggleRowSetting label={t("seoHardRedactLabel")} desc={t("seoHardRedactDesc")} on={hardRedact} onToggle={toggleRedact} />
      <ToggleRowSetting label={t("seoFactBearingLabel")} desc={t("seoFactBearingDesc")} on={bearingOnly} onToggle={toggleBearing} />
      <ToggleRowSetting label={t("seoFactReuseLabel")} desc={t("seoFactReuseDesc")} on={reuseCorpus} onToggle={toggleReuse} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", padding: "10px 0" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("seoFactSourcesLabel")}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("seoFactSourcesDesc")}</div>
        </div>
        <input type="number" min={0} max={10} value={srcCount} onChange={e => setSrc(parseInt(e.target.value, 10) || 0)}
          style={{ width: "64px", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", textAlign: "center", flexShrink: 0 }} />
      </div>
    </div>
  );
}

// Custom OpenAI-compatible provider (e.g. kie.ai): base URL + key + default model.
function CustomProviderCard() {
  const { t } = useLanguage();
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setBaseUrl(localStorage.getItem("aiBaseUrl_custom") || "");
    setKey(localStorage.getItem("aiKey_custom") || "");
    setModel(localStorage.getItem("aiModel_custom") || "");
  }, []);
  const save = () => {
    localStorage.setItem("aiBaseUrl_custom", baseUrl.trim());
    localStorage.setItem("aiKey_custom", key.trim());
    localStorage.setItem("aiModel_custom", model.trim());
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };
  const inp: React.CSSProperties = { width: "100%", padding: "9px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none", boxSizing: "border-box", fontFamily: "monospace" };
  return (
    <div style={{ marginBottom: "18px", paddingBottom: "16px", borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>🔌 {t("seoCustomProviderTitle")}</div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 10px" }}>{t("seoCustomProviderSub")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <input style={inp} placeholder="https://api.kie.ai/v1" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
        <input style={inp} type="password" placeholder={t("seoCustomKeyPh")} value={key} onChange={e => setKey(e.target.value)} />
        <input style={inp} placeholder={t("seoCustomModelPh")} value={model} onChange={e => setModel(e.target.value)} />
        <button onClick={save} style={{ alignSelf: "flex-start", padding: "8px 16px", borderRadius: "8px", border: "none", background: saved ? "rgba(16,185,129,0.2)" : "var(--color-accent-blue)", color: saved ? "#10B981" : "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>{saved ? `✓ ${t("seoModelSaved")}` : t("seoSave")}</button>
      </div>
    </div>
  );
}

// Per-task default provider/model — set once, applied on every generation of that task type.
// Rows come from the AI_TASKS registry rather than being listed here, because the two used to
// drift: this table offered four tasks while getTaskCreds read five, so `seoTaskModel_landing`
// could be read but never written and the Landing tool silently ignored what the user thought
// they had configured. See lib/seo/aiTasks.ts.
function PerTaskProviders() {
  const { t } = useLanguage();
  const [vals, setVals] = useState<Record<string, { provider: string; model: string }>>({});
  const [opts, setOpts] = useState<string[]>([]);
  // provider id → its live model list, so the model column can be a picker instead of a
  // free-text box. Typing a model id by hand is how you end up pinned to a model the provider
  // retired: the call keeps succeeding against a stale alias, or fails with a 404 that surfaces
  // as "the tool is broken".
  const [modelsBy, setModelsBy] = useState<Record<string, ModelOpt[]>>({});
  const [globalProvider, setGlobalProvider] = useState("");
  const [globalModel, setGlobalModel] = useState("");

  useEffect(() => {
    const configuredProviders = getConfiguredProviders();
    const configured = configuredProviders.map(p => p.id);
    const custom = (localStorage.getItem("aiKey_custom") || "") && (localStorage.getItem("aiBaseUrl_custom") || "");
    setOpts([...configured, ...(custom ? ["custom"] : [])].filter((v, i, a) => a.indexOf(v) === i));
    setGlobalProvider(localStorage.getItem("seoProvider") || localStorage.getItem("aiProvider") || "");
    setGlobalModel(localStorage.getItem("seoModel") || "");
    const v: Record<string, { provider: string; model: string }> = {};
    for (const { id } of AI_TASKS) {
      v[id] = { provider: localStorage.getItem(`seoTaskProvider_${id}`) || "", model: localStorage.getItem(`seoTaskModel_${id}`) || "" };
    }
    setVals(v);

    Promise.all(configuredProviders.map(async p => {
      try {
        const res = await fetch("/api/seo/models", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: p.id, apiKey: p.key }),
        });
        const d = await res.json();
        const list: ModelOpt[] = Array.isArray(d?.models) ? d.models : [];
        return [p.id, p.id === "openai" ? rankModels(list) : list] as const;
      } catch { return [p.id, [] as ModelOpt[]] as const; }
    })).then(pairs => setModelsBy(Object.fromEntries(pairs.filter(([, l]) => l.length))));
  }, []);
  const setTask = (id: string, patch: Partial<{ provider: string; model: string }>) => {
    setVals(prev => {
      const next = { ...prev, [id]: { ...prev[id], ...patch } };
      const cur = next[id];
      if (cur.provider) localStorage.setItem(`seoTaskProvider_${id}`, cur.provider); else localStorage.removeItem(`seoTaskProvider_${id}`);
      if (cur.model.trim()) localStorage.setItem(`seoTaskModel_${id}`, cur.model.trim()); else localStorage.removeItem(`seoTaskModel_${id}`);
      return next;
    });
  };
  const sel: React.CSSProperties = { padding: "7px 9px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", width: "100%", boxSizing: "border-box" };

  return (
    <div style={{ marginBottom: "18px", paddingBottom: "16px", borderBottom: "1px solid var(--color-border)" }}>
      <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>🎛 {t("seoPerTaskTitle")}</div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>{t("seoPerTaskSub")}</div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {AI_TASKS.map(task => {
          const cur = vals[task.id] ?? { provider: "", model: "" };
          const effectiveProvider = cur.provider || globalProvider;
          // Exactly the chain resolveTaskCreds() walks, restated so the row can show its own
          // outcome — a per-task provider with no per-task model still inherits the global
          // model, and that surprises people until it is written down.
          const effectiveModel = cur.model || globalModel;
          return (
            <div key={task.id} style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr 1fr", gap: "8px", alignItems: "start" }}>
              <div style={{ paddingRight: "6px" }}>
                <div style={{ fontSize: "12px", color: "var(--color-text-primary)", fontWeight: 600 }}>{t(task.labelKey as never)}</div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.45, marginTop: "2px" }}>
                  {t(task.descKey as never)}
                </div>
                <div style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", marginTop: "3px" }}>
                  {t("seoTaskUsedBy")}: {pathsForTask(task.id).map(p => p.replace("/seo-tools/", "")).join(", ") || "—"}
                </div>
              </div>

              <select style={sel} value={cur.provider} onChange={e => setTask(task.id, { provider: e.target.value, model: "" })}>
                <option value="">
                  {globalProvider
                    ? `${t("seoTaskDefaultProvider")} — ${AI_PROVIDER_NAMES[globalProvider] || globalProvider}`
                    : t("seoTaskDefaultProvider")}
                </option>
                {opts.map(o => <option key={o} value={o}>{AI_PROVIDER_NAMES[o] || o}</option>)}
              </select>

              <div>
                <TaskModelField
                  value={cur.model}
                  models={modelsBy[effectiveProvider] ?? []}
                  onChange={m => setTask(task.id, { model: m })}
                />
                <div style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", marginTop: "4px", lineHeight: 1.4, wordBreak: "break-word" }}>
                  {effectiveProvider
                    ? `→ ${AI_PROVIDER_NAMES[effectiveProvider] || effectiveProvider} · ${effectiveModel || t("seoModelBadgeProviderDefault")}`
                    : t("seoTaskNoProvider")}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Model cell for one task row: a picker when we could list the provider's models, a free-text
// box when we could not (no key for that provider yet, or an OpenAI-compatible endpoint with no
// /models listing). A value the list does not contain is kept and shown rather than dropped —
// silently discarding a saved setting because the list came back short is worse than showing an
// id we cannot vouch for.
function TaskModelField({ value, models, onChange }: { value: string; models: ModelOpt[]; onChange: (m: string) => void }) {
  const { t } = useLanguage();
  const [free, setFree] = useState(false);
  const sel: React.CSSProperties = { padding: "7px 9px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", width: "100%", boxSizing: "border-box" };

  if (!models.length || free) {
    return (
      <input
        style={{ ...sel, fontFamily: "monospace" }}
        placeholder={t("seoTaskModelPh")}
        value={value}
        autoFocus={free}
        onBlur={() => setFree(false)}
        onChange={e => onChange(e.target.value)}
      />
    );
  }

  const known = models.some(m => m.id === value);
  return (
    <select style={sel} value={value} onChange={e => (e.target.value === "__custom__" ? setFree(true) : onChange(e.target.value))}>
      <option value="">{t("seoTaskModelDefault")}</option>
      {value && !known && <option value={value}>{value}</option>}
      {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      <option value="__custom__">{t("seoTaskModelCustom")}</option>
    </select>
  );
}

const SERP_PROVIDER_LIST: [string, string][] = [["serper", "Serper.dev"], ["dataforseo", "DataForSEO"], ["scrapingrobot", "ScrapingRobot"], ["goanyapi", "GoAnyAPI"]];

/**
 * Providers Rank Tracker will not accept, mirroring `RANK_UNSUPPORTED` in lib/rank.ts.
 *
 * Duplicated on purpose rather than imported: this file is a client component and rank.ts pulls
 * in Prisma. The server is the one that enforces it — this copy exists only so the dropdown can
 * say so before the user picks, instead of after a week of empty charts.
 */
const RANK_UNSUPPORTED_PROVIDERS = new Set(["goanyapi"]);

function providerPillStyle(isActive: boolean): React.CSSProperties {
  return {
    padding: "7px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
    border: `1px solid ${isActive ? "var(--color-accent-blue)" : "var(--color-border)"}`,
    background: isActive ? "rgba(41,151,255,0.1)" : "transparent",
    color: isActive ? "var(--color-accent-blue)" : "var(--color-text-secondary)",
  };
}

// Exported so the unified "API Keys" settings section (Settings → API Keys) can render
// these same key cards — keeping exactly one place in the UI where any provider key is
// actually typed in, while this SEO Tools tab keeps only the non-key configuration
// (model choice, active-provider pickers, fact-check behavior).
export function SeoProviderKeysSection() {
  const { t } = useLanguage();
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <Globe size={17} color="#10A37F" />
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("seoSetTitle")}</h3>
      </div>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("seoSetSub")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {SEO_PROVIDERS.map(p => <SeoKeyCard key={p.id} provider={p} />)}
      </div>
      <div style={{ marginTop: "14px", padding: "11px 14px", borderRadius: "8px", background: "rgba(16,163,127,0.06)", border: "1px solid rgba(16,163,127,0.18)", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        💡 {t("seoSetTip")}
      </div>
    </div>
  );
}

export function AeoProviderKeysSection() {
  const { t } = useLanguage();
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <Sparkles size={17} color="#8B5CF6" />
        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("seoAeoSectionTitle")}</h3>
      </div>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{t("seoAeoSectionDesc")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {AEO_PROVIDERS.map(p => <SeoKeyCard key={p.id} provider={p} />)}
      </div>
    </div>
  );
}

export default function SeoToolsSettings() {
  const { t } = useLanguage();
  const [active, setActive] = useState("serper");
  // Rank Tracker can use its own SERP provider, independent from the one used for content
  // generation/analysis (e.g. a free-tier provider for frequent daily position checks, a
  // pricier one for occasional content research). Empty string = inherit the active provider.
  const [rankActive, setRankActive] = useState("");
  useEffect(() => {
    setActive(localStorage.getItem("seoSerpProvider") || "serper");
    setRankActive(localStorage.getItem("seoSerpProvider_rank") || "");
  }, []);
  const setProvider = (id: string) => { setActive(id); localStorage.setItem("seoSerpProvider", id); };
  const setRankProvider = (id: string) => {
    setRankActive(id);
    if (id) localStorage.setItem("seoSerpProvider_rank", id);
    else localStorage.removeItem("seoSerpProvider_rank");
  };
  const activeName = SERP_PROVIDER_LIST.find(([id]) => id === active)?.[1] ?? active;

  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <Globe size={17} color="#10A37F" />
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("seoSetTitle")}</h2>
      </div>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 16px" }}>{t("seoSetSub")}</p>

      <ModelSelector />
      <CustomProviderCard />
      <PerTaskProviders />
      <FactCheckSettings />

      <div style={{ marginBottom: "14px" }}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "7px" }}>{t("seoSetActiveProvider")}</div>
        <div style={{ display: "flex", gap: "8px" }}>
          {SERP_PROVIDER_LIST.map(([id, name]) => (
            <button key={id} onClick={() => setProvider(id)} style={providerPillStyle(active === id)}>{name}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "14px", paddingBottom: "16px", borderBottom: "1px solid var(--color-border)" }}>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px" }}>{t("seoSetRankProvider")}</div>
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 8px" }}>{t("seoSetRankProviderDesc")}</p>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button onClick={() => setRankProvider("")} style={providerPillStyle(rankActive === "")}>
            {t("seoSetRankProviderInherit")} ({activeName})
          </button>
          {SERP_PROVIDER_LIST.filter(([id]) => !RANK_UNSUPPORTED_PROVIDERS.has(id)).map(([id, name]) => (
            <button key={id} onClick={() => setRankProvider(id)} style={providerPillStyle(rankActive === id)}>{name}</button>
          ))}
        </div>
        {RANK_UNSUPPORTED_PROVIDERS.has(active) && (
          <p style={{ fontSize: "12px", color: "var(--color-warning)", margin: "8px 0 0" }}>
            {activeName} serves cached SERPs with no depth control, so Rank Tracker cannot use it —
            it will fall back to another configured SERP key. Positions elsewhere in the app are unaffected.
          </p>
        )}
      </div>

    </div>
  );
}
