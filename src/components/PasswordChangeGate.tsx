"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

const DISMISS_KEY = "opengsc.passwordNoticeDismissed";

/**
 * Two different prompts about passwords, deliberately not the same prompt.
 *
 * A member signed in with a password their admin chose is *blocked* until they replace it: until
 * they do, someone else holds a working credential for their account, and "who did this" has no
 * answer. That is a security state, not a suggestion.
 *
 * An owner who has only ever used Google is *asked* once. Nothing is wrong with their account —
 * Google sign-in keeps working for them — but a dashboard that cannot let its own owner in without
 * a third party is one outage away from being unusable. Asking once and never again is the right
 * weight for that, and the notice disappears for good the moment a password exists.
 */
export default function PasswordChangeGate() {
  const { t } = useLanguage();
  const [state, setState] = useState<"none" | "forced" | "suggested">("none");
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/team", { cache: "no-store" })
      .then(res => (res.ok ? res.json() : null))
      .then(body => {
        if (cancelled || !body?.me) return;
        if (body.me.mustChangePassword) { setState("forced"); return; }
        const dismissed = typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1";
        // Only the owner sees the suggestion: a member always has a password by definition.
        if (body.me.hasPassword === false && body.me.role === "owner" && !dismissed) setState("suggested");
      })
      .catch(() => { /* signed out, or the members table is not migrated yet */ });
    return () => { cancelled = true; };
  }, []);

  if (state === "none") return null;
  const forced = state === "forced";
  const command = `npm run set-password -- --email ${typeof window === "undefined" ? "you@example.com" : ""}`.trim();

  function dismiss() {
    // Remembered locally, and moot anyway once a password exists: the server stops reporting
    // hasPassword:false and this component never asks again on any device.
    try { window.localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
    setState("none");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (form.newPassword !== form.confirm) { setError("password_mismatch"); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/team/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "password_change_failed");
      try { window.localStorage.removeItem(DISMISS_KEY); } catch { /* private mode */ }
      setState("none");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "password_change_failed"); }
    finally { setBusy(false); }
  }

  return <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", padding: 20 }}>
    <form onSubmit={submit} style={{ width: "min(430px,100%)", background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 14, padding: 24, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <KeyRound size={16} color="var(--color-text-primary)" />
        <h2 style={{ flex: 1, fontSize: 16, margin: 0, color: "var(--color-text-primary)" }}>
          {t((forced ? "passwordChangeTitle" : "passwordSuggestTitle") as any)}
        </h2>
        {!forced && <button type="button" onClick={dismiss} aria-label="close"
          style={{ background: "transparent", border: 0, color: "var(--color-text-tertiary)", cursor: "pointer", padding: 2 }}>
          <X size={16} />
        </button>}
      </div>

      <p style={{ fontSize: 12, lineHeight: 1.55, color: "var(--color-text-secondary)", margin: 0 }}>
        {t((forced ? "passwordChangeHint" : "passwordSuggestHint") as any)}
      </p>

      {forced && <input className="tool-input" type="password" required autoComplete="current-password" placeholder={t("passwordChangeCurrent" as any)}
        value={form.currentPassword} onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))} />}
      <input className="tool-input" type="password" required autoComplete="new-password" placeholder={t("passwordChangeNew" as any)}
        value={form.newPassword} onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))} />
      <input className="tool-input" type="password" required autoComplete="new-password" placeholder={t("joinConfirm" as any)}
        value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />

      {error && <span style={{ fontSize: 12, color: "var(--color-accent-red)" }}>
        {t(`teamError_${error}` as any) !== `teamError_${error}` ? t(`teamError_${error}` as any) : t("passwordChangeFailed" as any)}
      </span>}

      <button type="submit" disabled={busy || form.newPassword.length < 12}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "10px 14px", borderRadius: 9, border: 0, background: "var(--color-accent-blue)", color: "#fff", fontSize: 14, fontWeight: 650, cursor: "pointer" }}>
        {busy ? <Loader2 className="spin" size={15} /> : null} {t("passwordChangeSubmit" as any)}
      </button>

      {!forced && <>
        <button type="button" onClick={dismiss}
          style={{ background: "transparent", border: 0, color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer" }}>
          {t("passwordSuggestLater" as any)}
        </button>
        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 10 }}>
          <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--color-text-tertiary)", margin: "0 0 6px" }}>{t("passwordSuggestSsh" as any)}</p>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: 11, padding: "6px 8px", borderRadius: 7, background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
              {command} you@example.com
            </code>
            <button type="button" onClick={() => { navigator.clipboard?.writeText(`${command} you@example.com`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              style={{ display: "inline-flex", padding: 7, borderRadius: 7, border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", cursor: "pointer" }}>
              {copied ? <Check size={13} color="#34c759" /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      </>}
    </form>
  </div>;
}
