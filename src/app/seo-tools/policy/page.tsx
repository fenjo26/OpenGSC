"use client";

import { useEffect, useState } from "react";
import {
  Save, Trash2, Check, ScrollText, Eye, FileJson, ArrowLeft, ArrowRight,
  Sparkles, FileText, Type, Shield, Ban, Loader2, X, HelpCircle, Copy, Download,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { readUrlParam, writeUrlParam } from "@/lib/urlParam";
import { EditorialPolicy, DEFAULT_POLICY, renderPolicy, toExportJson, normalizePolicy } from "@/lib/seo/policy";
import { loadPolicies, savePolicies, getActivePolicyName, setActivePolicyName, getTaskCreds, getFirecrawlKey } from "@/lib/seo/keys";
import { TONES } from "@/lib/seo/tones";

const MAX_POLICIES = 10;

// ─── Option card (single choice) ───────────────────────────────────────────────
function OptionCard({ active, title, sub, onClick }: { active: boolean; title: string; sub?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      textAlign: "left", padding: "13px 15px", borderRadius: "10px", cursor: "pointer",
      border: `1.5px solid ${active ? "var(--color-accent-blue)" : "var(--color-border)"}`,
      background: active ? "rgba(41,151,255,0.08)" : "var(--color-bg)",
      transition: "all 0.12s", width: "100%",
    }}>
      <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: sub ? "2px" : 0 }}>{title}</div>
      {sub && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{sub}</div>}
    </button>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>{children}</div>;
}

// Single-choice group with presets + an "Other" card that reveals a free-text field,
// so any parameter can hold a custom value (matches the reference's flexibility).
function ChoiceGroup({ value, presets, onChange, t }: { value: string; presets: string[][]; onChange: (v: string) => void; t: any }) {
  const isCustom = !!value && !presets.some(p => p[0] === value);
  const [open, setOpen] = useState(isCustom);
  return (
    <>
      <CardGrid>
        {presets.map(([v, l, ex]) => (
          <OptionCard key={v} active={!open && value === v} title={t(l)} sub={ex ? t(ex) : undefined}
            onClick={() => { setOpen(false); onChange(v); }} />
        ))}
        <OptionCard active={open} title={t("seoChoiceOther")} sub={t("seoChoiceOtherSub")}
          onClick={() => { if (!isCustom) onChange(""); setOpen(true); }} />
      </CardGrid>
      {open && (
        <input className="tool-input" style={{ marginTop: "10px" }} autoFocus
          value={isCustom ? value : ""} placeholder={t("seoChoiceOtherPh")}
          onChange={e => onChange(e.target.value)} />
      )}
    </>
  );
}

