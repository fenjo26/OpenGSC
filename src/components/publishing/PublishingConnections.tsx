"use client";

// Connections for one site: cards with honest status (unverified until checked, error with
// the real message), masked credentials, Verify / Delete — and the ADD form always visible.
// P1 has no import/OAuth path, so manual entry is not just the only path, it is rendered
// unconditionally rather than hiding behind a "+ New" toggle (house rule).

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { PLATFORMS, platformDefById } from "@/lib/publish/platforms";
import { StatusChip } from "./PublishDialog";

interface ConnectionRow {
  id: string; platform: string; label: string; siteIdentifier: string; status: string;
  lastError: string; lastVerifiedAt: string | null; credentialPreview: Record<string, string>;
}

export default function PublishingConnections({ siteId, onChanged }: { siteId: string; onChanged?: () => void }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<ConnectionRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Add form — plain text inputs for every declared credential field; the route keeps only
  // the fields the platform actually declares.
  const [platform, setPlatform] = useState(PLATFORMS[0]?.id ?? "wordpress");
  const [label, setLabel] = useState("");
  const [siteIdentifier, setSiteIdentifier] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const fields = platformDefById(platform)?.fields ?? [];

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/publishing/connections?siteId=${encodeURIComponent(siteId)}`, { cache: "no-store" }).then(r => r.json());
      setRows((d?.connections ?? []) as ConnectionRow[]);
    } catch { setRows([]); }
  }, [siteId]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    const id = setTimeout(async () => { if (alive) await load(); }, 0);
    return () => { alive = false; clearTimeout(id); };
  }, [load]);

  async function add() {
    setError(""); setAdding(true);
    try {
      const res = await fetch("/api/publishing/connections", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, platform, label, siteIdentifier, credentials: creds }),
      });
      const d = await res.json();
      if (!res.ok) { setError(String(d?.error ?? "failed")); setAdding(false); return; }
      // Verify right away: the operator just typed the credentials, an honest ok/error beats
      // a saved row whose status is a guess. Failures keep the row (unverified is a state).
      await fetch("/api/publishing/connections/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d?.connection?.id }),
      });
      setLabel(""); setSiteIdentifier(""); setCreds({});
      await load();
      onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setAdding(false);
  }

  async function verify(id: string) {
    setBusy(id); setError("");
    try {
      const res = await fetch("/api/publishing/connections/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await res.json();
      if (!res.ok) setError(String(d?.error ?? "failed"));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  }

  async function remove(id: string) {
    setBusy(id); setError("");
    try {
      const res = await fetch("/api/publishing/connections", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) { const d = await res.json(); setError(String(d?.error ?? "failed")); }
      await load();
      onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  }

  return (
    <div className="panel">
      <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 14px" }}>{t("publishConnections")}</h3>

      {rows === null && <div style={{ padding: "16px 0", color: "var(--color-text-tertiary)" }}><Loader2 size={16} className="spin" /></div>}
      {rows !== null && rows.length === 0 && (
        <div style={{ padding: "10px 0 16px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("publishNoConnections")}</div>
      )}
      {rows?.map(c => {
        const def = platformDefById(c.platform);
        return (
          <div key={c.id} style={{ display: "flex", alignItems: "flex-start", gap: "12px", padding: "14px 4px", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{c.label}</span>
                <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "6px", background: "var(--color-bg)", color: "var(--color-text-secondary)" }}>{def?.name ?? c.platform}</span>
                <StatusChip status={c.status} />
              </div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px", wordBreak: "break-all" }}>
                {c.siteIdentifier}
                {Object.entries(c.credentialPreview).map(([k, v]) => v ? ` · ${k}: ${v}` : "").join("")}
              </div>
              {/* The real error, verbatim — a connection that fails verification says why. */}
              {c.status === "error" && c.lastError && (
                <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginTop: "5px", wordBreak: "break-word" }}>{c.lastError}</div>
              )}
            </div>
            <button onClick={() => verify(c.id)} disabled={busy === c.id} title={t("publishVerify")} style={btnGhost}>
              {busy === c.id ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} {t("publishVerify")}
            </button>
            <button onClick={() => remove(c.id)} disabled={busy === c.id} title={t("publishDeleteConnection")} style={{ ...btnGhost, color: "var(--color-accent-red)" }}>
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}

      {/* Add — always visible; manual entry is the only path in P1. */}
      <div style={{ marginTop: "18px", padding: "16px", border: "1px dashed var(--color-border)", borderRadius: "10px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("publishNewConnection")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <div>
            <div style={miniLabel}>{t("publishPlatform")}</div>
            <select className="tool-input" value={platform} onChange={e => { setPlatform(e.target.value); setCreds({}); }}>
              {PLATFORMS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <div style={miniLabel}>{t("publishLabel")}</div>
            <input className="tool-input" value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <div style={miniLabel}>{t(platformDefById(platform)?.siteIdentifierLabelKey ?? "publishSiteIdentifier")}</div>
            <input className="tool-input" value={siteIdentifier} onChange={e => setSiteIdentifier(e.target.value)} placeholder="https://example.com" />
          </div>
          {fields.map(f => (
            <div key={f.key} style={{ gridColumn: "1 / -1" }}>
              <div style={miniLabel}>{t(f.labelKey as never)}</div>
              <input
                className="tool-input"
                type={f.secret ? "password" : "text"}
                value={creds[f.key] ?? ""}
                onChange={e => setCreds(prev => ({ ...prev, [f.key]: e.target.value }))}
                autoComplete="off"
              />
            </div>
          ))}
        </div>
        {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={add} disabled={adding} style={btnPrimary}>
            {adding ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {t("publishNewConnection")}
          </button>
        </div>
      </div>
    </div>
  );
}

const miniLabel: React.CSSProperties = { fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: "4px" };
const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "7px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", flexShrink: 0 };
const btnPrimary: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "8px 16px", borderRadius: "8px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };
