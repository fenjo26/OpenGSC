"use client";

// N11 (docs/tasks/wave-nov/N11-browser-extension.md) — Settings card for the browser
// extension: mint / rotate / revoke the extension's Bearer token (User.extToken — a separate
// credential from the MCP token, so a leaked laptop extension never costs the agent access),
// and maintain the extension-id allowlist the /api/ext CORS check reads (User.extAllowedIds).
// The token APIs live at /api/ext/token (session-guarded, manageSecrets).

import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

const label: React.CSSProperties = { fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 500 };
const hint: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)" };
const input: React.CSSProperties = {
  padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: "13px",
  fontFamily: "ui-monospace, monospace", outline: "none", width: "100%",
};
const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "13px",
  padding: "6px 12px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "transparent", color: "var(--color-text-primary)", fontWeight: 600,
};
const btnPrimary: React.CSSProperties = {
  ...btn, border: "none", background: "var(--color-accent-blue)", color: "#fff",
};

export default function ExtensionTokenCard() {
  const { t } = useLanguage();
  const [token, setToken] = useState<string | null>(null);
  const [allowedIds, setAllowedIds] = useState("");
  const [notMigrated, setNotMigrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dropped, setDropped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/ext/token")
      .then(r => r.json())
      .then(d => {
        if (d.notMigrated) setNotMigrated(true);
        else {
          setToken(d.token ?? null);
          setAllowedIds(String(d.allowedIds ?? ""));
        }
      })
      .catch(() => setError("network"))
      .finally(() => setLoading(false));
  }, []);

  if (notMigrated) {
    return (
      <div className="card" style={{ color: "var(--color-accent-orange)", fontSize: "13px" }}>
        {t("extTitle")} — npx prisma db push
      </div>
    );
  }

  const rotate = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/ext/token", { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "server_error");
      setToken(d.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true); setError(null);
    try {
      await fetch("/api/ext/token", { method: "DELETE" });
      setToken(null);
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  };

  const saveIds = async () => {
    setBusy(true); setError(null); setSaved(false); setDropped([]);
    try {
      const res = await fetch("/api/ext/token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedIds }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "server_error");
      setAllowedIds(d.allowedIds ?? "");
      setDropped(Array.isArray(d.dropped) ? d.dropped : []);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network");
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied — the token is selectable text anyway */ }
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <Puzzle size={16} color="var(--color-accent-blue)" />
        <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("extTitle")}</span>
        {busy && <Loader2 size={13} className="spin" style={{ color: "var(--color-text-tertiary)" }} />}
      </div>
      <div style={hint}>{t("extHint")}</div>

      {/* ── token ─────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <span style={label}>{t("extToken")}</span>
        {loading ? (
          <div style={{ ...hint, display: "flex", alignItems: "center", gap: "6px" }}><Loader2 size={12} className="spin" /> …</div>
        ) : token ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <code style={{ ...input, flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>{token}</code>
            <button style={btn} onClick={copyToken} title={t("mcpCopy")} aria-label={t("mcpCopy")}>
              {copied ? <Check size={13} color="var(--color-success)" /> : <Copy size={13} />}
            </button>
          </div>
        ) : (
          <div style={hint}>{t("apiKeyNotConfigured")}</div>
        )}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {token ? (
            <>
              <button style={btn} onClick={rotate} disabled={busy}>
                <RefreshCw size={13} /> {t("extTokenRegen")}
              </button>
              <button style={{ ...btn, color: "var(--color-danger)", borderColor: "var(--color-danger)" }} onClick={revoke} disabled={busy}>
                <Trash2 size={13} /> {t("extTokenRevoke")}
              </button>
            </>
          ) : (
            <button style={btnPrimary} onClick={rotate} disabled={busy}>
              {t("extTokenCreate")}
            </button>
          )}
        </div>
      </div>

      {/* ── allowed extension ids (CORS allowlist) ────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <span style={label}>{t("extIds")}</span>
        <textarea
          value={allowedIds}
          onChange={e => setAllowedIds(e.target.value)}
          rows={2}
          spellCheck={false}
          placeholder="abcdefghijklmnopabcdefghijklmnop"
          style={{ ...input, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button style={btnPrimary} onClick={saveIds} disabled={busy}>{t("apiKeySave")}</button>
          {saved && <span style={{ ...hint, color: "var(--color-success)", display: "inline-flex", alignItems: "center", gap: "4px" }}><Check size={12} /> {t("notifyChSaved")}</span>}
          {dropped.length > 0 && (
            <span style={{ ...hint, color: "var(--color-warning)" }} title={dropped.join(", ")}>
              {dropped.length} ✕
            </span>
          )}
        </div>
        {/* Additional i18n key (extIdsHint, listed in the N11 report): shows the key itself
            until R's locale pass — same convention as notifyChErr_invalid_value in T3. */}
        <div style={hint}>{t("extIdsHint" as never)}</div>
      </div>

      {/* ── install instructions ──────────────────────────────────────────────── */}
      <details style={{ fontSize: "13px" }}>
        <summary style={{ ...label, cursor: "pointer" }}>{t("extHowTo")}</summary>
        {/* Additional i18n key (extHowToSteps, listed in the N11 report). */}
        <div style={{ ...hint, marginTop: "6px", whiteSpace: "pre-line" }}>{t("extHowToSteps" as never)}</div>
      </details>

      {error && <div style={{ ...hint, color: "var(--color-danger)" }}>{error}</div>}
    </div>
  );
}