// ─── Toggle row ─────────────────────────────────────────────────────────────────
function ToggleRow({ on, onToggle, title, desc, disabled }: { on: boolean; onToggle: () => void; title: string; desc?: string; disabled?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
      padding: "12px 15px", borderRadius: "10px", border: "1px solid var(--color-border)",
      background: "var(--color-bg)", opacity: disabled ? 0.5 : 1,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{title}</div>
        {desc && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{desc}</div>}
      </div>
      <button onClick={disabled ? undefined : onToggle} disabled={disabled} style={{
        width: "42px", height: "24px", borderRadius: "999px", flexShrink: 0, border: "none",
        background: on ? "var(--color-accent-green)" : "var(--color-border)",
        position: "relative", cursor: disabled ? "default" : "pointer", transition: "background 0.15s",
      }}>
        <span style={{
          position: "absolute", top: "2px", left: on ? "20px" : "2px", width: "20px", height: "20px",
          borderRadius: "50%", background: "#fff", transition: "left 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }} />
      </button>
    </div>
  );
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="tool-section-label" style={{ marginBottom: "10px", marginTop: "4px" }}>{children}</div>
);

// ─── Main ─────────────────────────────────────────────────────────────────────
const STEPS = [
  { key: "basics", icon: Sparkles, label: "seoStepBasics", sub: "seoStepBasicsSub" },
  { key: "formatting", icon: Type, label: "seoFormatting", sub: "seoFormattingContentSub" },
  { key: "quality", icon: Shield, label: "seoQualityStandards", sub: "seoQualityStandardsSub" },
  { key: "restrictions", icon: Ban, label: "seoRestrictions", sub: "seoRestrictionsTabSub" },
] as const;

export default function PolicyPage() {
  const { t } = useLanguage();
  const [policies, setPolicies] = useState<EditorialPolicy[]>([DEFAULT_POLICY]);
  const [activeName, setActiveName] = useState("Default");
  const [view, setView] = useState<"hub" | "editor">("hub");
  const [draft, setDraft] = useState<EditorialPolicy>(DEFAULT_POLICY);
  const [step, setStep] = useState(0);
  // Deep link (?view=editor&step=2): restore on mount, mirror on change. The step only means
  // something inside the editor — the hub carries no step param, and restoring one without the
  // editor open would be a URL that describes nothing. Validated against STEPS bounds.
  useEffect(() => {
    const v = readUrlParam("view");
    if (v !== "hub" && v !== "editor") return;
    setView(v);
    if (v === "editor") {
      const s = Number(readUrlParam("step"));
      if (Number.isInteger(s) && s >= 0 && s < STEPS.length) setStep(s);
    }
  }, []);
  useEffect(() => {
    writeUrlParam("view", view);
    writeUrlParam("step", view === "editor" ? String(step) : null);
  }, [view, step]);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [genErr, setGenErr] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    setPolicies(loadPolicies());
    setActiveName(getActivePolicyName());
  }, []);

  function openEditor(p: EditorialPolicy) {
    setDraft(structuredClone(p));
    setStep(0);
    setShowPreview(false);
    setView("editor");
  }

  function newPolicy() {
    const n = policies.length + 1;
    openEditor({ ...structuredClone(DEFAULT_POLICY), name: `Policy ${n}`, createdAt: Date.now() });
  }

  function save() {
    const others = policies.filter(p => p.name !== draft.name);
    const withDate = draft.createdAt ? draft : { ...draft, createdAt: Date.now() };
    const next = [...others, withDate].sort((a, b) => a.name.localeCompare(b.name));
    setPolicies(next); savePolicies(next); setActivePolicyName(draft.name); setActiveName(draft.name);
    setSaved(true); setTimeout(() => setSaved(false), 1500);
    setView("hub");
  }

  function removePolicy(name: string) {
    const next = policies.filter(p => p.name !== name);
    const safe = next.length ? next : [DEFAULT_POLICY];
    setPolicies(safe); savePolicies(safe);
    if (activeName === name) { setActivePolicyName(safe[0].name); setActiveName(safe[0].name); }
  }

  async function generateWithAI(form: { brandName: string; brandUrl: string; sourceUrls: string[]; brandDescription: string; competitorUrls: string[]; sampleText: string }) {
    setGenErr("");
    const { provider, apiKey, model, baseUrl } = getTaskCreds("policy");
    if (!apiKey) { setGenErr(t("seoErrNoAiKey")); return; }
    if (!form.brandName.trim()) { setGenErr(t("seoGenAiBrandNameReq")); return; }
    setGenLoading(true);
    try {
      const res = await fetch("/api/seo/policy-draft", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandName: form.brandName, brandUrl: form.brandUrl, niche: form.brandName,
          sourceUrls: form.sourceUrls, brandDescription: form.brandDescription,
          competitorUrls: form.competitorUrls, sampleText: form.sampleText,
          firecrawlKey: getFirecrawlKey() || undefined,
          aiProvider: provider, aiApiKey: apiKey, model: model || undefined, aiBaseUrl: baseUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setGenErr(data.error === "parse_failed" ? t("seoErrParseJsonShort") : (data.error || t("seoErrGen"))); setGenLoading(false); return; }
      const p = normalizePolicy({ ...data.policy, name: data.policy?.name || form.brandName.slice(0, 40), createdAt: Date.now() });
      setGenLoading(false); setGenOpen(false);
      openEditor(p);
    } catch (e: any) { setGenErr(String(e?.message ?? e)); setGenLoading(false); }
  }

  const up = (fn: (d: EditorialPolicy) => void) => setDraft(d => { const n = structuredClone(d); fn(n); return n; });

  // progress over key fields
  const filledCount = [
    draft.brand?.name, draft.brand?.competitors?.length, draft.audience?.customerProfile,
    draft.audience?.industryNiche, draft.voice?.authorPersona,
    draft.quality?.eeatRequirements, draft.restrictions?.complianceRequirements,
  ].filter(Boolean).length;
  const progress = Math.round((filledCount / 7) * 100);

  // ─── HUB ──────────────────────────────────────────────────────────────────────
  if (view === "hub") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <div>
            <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 6px" }}>{t("seoPolHubTitle")}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span className="pill" style={{ fontSize: "11px" }}>{policies.length}/{MAX_POLICIES} {t("seoPolUsed")}</span>
              <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("seoPolHubSub")}</span>
            </div>
          </div>
          <button onClick={() => setShowHelp(s => !s)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: showHelp ? "var(--color-accent-purple)" : "var(--color-bg)", color: showHelp ? "#fff" : "var(--color-text-secondary)", fontSize: "13px", cursor: "pointer", flexShrink: 0 }}>
            <HelpCircle size={14} /> {t("seoPolHelpToggle")}
          </button>
        </div>

        {/* How it works / why / what it affects */}
        {showHelp && (
          <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "14px", background: "var(--color-bg)" }}>
            {([
              ["seoPolHelpWhatTitle", "seoPolHelpWhat"],
              ["seoPolHelpWhyTitle", "seoPolHelpWhy"],
              ["seoPolHelpAffectsTitle", "seoPolHelpAffects"],
              ["seoPolHelpToneTitle", "seoPolHelpTone"],
              ["seoPolHelpTipTitle", "seoPolHelpTip"],
            ] as const).map(([title, body]) => (
              <div key={title}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "3px" }}>{t(title)}</div>
                <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{t(body)}</div>
              </div>
            ))}
          </div>
        )}

        {/* Create */}
        <div className="panel">
          <div style={{ textAlign: "center", marginBottom: "16px" }}>
            <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seoPolCreateNew")}</div>
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("seoPolHubSub")}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", maxWidth: "640px", margin: "0 auto" }}>
            <CreateCard icon={<FileText size={22} />} title={t("seoPolCreateFirst")} sub={t("seoPolManualSetup")} disabled={policies.length >= MAX_POLICIES} onClick={newPolicy} />
            <CreateCard icon={<Sparkles size={22} />} title={t("seoPolGenAI")} sub={t("seoPolAutoGen")} disabled={policies.length >= MAX_POLICIES} onClick={() => { setGenErr(""); setGenOpen(true); }} />
          </div>
          {policies.length >= MAX_POLICIES && <div style={{ textAlign: "center", marginTop: "12px", fontSize: "12px", color: "var(--color-accent-orange)" }}>{t("seoPolLimitReached")}</div>}
        </div>

        {/* List */}
        {policies.map(p => (
          <div key={p.name} className="panel">
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "10px" }}>
              <div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
                  <ScrollText size={15} color="var(--color-accent-purple)" /> {p.name}
                  {p.name === activeName && <span style={{ fontSize: "9px", fontWeight: 700, background: "var(--color-accent-green)", color: "#fff", padding: "2px 7px", borderRadius: "10px" }}>ACTIVE</span>}
                </div>
                {p.createdAt && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px" }}>{t("seoPolCreatedAt")}: {new Date(p.createdAt).toLocaleDateString()}</div>}
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                <button onClick={() => { setActivePolicyName(p.name); setActiveName(p.name); openEditor(p); }} style={btnGhost}><Eye size={13} /> {t("seoEdit")}</button>
                {policies.length > 1 && <button onClick={() => removePolicy(p.name)} style={{ ...btnGhost, color: "var(--color-accent-red)", borderColor: "rgba(255,69,58,0.25)" }}><Trash2 size={13} /> {t("seoDelete")}</button>}
              </div>
            </div>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", lineHeight: 1.5, color: "var(--color-text-secondary)", margin: 0, fontFamily: "monospace", maxHeight: "72px", overflow: "hidden", maskImage: "linear-gradient(to bottom, #000 60%, transparent)" }}>{renderPolicy(p)}</pre>
          </div>
        ))}

        {genOpen && (
          <GenModal loading={genLoading} err={genErr} t={t}
            onClose={() => setGenOpen(false)} onGenerate={generateWithAI} />
        )}
      </div>
    );
  }

  // ─── EDITOR (wizard) ────────────────────────────────────────────────────────────
  const StepIcon = STEPS[step].icon;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button onClick={() => setView("hub")} style={{ ...btnGhost, padding: "8px" }}><ArrowLeft size={16} /></button>
          <div>
            <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("seoPolEditorTitle")}</h2>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("seoPolEditorSub")}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={() => { setShowJson(s => !s); setShowPreview(false); }} style={{ ...btnGhost, background: showJson ? "var(--color-accent-purple)" : undefined, color: showJson ? "#fff" : undefined, border: showJson ? "none" : undefined }}><FileJson size={14} /> JSON</button>
          <button onClick={() => { setShowPreview(s => !s); setShowJson(false); }} style={{ ...btnGhost, background: showPreview ? "var(--color-accent-purple)" : undefined, color: showPreview ? "#fff" : undefined, border: showPreview ? "none" : undefined }}><Eye size={14} /> {t("seoPolPreviewPrompt")}</button>
        </div>
      </div>

      {/* progress */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "6px" }}>
          <span>{t("seoPolRequiredFilled")}</span><span>{progress}%</span>
        </div>
        <div style={{ height: "4px", borderRadius: "2px", background: "var(--color-border)", overflow: "hidden" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: "var(--color-accent-purple)", transition: "width 0.2s" }} />
        </div>
      </div>

      {showPreview && (
        <div className="panel" style={{ background: "var(--color-bg)" }}>
          <div className="tool-section-label" style={{ marginBottom: "8px" }}>{t("seoPromptRender")}</div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", lineHeight: 1.55, color: "var(--color-text-primary)", margin: 0, fontFamily: "monospace" }}>{renderPolicy(draft)}</pre>
        </div>
      )}

      {showJson && <JsonExportPanel draft={draft} t={t} />}

      <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
        {/* left steps */}
        <div className="panel" style={{ width: "210px", flexShrink: 0, padding: "12px" }}>
          {STEPS.map((s, i) => {
            const Icon = s.icon; const on = i === step;
            return (
              <button key={s.key} onClick={() => setStep(i)} style={{
                display: "flex", alignItems: "center", gap: "10px", width: "100%", textAlign: "left",
                padding: "10px 11px", borderRadius: "9px", marginBottom: "4px", cursor: "pointer", border: "none",
                background: on ? "rgba(191,90,242,0.12)" : "transparent",
              }}>
                <Icon size={16} color={on ? "var(--color-accent-purple)" : "var(--color-text-secondary)"} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "13px", fontWeight: on ? 700 : 500, color: on ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>{t(s.label as any)}</div>
                  <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(s.sub as any)}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* step content */}
        <div className="panel" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "18px" }}>
            <StepIcon size={19} color="var(--color-accent-purple)" />
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t(STEPS[step].label as any)}</div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t(STEPS[step].sub as any)}</div>
            </div>
          </div>

          {step === 0 && <BasicsStep draft={draft} up={up} t={t} />}
          {step === 1 && <FormattingStep draft={draft} up={up} t={t} />}
          {step === 2 && <QualityStep draft={draft} up={up} t={t} />}
          {step === 3 && <RestrictionsStep draft={draft} up={up} t={t} />}

          {/* nav */}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "22px", paddingTop: "16px", borderTop: "1px solid var(--color-border)" }}>
            <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0} style={{ ...btnGhost, opacity: step === 0 ? 0.4 : 1 }}><ArrowLeft size={14} /> {t("seoBack")}</button>
            <button onClick={() => setStep(s => Math.min(STEPS.length - 1, s + 1))} disabled={step === STEPS.length - 1} style={{ ...btnDark, opacity: step === STEPS.length - 1 ? 0.4 : 1 }}>{t("seoNext")} <ArrowRight size={14} /></button>
          </div>
        </div>
      </div>

      {/* save bar */}
      <div className="panel" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ flex: 1 }}>
          <label className="tool-field-label">{t("seoPolProjectName")} *</label>
          <input className="tool-input" value={draft.name} onChange={e => up(d => { d.name = e.target.value; })} />
        </div>
        <button onClick={save} disabled={!draft.name.trim()} style={{ ...btnPurple, alignSelf: "flex-end", opacity: draft.name.trim() ? 1 : 0.5 }}>
          {saved ? <><Check size={15} /> {t("seoSaved")}</> : <><Save size={15} /> {t("seoPolSavePolicy")}</>}
        </button>
      </div>
    </div>
  );
}

