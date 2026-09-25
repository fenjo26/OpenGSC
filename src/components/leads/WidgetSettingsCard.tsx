"use client";

// N9 — Settings card for the audit widget: on/off, key management (generate / regenerate /
// revoke — regenerating kills the old key immediately), allowed origins, accent colour,
// logo, consent text, extra notification e-mail, first-letter template, "about" for
// proposals, the ready-to-paste embed code, and the Turnstile status warning.

import { useCallback, useEffect, useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { t2 } from "@/lib/leads/i18n";
import type { WidgetSettings } from "@/lib/leads/types";

interface WidgetView {
  widgetKey: string;
  settings: WidgetSettings;
  turnstile: boolean;
  smtp: boolean;
  embedCode: string;
}

const label: React.CSSProperties = { fontSize: 11, color: "var(--color-text-secondary)", margin: "10px 0 4px", display: "block" };
const input: React.CSSProperties = {
  width: "100%", padding: "8px 11px", borderRadius: 8, border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: 12, outline: "none",
  fontFamily: "inherit",
};
const mono: React.CSSProperties = { ...input, fontFamily: "monospace" };
const smallBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8,
  border: "1px solid var(--color-border)", background: "var(--color-card)",
  color: "var(--color-text-primary)", fontSize: 12, fontWeight: 600, cursor: "pointer",
};

export default function WidgetSettingsCard() {
  const { language } = useLanguage();
  const tr = useCallback((k: string) => t2(language, k), [language]);

  const [view, setView] = useState<WidgetView | null>(null);
  const [draft, setDraft] = useState<WidgetSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/leads/widget").then(r => r.json()).then((data: WidgetView) => {
      setView(data);
      setDraft(data.settings);
    }).catch(() => setErr(tr("leadLoadError")));
  }, [tr]);

  if (!view || !draft) return null;

  const patch = (p: Partial<WidgetSettings>) => setDraft({ ...draft, ...p });

  const save = async () => {
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/leads/widget", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(String(data?.error ?? "error")); return; }
      setView(data); setDraft(data.settings);
    } finally { setBusy(false); }
  };

  const regen = async () => {
    if (!window.confirm(tr("leadWidgetRegenConfirm"))) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/leads/widget", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setErr(String(data?.error ?? "error")); return; }
      setView(data); setDraft(data.settings);
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!window.confirm(tr("leadWidgetRegenConfirm"))) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/leads/widget", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) { setErr(String(data?.error ?? "error")); return; }
      setView(data); setDraft(data.settings);
    } finally { setBusy(false); }
  };

  const copyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(view.embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — the field is selectable anyway */ }
  };

  const missingKey = !view.widgetKey;

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{tr("leadWidgetTitle")}</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={draft.enabled} onChange={e => patch({ enabled: e.target.checked })} style={{ width: "auto" }} />
          {tr("leadWidgetOn")}
        </label>
      </div>

      {!view.turnstile ? (
        <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: "rgba(245,158,11,.12)", color: "#F59E0B" }}>
          {tr("leadWidgetNoCaptcha")}
        </div>
      ) : null}

      <label style={label}>{tr("leadWidgetKey")}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input style={{ ...mono, flex: "1 1 240px" }} value={view.widgetKey} readOnly
          placeholder={missingKey ? "—" : ""} aria-label={tr("leadWidgetKey")} />
        <button style={smallBtn} onClick={regen} disabled={busy}>
          <RefreshCw size={12} /> {tr("leadWidgetRegen")}
        </button>
        {view.widgetKey ? <button style={smallBtn} onClick={revoke} disabled={busy}>✕</button> : null}
      </div>

      <label style={label}>{tr("leadWidgetEmbed")}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <textarea style={{ ...mono, flex: 1 }} rows={3} value={view.embedCode} readOnly aria-label={tr("leadWidgetEmbed")} />
        <button style={smallBtn} onClick={copyEmbed} disabled={!view.embedCode}>
          <Copy size={12} /> {copied ? tr("leadCopied") : ""}
        </button>
      </div>

      <label style={label}>{tr("leadWidgetOrigins")}</label>
      <textarea style={{ ...input, fontFamily: "monospace" }} rows={2}
        value={draft.allowedOrigins.join("\n")}
        onChange={e => patch({ allowedOrigins: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })} />
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3 }}>{tr("leadWidgetOriginsAny")}</div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px" }}>
          <label style={label}>{tr("leadWidgetAccent")}</label>
          <input style={input} type="color" value={draft.accentColor}
            onChange={e => patch({ accentColor: e.target.value })} />
        </div>
        <div style={{ flex: "2 1 260px" }}>
          <label style={label}>{tr("leadWidgetLogo")}</label>
          <input style={input} value={draft.logoUrl} onChange={e => patch({ logoUrl: e.target.value })}
            placeholder="https://…" />
        </div>
      </div>

      <label style={label}>{tr("leadWidgetConsent")}</label>
      <textarea style={input} rows={2} value={draft.consentText}
        onChange={e => patch({ consentText: e.target.value })}
        placeholder="—" />

      <label style={label}>{tr("leadWidgetNotify")}</label>
      <input style={input} value={draft.notifyEmail} onChange={e => patch({ notifyEmail: e.target.value })}
        placeholder="leads@agency.com" />

      <label style={label}>{tr("leadWidgetTpl")}</label>
      <textarea style={input} rows={3} value={draft.emailTemplate}
        onChange={e => patch({ emailTemplate: e.target.value })} placeholder="—" />

      <label style={label}>{tr("leadWidgetAbout")}</label>
      <textarea style={input} rows={3} value={draft.aboutCompany}
        onChange={e => patch({ aboutCompany: e.target.value })} placeholder="—" />

      <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "center" }}>
        <button className="tool-input" style={smallBtn} onClick={save} disabled={busy}>{tr("leadSave")}</button>
        {err ? <span style={{ fontSize: 12, color: "#f87171" }}>{err}</span> : null}
      </div>
    </div>
  );
}
