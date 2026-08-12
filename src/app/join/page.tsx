"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

/**
 * Accepting an invitation — the one authenticated-looking screen a person reaches without an
 * account. The token in the URL is single-use and expires; everything else about the workspace
 * stays invisible until it has been redeemed.
 */
function JoinForm() {
  const { t } = useLanguage();
  const token = useSearchParams().get("token") ?? "";
  const [form, setForm] = useState({ name: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit() {
    if (form.password !== form.confirm) { setError("password_mismatch"); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/team/accept", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: form.name, password: form.password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "invite_accept_failed");
      setDone(true);
      await signIn("credentials", { email: body.email, password: form.password, callbackUrl: "/" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "invite_accept_failed"); }
    finally { setBusy(false); }
  }

  if (!token) return <p style={hint}>{t("joinNoToken" as any)}</p>;
  if (done) return <p style={{ ...hint, color: "var(--color-accent-green)" }}><CheckCircle2 size={15} /> {t("joinDone" as any)}</p>;

  return <>
    <label style={label}>{t("teamName" as any)}
      <input className="tool-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoComplete="name" />
    </label>
    <label style={label}>{t("joinPassword" as any)}
      <input className="tool-input" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} autoComplete="new-password" />
    </label>
    <label style={label}>{t("joinConfirm" as any)}
      <input className="tool-input" type="password" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} autoComplete="new-password" />
    </label>
    <p style={hint}>{t("joinPasswordHint" as any)}</p>
    {error && <p style={{ ...hint, color: "var(--color-accent-red)" }}>{t(`teamError_${error}` as any) !== `teamError_${error}` ? t(`teamError_${error}` as any) : t("joinFailed" as any)}</p>}
    <button style={primary} disabled={busy || form.password.length < 12} onClick={submit}>
      {busy ? <Loader2 className="spin" size={15} /> : <ShieldCheck size={15} />} {t("joinSubmit" as any)}
    </button>
  </>;
}

export default function JoinPage() {
  return <div style={{ minHeight: "100vh", background: "var(--color-bg)", display: "grid", placeItems: "center", padding: 20 }}>
    <div style={{ width: "min(420px,100%)", background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 14, padding: 26, display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 style={{ fontSize: 20, margin: 0, color: "var(--color-text-primary)" }}>OpenGSC</h1>
      <Suspense fallback={<Loader2 className="spin" size={18} />}><JoinForm /></Suspense>
    </div>
  </div>;
}

const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 12, fontWeight: 650, color: "var(--color-text-secondary)" };
const hint: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: "var(--color-text-secondary)", margin: 0, display: "flex", gap: 6, alignItems: "center" };
const primary: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px 16px", borderRadius: 9, border: 0, background: "var(--color-accent-blue)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" };