// ─── Steps ──────────────────────────────────────────────────────────────────────
function BasicsStep({ draft, up, t }: any) {
  const EXP = [
    ["beginner", "seoExpBeginner", "seoExpBeginnerSub"],
    ["intermediate", "seoExpIntermediate", "seoExpIntermediateSub"],
    ["expert", "seoExpExpert", "seoExpExpertSub"],
  ];
  const setB = (k: string, v: any) => up((d: any) => { (d.brand ||= {})[k] = v; });
  const setA = (k: string, v: any) => up((d: any) => { (d.audience ||= {})[k] = v; });
  const setV = (k: string, v: any) => up((d: any) => { (d.voice ||= {})[k] = v; });
  return (
    <div>
      <FieldLabel>{t("seoBrand")}</FieldLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
        <div><label className="tool-field-label">{t("seoBrandName")}</label><input className="tool-input" value={draft.brand?.name || ""} onChange={e => setB("name", e.target.value)} /></div>
        <div><label className="tool-field-label">{t("seoBrandUrl")}</label><input className="tool-input" value={draft.brand?.url || ""} onChange={e => setB("url", e.target.value)} placeholder="https://" /></div>
      </div>
      <div style={{ marginTop: "12px" }}><label className="tool-field-label">{t("seoBrandDesc")}</label>
        <textarea className="tool-input" style={{ minHeight: "54px", resize: "vertical" }} placeholder={t("seoBrandDescPh")} value={draft.brand?.description || ""} onChange={e => setB("description", e.target.value)} /></div>
      <div style={{ marginTop: "12px" }}><label className="tool-field-label">{t("seoBrandValues")}</label>
        <input className="tool-input" placeholder={t("seoBrandValuesPh")} value={draft.brand?.values || ""} onChange={e => setB("values", e.target.value)} /></div>
      <div style={{ marginTop: "12px" }}><label className="tool-field-label">{t("seoCompetitors")}</label>
        <input className="tool-input" value={(draft.brand?.competitors || []).join(", ")} placeholder={t("seoCompetitorsPh")}
          onChange={e => setB("competitors", e.target.value.split(",").map((x: string) => x.trim()).filter(Boolean))} /></div>

      <FieldLabel>{t("seoAudienceSection")}</FieldLabel>
      <div style={{ marginBottom: "12px" }}><label className="tool-field-label">{t("seoCustomerProfile")}</label>
        <textarea className="tool-input" style={{ minHeight: "54px", resize: "vertical" }} placeholder={t("seoCustomerProfilePh")} value={draft.audience?.customerProfile || ""} onChange={e => setA("customerProfile", e.target.value)} /></div>
      <div style={{ marginBottom: "12px" }}><label className="tool-field-label">{t("seoIndustryNiche")}</label>
        <input className="tool-input" placeholder={t("seoIndustryNichePh")} value={draft.audience?.industryNiche || ""} onChange={e => setA("industryNiche", e.target.value)} /></div>
      <CardGrid>
        {EXP.map(([v, l, s]) => (
          <OptionCard key={v} active={draft.audience?.expertiseLevel === v} title={t(l)} sub={t(s)} onClick={() => setA("expertiseLevel", v)} />
        ))}
      </CardGrid>

      <FieldLabel>{t("seoVoiceTone")}</FieldLabel>
      <div style={{ marginBottom: "12px" }}><label className="tool-field-label">{t("seoAuthorPersona")}</label>
        <input className="tool-input" placeholder={t("seoAuthorPersonaPh")} value={draft.voice?.authorPersona || ""} onChange={e => setV("authorPersona", e.target.value)} /></div>
      <CardGrid>
        {TONES.map((tn) => (
          <OptionCard key={tn.value} active={(draft.voice?.toneOfVoice || "expert") === tn.value} title={t(tn.labelKey as any)}
            onClick={() => up((d: any) => { (d.voice ||= {}).toneOfVoice = tn.value; d.voice.formalityLevel = tn.formality; })} />
        ))}
      </CardGrid>
    </div>
  );
}

