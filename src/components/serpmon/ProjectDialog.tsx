"use client";

// New/Edit project dialog. Create mode carries the keyword import (textarea + .csv/.txt file
// dropped into the same textarea, live line counter); edit mode deliberately does NOT edit
// keywords in place — a "replace" typed casually over a 900-keyword project is not undoable —
// so there the keyword fields collapse into two explicit buttons (add / replace), each with
// its own textarea and its own POST to /projects/[id]/keywords.

import { useMemo, useRef, useState } from "react";
import { Loader2, Upload, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES, LANGUAGES, defaultLanguageFor } from "@/lib/seo/regions";
import { SERPMON_DEPTHS, SERPMON_INTERVALS, SERPMON_MAX_KEYWORDS, type ProjectDetail } from "@/lib/serpmon/types";
import { sendJson, trOf, btnGhost, btnPrimary, inputStyle } from "./shared";

export interface ImportInfo { added: number; duplicates: number; skipped: number }

const labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--color-text-primary)" } as const;
const hintStyle = { fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 3 } as const;

export default function ProjectDialog({ project, onClose, onSaved }: {
  /** null = create. */
  project: ProjectDetail | null;
  onClose: () => void;
  onSaved: (p: ProjectDetail, importInfo: ImportInfo | null) => void;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);
  const editing = project !== null;

  const [name, setName] = useState(project?.name ?? "");
  const [country, setCountry] = useState(project?.country ?? "");
  const [lang, setLang] = useState(project?.lang ?? "");
  const [countryQ, setCountryQ] = useState("");
  const [depth, setDepth] = useState<number>(project?.depth ?? 100);
  const [intervalHours, setIntervalHours] = useState<number>(project?.intervalHours ?? 24);
  // Create-only: the raw import text. Edit mode sends keywords through the two explicit
  // buttons below instead.
  const [keywords, setKeywords] = useState("");
  const [kwMode, setKwMode] = useState<"" | "add" | "replace">("");
  const [kwRaw, setKwRaw] = useState("");
  const [ownDomains, setOwnDomains] = useState((project?.ownDomains ?? []).join("\n"));
  const [ignoreHosts, setIgnoreHosts] = useState((project?.ignoreHosts ?? []).join("\n"));
  const [retentionDays, setRetentionDays] = useState(String(project?.retentionDays ?? 180));
  const [aparserPreset, setAparserPreset] = useState(project?.aparserPreset ?? "default");
  const [alertStorm, setAlertStorm] = useState(project?.alertStorm ?? true);
  const [paused, setPaused] = useState(project?.paused ?? false);
  const [busy, setBusy] = useState<"" | "save" | "kw">("");
  const [error, setError] = useState("");
  const [kwNote, setKwNote] = useState("");
  const [alertNote, setAlertNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const kwLines = useMemo(() => keywords.split(/\r?\n/).filter(l => l.trim()).length, [keywords]);
  const kwRawLines = useMemo(() => kwRaw.split(/\r?\n/).filter(l => l.trim()).length, [kwRaw]);

  const countryMatches = useMemo(() => {
    const q = countryQ.trim().toLowerCase();
    if (!q) return [];
    return COUNTRIES.filter(c => c.label.toLowerCase().includes(q) || c.code.includes(q)).slice(0, 8);
  }, [countryQ]);

  const countryLabel = (code: string) => COUNTRIES.find(c => c.code === code)?.label ?? code;

  const pickCountry = (code: string) => {
    setCountry(code);
    setCountryQ("");
    // The brief's "language is filled in from the country": switching markets re-points hl to
    // that market's default, and the user can still override it in the select below.
    setLang(defaultLanguageFor(code));
  };

  async function save() {
    if (busy) return;
    if (!name.trim()) { setError(tr("serpmonFieldName")); return; }
    if (!country) { setError(tr("serpmonFieldCountry")); return; }
    setBusy("save"); setError("");
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(), country, lang, depth, intervalHours,
        ownDomains, ignoreHosts, retentionDays: Number(retentionDays) || 180,
        aparserPreset: aparserPreset.trim() || "default",
        alertStorm, paused,
      };
      if (!editing) payload.keywords = keywords;
      const { status, body } = await sendJson(
        editing ? `/api/serp-monitor/projects/${project.id}` : "/api/serp-monitor/projects",
        editing ? "PATCH" : "POST",
        payload,
      );
      if (body.notMigrated) { setError(tr("serpmonNotMigrated")); return; }
      if (status >= 400) {
        const code = String(body.error ?? status);
        setError(code === "aparser_preset_missing" ? tr("serpmonAparserPresetMissing").replace("{name}", aparserPreset.trim())
          : code === "aparser_preset_invalid" ? tr("serpmonAparserPresetInvalid") : code);
        return;
      }
      const saved = body.project as ProjectDetail | undefined;
      if (!saved) { setError(String(body.error ?? status)); return; }
      const imp = (body.import ?? null) as ImportInfo | null;
      onSaved(saved, imp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function applyKeywords(mode: "add" | "replace") {
    if (busy || !kwRaw.trim() || !project) return;
    setBusy("kw"); setError(""); setKwNote("");
    try {
      const { status, body } = await sendJson(`/api/serp-monitor/projects/${project.id}/keywords`, "POST", { raw: kwRaw, mode });
      if (body.notMigrated) { setError(tr("serpmonNotMigrated")); return; }
      if (status >= 400) { setError(String(body.error ?? status)); return; }
      const imp = body.import as { added?: number; duplicates?: number; skipped?: number } | undefined;
      setKwNote(tr("serpmonImportResult")
        .replace("{added}", String(imp?.added ?? 0))
        .replace("{duplicates}", String(imp?.duplicates ?? 0))
        .replace("{skipped}", String(imp?.skipped ?? 0)));
      setKwRaw(""); setKwMode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function sendTestAlert() {
    if (busy || !project) return;
    setBusy("kw"); setAlertNote("");
    try {
      const { body } = await sendJson(`/api/serp-monitor/projects/${project.id}/test-alert`, "POST");
      if (body.ok) setAlertNote(tr("serpmonTestAlertSent"));
      else if (body.error === "no_channel") setAlertNote(tr("serpmonAlertNoChannel"));
      else setAlertNote(String(body.error ?? "error"));
    } catch (e) {
      setAlertNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  async function acceptFile(file: File | null | undefined) {
    if (!file) return;
    const text = await file.text();
    setKeywords(prev => (prev.trim() ? `${prev.replace(/\n+$/, "")}\n${text}` : text));
  }

  const intervalLabel = (h: number): string => {
    if (h === 0) return tr("serpmonIntervalManual");
    if (h % 24 === 0 && h >= 48) return tr("serpmonIntervalDays").replace("{n}", String(h / 24));
    return tr("serpmonIntervalHours").replace("{n}", String(h));
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto",
    }}>
      <div onClick={e => e.stopPropagation()} className="panel" style={{
        width: "min(620px, 100%)", margin: "24px auto", padding: 18,
        display: "flex", flexDirection: "column", gap: 12, maxHeight: "calc(100vh - 48px)", overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 15, margin: 0, color: "var(--color-text-primary)" }}>
            {editing ? tr("serpmonEdit") : tr("serpmonNewProject")}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {error && <div style={{ fontSize: 12.5, color: "var(--color-danger)", wordBreak: "break-all" }}>{error}</div>}

        {/* Name */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>{tr("serpmonFieldName")}</span>
          <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
        </label>

        {/* Country with search; language follows the country until overridden. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>{tr("serpmonFieldCountry")}</span>
            <input style={inputStyle} value={country ? `${countryLabel(country)} (${country})` : countryQ}
              placeholder="US, Argentina, …"
              onChange={e => { setCountry(""); setCountryQ(e.target.value); }} />
            {countryMatches.length > 0 && (
              <div style={{
                position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, marginTop: 2,
                background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8,
                display: "flex", flexDirection: "column", overflow: "hidden",
              }}>
                {countryMatches.map(c => (
                  <button key={c.code} onClick={() => pickCountry(c.code)}
                    style={{
                      textAlign: "left", padding: "7px 10px", fontSize: 12, cursor: "pointer",
                      background: "transparent", border: "none", color: "var(--color-text-primary)",
                    }}>
                    {c.label} <span style={{ color: "var(--color-text-tertiary)" }}>{c.code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>{tr("serpmonFieldLang")}</span>
            <select style={inputStyle} value={lang} onChange={e => setLang(e.target.value)}>
              <option value="">—</option>
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label} ({l.code})</option>)}
            </select>
          </label>
        </div>

        {/* Depth and check interval */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>{tr("serpmonFieldDepth")}</span>
            <select style={inputStyle} value={depth} onChange={e => setDepth(Number(e.target.value))}>
              {SERPMON_DEPTHS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>{tr("serpmonFieldInterval")}</span>
            <select style={inputStyle} value={intervalHours} onChange={e => setIntervalHours(Number(e.target.value))}>
              {SERPMON_INTERVALS.map(h => <option key={h} value={h}>{intervalLabel(h)}</option>)}
            </select>
          </label>
        </div>

        {/* Keywords: import textarea in create mode; explicit add/replace in edit mode. */}
        {!editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={labelStyle}>{tr("serpmonFieldKeywords")}</span>
              <span style={{ fontSize: 11, color: kwLines > SERPMON_MAX_KEYWORDS ? "var(--color-danger)" : "var(--color-text-tertiary)" }}>
                {kwLines} / {SERPMON_MAX_KEYWORDS}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", flex: 1 }}>{tr("serpmonKeywordsHint")}</span>
              <button onClick={() => fileRef.current?.click()} style={btnGhost}>
                <Upload size={12} /> .csv / .txt
              </button>
              <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" style={{ display: "none" }}
                onChange={e => { void acceptFile(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
            <textarea className="tool-input" rows={7} value={keywords}
              onChange={e => setKeywords(e.target.value)}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }} />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => setKwMode(kwMode === "add" ? "" : "add")}
                style={kwMode === "add" ? { ...btnGhost, borderColor: "var(--color-accent-blue)", color: "var(--color-accent-blue)" } : btnGhost}>
                {tr("serpmonAddKeywords")}
              </button>
              <button onClick={() => setKwMode(kwMode === "replace" ? "" : "replace")}
                style={kwMode === "replace" ? { ...btnGhost, borderColor: "var(--color-accent-orange)", color: "var(--color-accent-orange)" } : btnGhost}>
                {tr("serpmonReplaceKeywords")}
              </button>
            </div>
            {kwMode !== "" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{tr("serpmonKeywordsHint")}</span>
                  <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{kwRawLines}</span>
                </div>
                <textarea className="tool-input" rows={6} value={kwRaw} onChange={e => setKwRaw(e.target.value)}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={() => void applyKeywords(kwMode)} disabled={!kwRaw.trim() || busy === "kw"}
                    style={{ ...btnPrimary, opacity: !kwRaw.trim() || busy === "kw" ? 0.5 : 1 }}>
                    {busy === "kw" ? <Loader2 size={12} className="spin" /> : null}
                    {kwMode === "add" ? tr("serpmonAddKeywords") : tr("serpmonReplaceKeywords")}
                  </button>
                  {kwNote && <span style={{ fontSize: 12, color: "var(--color-success)" }}>{kwNote}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Own domains / hidden hosts */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>{tr("serpmonFieldOwnDomains")}</span>
            <textarea className="tool-input" rows={3} value={ownDomains} onChange={e => setOwnDomains(e.target.value)}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>{tr("serpmonFieldIgnore")}</span>
            <textarea className="tool-input" rows={3} value={ignoreHosts} onChange={e => setIgnoreHosts(e.target.value)}
              style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }} />
            <span style={hintStyle}>{tr("serpmonIgnoreDefaultsHint")}</span>
          </label>
        </div>

        {/* A-Parser preset */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>{tr("serpmonFieldAparserPreset")}</span>
          <input style={{ ...inputStyle, maxWidth: 260 }} value={aparserPreset} maxLength={100}
            placeholder="default" onChange={e => setAparserPreset(e.target.value)} />
          <span style={hintStyle}>{tr("serpmonAparserPresetHint")}</span>
        </label>

        {/* Retention / notifications */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={labelStyle}>{tr("serpmonFieldRetention")}</span>
            <input style={{ ...inputStyle, width: 90 }} type="number" min={30} max={3650}
              value={retentionDays} onChange={e => setRetentionDays(e.target.value)} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--color-text-primary)", paddingBottom: 8 }}>
            <input type="checkbox" checked={alertStorm} onChange={e => setAlertStorm(e.target.checked)} />
            {tr("serpmonFieldAlertStorm")}
          </label>
          {editing && (
            <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--color-text-primary)", paddingBottom: 8 }}>
              <input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} />
              {tr("serpmonPaused")}
            </label>
          )}
        </div>

        {editing && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={() => void sendTestAlert()} style={btnGhost}>{tr("serpmonTestAlert")}</button>
            {alertNote && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{alertNote}</span>}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          <button onClick={onClose} style={btnGhost}>{tr("serpmonCancel")}</button>
          <button onClick={() => void save()} disabled={busy === "save"}
            style={{ ...btnPrimary, opacity: busy === "save" ? 0.6 : 1 }}>
            {busy === "save" ? <Loader2 size={13} className="spin" /> : null} {tr("serpmonSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