function FormattingStep({ draft, up, t }: any) {
  const s = draft.structure || {};
  const setS = (k: string, v: any) => up((d: any) => { (d.structure ||= {})[k] = v; });
  const setEl = (k: string, v: boolean) => up((d: any) => { ((d.structure ||= {}).elements ||= {})[k] = v; });
  const el = s.elements || {};
  const HS = [["questions", "seoHsQuestions", "seoHsQuestionsEx"], ["statements", "seoHsStatements", "seoHsStatementsEx"], ["how-to", "seoHsHowto", "seoHsHowtoEx"], ["mixed", "seoHsMixed", "seoHsMixedEx"]];
  const HC = [["sentence", "seoHcSentence", "seoHcSentenceEx"], ["title", "seoHcTitle", "seoHcTitleEx"], ["upper", "seoHcUpper", "seoHcUpperEx"]];
  const PL = [["short", "seoPlShort", "seoPlShortEx"], ["medium", "seoPlMedium", "seoPlMediumEx"], ["long", "seoPlLong", "seoPlLongEx"]];
  return (
    <div>
      <FieldLabel>{t("seoHeadingStyle")}</FieldLabel>
      <ChoiceGroup value={s.headingStyle || ""} presets={HS} onChange={v => setS("headingStyle", v)} t={t} />

      <FieldLabel>{t("seoHeadingCase")}</FieldLabel>
      <ChoiceGroup value={s.headingCapitalization || ""} presets={HC} onChange={v => setS("headingCapitalization", v)} t={t} />

      <FieldLabel>{t("seoParaLength")}</FieldLabel>
      <ChoiceGroup value={s.paragraphLength || ""} presets={PL} onChange={v => setS("paragraphLength", v)} t={t} />

      <FieldLabel>{t("seoTextFormatting")}</FieldLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <ToggleRow on={!!el.bold} onToggle={() => setEl("bold", !el.bold)} title={t("seoUseBold")} desc={t("seoUseBoldDesc")} />
        <ToggleRow on={!!el.italics} onToggle={() => setEl("italics", !el.italics)} title={t("seoUseItalic")} desc={t("seoUseItalicDesc")} />
      </div>

      <FieldLabel>{t("seoContentElements")}</FieldLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <ToggleRow on={!!el.tables} onToggle={() => setEl("tables", !el.tables)} title={t("seoUseTables")} desc={t("seoUseTablesDesc")} />
        <ToggleRow on={!!el.quotes} onToggle={() => setEl("quotes", !el.quotes)} title={t("seoUseQuotes")} desc={t("seoUseQuotesDesc")} />
        <ToggleRow on={!!el.lists} onToggle={() => setEl("lists", !el.lists)} title={t("seoUseLists")} desc={t("seoUseListsDesc")} />
        <ToggleRow on={!!el.examples} onToggle={() => setEl("examples", !el.examples)} title={t("seoUseExamples")} desc={t("seoUseExamplesDesc")} />
        <ToggleRow on={!!el.images} onToggle={() => setEl("images", !el.images)} title={t("seoUseImages")} desc={t("seoUseImagesDesc")} />
      </div>
    </div>
  );
}

function QualityStep({ draft, up, t }: any) {
  const q = draft.quality || {};
  const setQ = (k: string, v: any) => up((d: any) => { (d.quality ||= {})[k] = v; });
  const CS = [["inline", "seoCsInline", "seoCsInlineEx"], ["footnotes", "seoCsFootnotes", "seoCsFootnotesEx"], ["none", "seoCsNone", "seoCsNoneEx"]];
  return (
    <div>
      <div style={{ padding: "12px 14px", borderRadius: "10px", background: "rgba(255,159,10,0.06)", border: "1px solid rgba(255,159,10,0.2)", marginBottom: "18px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-accent-orange)", marginBottom: "3px" }}>💡 {t("seoEeatCallout")}</div>
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("seoEeatCalloutDesc")}</div>
      </div>

      <FieldLabel>{t("seoCitationStyle")}</FieldLabel>
      <ChoiceGroup value={q.citationStyle || ""} presets={CS} onChange={v => setQ("citationStyle", v)} t={t} />

      <div style={{ marginTop: "12px" }}>
        <ToggleRow on={!!q.requireSourceLinks} onToggle={() => setQ("requireSourceLinks", !q.requireSourceLinks)} title={t("seoRequireSources")} desc={t("seoRequireSourcesDesc")} />
      </div>

      <FieldLabel>{t("seoEeatReq")}</FieldLabel>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "6px", marginTop: "-4px" }}>{t("seoEeatReqSub")}</div>
      <textarea className="tool-input" style={{ minHeight: "64px", resize: "vertical" }} placeholder={t("seoEeatReqPh")} value={q.eeatRequirements || ""} onChange={e => setQ("eeatRequirements", e.target.value)} />

      <FieldLabel>{t("seoFactChecking")}</FieldLabel>
      <textarea className="tool-input" style={{ minHeight: "58px", resize: "vertical" }} placeholder={t("seoFactCheckingPh")} value={q.factCheckingNotes || ""} onChange={e => setQ("factCheckingNotes", e.target.value)} />
    </div>
  );
}

function RestrictionsStep({ draft, up, t }: any) {
  const r = draft.restrictions || {};
  const setR = (k: string, v: any) => up((d: any) => { (d.restrictions ||= {})[k] = v; });
  return (
    <div>
      <label className="tool-field-label">{t("seoBannedWords")}</label>
      <input className="tool-input" value={r.wordsToAvoid || ""} placeholder={t("seoBannedWordsPh")} onChange={e => setR("wordsToAvoid", e.target.value)} />
      <div style={{ height: "14px" }} />
      <label className="tool-field-label">{t("seoBannedTopics")}</label>
      <input className="tool-input" value={r.topicsToAvoid || ""} placeholder={t("seoBannedTopicsPh")} onChange={e => setR("topicsToAvoid", e.target.value)} />
      <div style={{ height: "14px" }} />
      <label className="tool-field-label">{t("seoComplianceField")}</label>
      <textarea className="tool-input" style={{ minHeight: "80px", resize: "vertical" }} placeholder={t("seoCompliancePh")} value={r.complianceRequirements || ""} onChange={e => setR("complianceRequirements", e.target.value)} />
    </div>
  );
}

// ─── Bits ───────────────────────────────────────────────────────────────────────
function CreateCard({ icon, title, sub, onClick, disabled }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled} style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", padding: "30px 20px",
      borderRadius: "12px", border: "1px solid var(--color-border)", background: "var(--color-bg)",
      cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, transition: "border-color 0.15s",
    }}
      onMouseOver={e => { if (!disabled) e.currentTarget.style.borderColor = "var(--color-accent-purple)"; }}
      onMouseOut={e => e.currentTarget.style.borderColor = "var(--color-border)"}>
      <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "var(--color-card-hover)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)" }}>{icon}</div>
      <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", textAlign: "center" }}>{title}</div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{sub}</div>
    </button>
  );
}

function GenModal({ loading, err, t, onClose, onGenerate }: any) {
  const [brandName, setBrandName] = useState("");
  const [brandUrl, setBrandUrl] = useState("");
  const [useUrls, setUseUrls] = useState(false);
  const [sourceUrls, setSourceUrls] = useState("");
  const [useDesc, setUseDesc] = useState(false);
  const [brandDescription, setBrandDescription] = useState("");
  const [useComp, setUseComp] = useState(false);
  const [competitorUrls, setCompetitorUrls] = useState("");
  const [useSample, setUseSample] = useState(false);
  const [sampleText, setSampleText] = useState("");

  const toLines = (s: string) => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
  const submit = () => onGenerate({
    brandName, brandUrl,
    sourceUrls: useUrls ? toLines(sourceUrls) : [],
    brandDescription: useDesc ? brandDescription : "",
    competitorUrls: useComp ? toLines(competitorUrls) : [],
    sampleText: useSample ? sampleText : "",
  });

  const lbl: React.CSSProperties = { fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", display: "block", marginBottom: "6px" };
  const Check = ({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) => (
    <label style={{ display: "flex", alignItems: "center", gap: "9px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer", padding: "4px 0" }}>
      <input type="checkbox" checked={on} onChange={onToggle} /> {label}
    </label>
  );
  const groupBox: React.CSSProperties = { border: "1px solid var(--color-border)", borderRadius: "10px", padding: "12px 14px" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: "24px" }} onClick={onClose}>
      <div className="panel" style={{ width: "560px", maxWidth: "94vw", maxHeight: "88vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "4px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}><Sparkles size={17} color="var(--color-accent-purple)" /> {t("seoGenAiTitle")}</div>
          <button onClick={onClose} style={{ ...btnGhost, padding: "6px" }}><X size={14} /></button>
        </div>
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "16px" }}>{t("seoGenAiSub")}</div>

        <label style={lbl}>{t("seoGenAiBrandName")} *</label>
        <input className="tool-input" style={{ marginBottom: "12px" }} value={brandName} onChange={e => setBrandName(e.target.value)} placeholder={t("seoGenAiBrandNamePh")} autoFocus />
        <label style={lbl}>{t("seoGenAiBrandUrl")}</label>
        <input className="tool-input" style={{ marginBottom: "14px" }} value={brandUrl} onChange={e => setBrandUrl(e.target.value)} placeholder="https://yourbrand.com" />

        <div style={{ ...groupBox, marginBottom: "12px" }}>
          <div className="tool-section-label" style={{ marginBottom: "6px" }}>{t("seoGenAiSources")}</div>
          <Check on={useUrls} onToggle={() => setUseUrls(v => !v)} label={t("seoGenAiAddUrls")} />
          {useUrls && <textarea className="tool-input" style={{ minHeight: "56px", resize: "vertical", margin: "6px 0 4px" }} value={sourceUrls} onChange={e => setSourceUrls(e.target.value)} placeholder={t("seoGenAiUrlsPh")} />}
          <Check on={useDesc} onToggle={() => setUseDesc(v => !v)} label={t("seoGenAiAddDesc")} />
          {useDesc && <textarea className="tool-input" style={{ minHeight: "64px", resize: "vertical", marginTop: "6px" }} value={brandDescription} onChange={e => setBrandDescription(e.target.value)} placeholder={t("seoGenAiDescPh")} />}
        </div>

        <div style={{ ...groupBox, marginBottom: "14px" }}>
          <div className="tool-section-label" style={{ marginBottom: "6px" }}>{t("seoGenAiStyleSources")}</div>
          <Check on={useComp} onToggle={() => setUseComp(v => !v)} label={t("seoGenAiAnalyzeComp")} />
          {useComp && <textarea className="tool-input" style={{ minHeight: "56px", resize: "vertical", margin: "6px 0 4px" }} value={competitorUrls} onChange={e => setCompetitorUrls(e.target.value)} placeholder={t("seoGenAiCompPh")} />}
          <Check on={useSample} onToggle={() => setUseSample(v => !v)} label={t("seoGenAiAddSample")} />
          {useSample && <textarea className="tool-input" style={{ minHeight: "80px", resize: "vertical", marginTop: "6px" }} value={sampleText} onChange={e => setSampleText(e.target.value)} placeholder={t("seoGenAiSamplePh")} />}
        </div>

        {err && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginBottom: "10px" }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={onClose} style={btnGhost}>{t("seoCancel")}</button>
          <button onClick={submit} disabled={loading || !brandName.trim()} style={{ ...btnPurple, opacity: loading || !brandName.trim() ? 0.6 : 1 }}>
            {loading ? <><Loader2 size={14} className="spin" /> {t("seoGenAiLoading")}</> : <><Sparkles size={14} /> {t("seoGenAiBtn")}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function JsonExportPanel({ draft, t }: { draft: EditorialPolicy; t: any }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(toExportJson(draft), null, 2);
  const copy = () => navigator.clipboard.writeText(json).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `policy-${draft.name.replace(/\s+/g, "-")}.json`; a.click();
  };
  return (
    <div className="panel" style={{ background: "var(--color-bg)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", marginBottom: "10px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("seoJsonExportTitle")}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("seoJsonExportSub")}</div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
          <button onClick={copy} style={btnGhost}>{copied ? <><Check size={13} /> {t("seoCopied")}</> : <><Copy size={13} /> {t("seoCopyToClipboard")}</>}</button>
          <button onClick={download} style={btnGhost}><Download size={13} /> {t("seoDownloadJson")}</button>
        </div>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", lineHeight: 1.5, color: "var(--color-text-primary)", margin: 0, fontFamily: "monospace", maxHeight: "360px", overflow: "auto" }}>{json}</pre>
    </div>
  );
}

const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnDark: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 16px", borderRadius: "8px", border: "none", background: "var(--color-text-primary)", color: "var(--color-bg)", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "9px 18px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
