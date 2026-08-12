"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Check, Copy, Crown, KeyRound, Loader2, Plus, RefreshCw, Shield, Trash2, UserX,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

type Role = "viewer" | "editor" | "admin";
type Member = {
  id: string; email: string; name: string | null; role: Role; status: string;
  invitePending: boolean; inviteExpiresAt: string | null; acceptedAt: string | null;
  lastSeenAt: string | null; canSignIn: boolean;
};
type Me = { id: string; email: string; role: Role | "owner"; capabilities: string[]; mustChangePassword: boolean; hasPassword?: boolean };
type Data = {
  notMigrated?: boolean;
  workspaceName?: string;
  owner: { id: string; email: string | null; name: string | null; image: string | null } | null;
  members: Member[];
  me: Me;
};

const ROLE_ORDER: Role[] = ["viewer", "editor", "admin"];

/**
 * The members screen, and the one place in the app where a role is chosen. The role reference sits
 * on this screen on purpose: the decision is made here, and nobody should have to open the docs to
 * find out what they are about to grant — especially the part where admins can spend money.
 */
export default function TeamMembersPanel() {
  const { t } = useLanguage();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({ email: "", name: "", role: "viewer" as Role, mode: "password" as "password" | "invite" });
  const [secret, setSecret] = useState<{ email: string; password?: string | null; inviteToken?: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/team", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "request_failed");
      setData(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "request_failed"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function call(url: string, init: RequestInit, key: string) {
    setBusy(key); setError("");
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "request_failed");
      return body;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "request_failed");
      return null;
    } finally { setBusy(""); }
  }

  async function addMember() {
    const body = await call("/api/team/members", { method: "POST", body: JSON.stringify(form) }, "add");
    if (!body) return;
    setSecret({ email: form.email, password: body.password, inviteToken: body.inviteToken });
    setForm({ email: "", name: "", role: "viewer", mode: form.mode });
    void load();
  }
  async function patchMember(id: string, patch: Record<string, unknown>, key: string) {
    const body = await call(`/api/team/members/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, key);
    if (!body) return;
    if (body.password) setSecret({ email: data?.members.find(m => m.id === id)?.email ?? "", password: body.password });
    void load();
  }
  async function removeMember(id: string, email: string) {
    if (!window.confirm(t("teamRemoveConfirm" as any).replace("{email}", email))) return;
    if (await call(`/api/team/members/${encodeURIComponent(id)}`, { method: "DELETE" }, `remove-${id}`)) void load();
  }

  if (loading && !data) return <div style={card}><Loader2 className="spin" size={20} /></div>;
  if (data?.notMigrated) return <div style={card}><AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("teamNotMigrated" as any)}</div>;
  if (!data) return <div style={card}>{error || t("teamLoadFailed" as any)}</div>;

  const canManage = data.me.capabilities.includes("manageMembers");
  const isOwner = data.me.role === "owner";
  const assignable: Role[] = isOwner ? ROLE_ORDER : ROLE_ORDER.filter(role => role !== "admin");

  return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <div style={card}>
      <h2 style={h2}>{t("teamRolesTitle" as any)}</h2>
      <p style={hint}>{t("teamRolesIntro" as any)}</p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <RoleLine icon={<Crown size={13} color="#F59E0B" />} name={t("teamRoleOwner" as any)} text={t("teamRoleOwnerText" as any)} />
        <RoleLine icon={<Shield size={13} color="#bf5af2" />} name={t("teamRoleAdmin" as any)} text={t("teamRoleAdminText" as any)} warn />
        <RoleLine icon={<Check size={13} color="#34c759" />} name={t("teamRoleEditor" as any)} text={t("teamRoleEditorText" as any)} />
        <RoleLine icon={<Check size={13} color="#8e8e93" />} name={t("teamRoleViewer" as any)} text={t("teamRoleViewerText" as any)} />
      </div>
    </div>

    {error && <div style={{ ...card, borderColor: "rgba(255,69,58,.35)", color: "#ff6b62" }}>{t(`teamError_${error}` as any) !== `teamError_${error}` ? t(`teamError_${error}` as any) : error}</div>}

    {secret && <div style={{ ...card, borderColor: "rgba(52,199,89,.35)" }}>
      <h2 style={h2}>{secret.password ? t("teamPasswordReady" as any) : t("teamInviteReady" as any)}</h2>
      <p style={hint}>{t("teamSecretOnce" as any)}</p>
      <CopyRow label={t("teamEmail" as any)} value={secret.email} />
      {secret.password && <CopyRow label={t("teamPassword" as any)} value={secret.password} />}
      {secret.inviteToken && <CopyRow label={t("teamInviteLink" as any)} value={`${typeof window === "undefined" ? "" : window.location.origin}/join?token=${secret.inviteToken}`} />}
      <button style={ghost} onClick={() => setSecret(null)}>{t("teamDone" as any)}</button>
    </div>}

    {canManage && <div style={card}>
      <h2 style={h2}>{t("teamAddMember" as any)}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginTop: 12 }}>
        <label style={label}>{t("teamEmail" as any)}
          <input className="tool-input" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="editor@agency.com" />
        </label>
        <label style={label}>{t("teamName" as any)}
          <input className="tool-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </label>
        <label style={label}>{t("teamRole" as any)}
          <select className="tool-input" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as Role }))}>
            {assignable.map(role => <option key={role} value={role}>{t(`teamRole${role[0].toUpperCase()}${role.slice(1)}` as any)}</option>)}
          </select>
        </label>
        <label style={label}>{t("teamHowToAdd" as any)}
          <select className="tool-input" value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value as "password" | "invite" }))}>
            <option value="password">{t("teamModePassword" as any)}</option>
            <option value="invite">{t("teamModeInvite" as any)}</option>
          </select>
        </label>
      </div>
      <p style={{ ...hint, marginTop: 8 }}>{t(form.role === "admin" ? "teamRoleAdminText" : form.role === "editor" ? "teamRoleEditorText" : "teamRoleViewerText" as any)}</p>
      <p style={{ ...hint, marginTop: 4 }}>{t(form.mode === "password" ? "teamModePasswordHint" : "teamModeInviteHint" as any)}</p>
      <button style={primary} disabled={!form.email.trim() || !!busy} onClick={addMember}>
        {busy === "add" ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} {t("teamAdd" as any)}
      </button>
    </div>}

    <MyPassword me={data.me} t={t as (k: string) => string} onSaved={() => void load()} />

    <div style={{ ...card, padding: 0 }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ ...h2, margin: 0 }}>{t("teamMembers" as any)} · {data.members.length + 1}</h2>
        <button style={ghost} onClick={() => void load()}><RefreshCw size={13} /> {t("teamRefresh" as any)}</button>
      </div>

      <Row
        title={data.owner?.name || data.owner?.email || "—"}
        subtitle={data.owner?.email || ""}
        badge={<span style={badge("#F59E0B")}><Crown size={11} /> {t("teamRoleOwner" as any)}</span>}
        note={t("teamOwnerNote" as any)}
      />

      {data.members.map(member => <Row
        key={member.id}
        title={member.name || member.email}
        subtitle={member.email}
        badge={<span style={badge(member.role === "admin" ? "#bf5af2" : member.role === "editor" ? "#34c759" : "#8e8e93")}>
          {t(`teamRole${member.role[0].toUpperCase()}${member.role.slice(1)}` as any)}
        </span>}
        note={member.invitePending ? t("teamInvitePending" as any) : member.status === "suspended" ? t("teamSuspended" as any)
          : member.lastSeenAt ? `${t("teamLastSeen" as any)}: ${new Date(member.lastSeenAt).toLocaleString()}` : t("teamNeverSignedIn" as any)}
        actions={canManage && (member.role !== "admin" || isOwner) ? <>
          <select
            className="tool-input" style={{ width: "auto" }} value={member.role} disabled={!!busy}
            onChange={e => patchMember(member.id, { role: e.target.value }, `role-${member.id}`)}
          >
            {assignable.map(role => <option key={role} value={role}>{t(`teamRole${role[0].toUpperCase()}${role.slice(1)}` as any)}</option>)}
          </select>
          <button style={ghost} disabled={!!busy} title={t("teamResetPassword" as any)}
            onClick={() => patchMember(member.id, { action: "reset_password" }, `pw-${member.id}`)}>
            <KeyRound size={13} />
          </button>
          <button style={ghost} disabled={!!busy} title={t(member.status === "suspended" ? "teamReactivate" : "teamSuspend" as any)}
            onClick={() => patchMember(member.id, { status: member.status === "suspended" ? "active" : "suspended" }, `st-${member.id}`)}>
            <UserX size={13} />
          </button>
          <button style={{ ...ghost, color: "#ff6b62" }} disabled={!!busy} title={t("teamRemove" as any)}
            onClick={() => removeMember(member.id, member.email)}>
            <Trash2 size={13} />
          </button>
        </> : null}
      />)}
    </div>
  </div>;
}

/**
 * Your own password.
 *
 * For an owner who has only ever used Google this is the switch that ends Google as a login: while
 * they have no password it is the only way in and stays permitted, and the moment one exists Google
 * goes back to being a data connection. The prompt says that plainly rather than hiding a security
 * change behind a settings row.
 */
function MyPassword({ me, t, onSaved }: { me: Me; t: (k: string) => string; onSaved: () => void }) {
  const hasPassword = me.hasPassword !== false;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

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
      setDone(true); setOpen(false); setForm({ currentPassword: "", newPassword: "", confirm: "" }); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "password_change_failed"); }
    finally { setBusy(false); }
  }

  return <div style={{ ...card, ...(hasPassword ? {} : { borderColor: "rgba(255,159,10,.4)" }) }}>
    <h2 style={h2}>{hasPassword ? t("myPasswordTitle") : t("myPasswordSetTitle")}</h2>
    <p style={hint}>{hasPassword ? t("myPasswordHint") : t("myPasswordSetHint")}</p>
    {done && <p style={{ ...hint, color: "var(--color-accent-green)", marginTop: 6 }}>{t("myPasswordSaved")}</p>}
    {!open
      ? <button style={{ ...ghost, marginTop: 10 }} onClick={() => setOpen(true)}><KeyRound size={13} /> {hasPassword ? t("myPasswordChange") : t("myPasswordSet")}</button>
      : <form onSubmit={submit} style={{ display: "grid", gap: 8, maxWidth: 360, marginTop: 12 }}>
          {hasPassword && <input className="tool-input" type="password" required autoComplete="current-password" placeholder={t("passwordChangeCurrent")}
            value={form.currentPassword} onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))} />}
          <input className="tool-input" type="password" required autoComplete="new-password" placeholder={t("passwordChangeNew")}
            value={form.newPassword} onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))} />
          <input className="tool-input" type="password" required autoComplete="new-password" placeholder={t("joinConfirm")}
            value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />
          {error && <span style={{ fontSize: 12, color: "var(--color-accent-red)" }}>
            {t(`teamError_${error}`) !== `teamError_${error}` ? t(`teamError_${error}`) : t("passwordChangeFailed")}
          </span>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" style={primary} disabled={busy || form.newPassword.length < 12}>
              {busy ? <Loader2 className="spin" size={14} /> : null} {t("passwordChangeSubmit")}
            </button>
            <button type="button" style={{ ...ghost, marginTop: 12 }} onClick={() => { setOpen(false); setError(""); }}>{t("teamDone")}</button>
          </div>
        </form>}
  </div>;
}

function Row({ title, subtitle, badge, note, actions }: {
  title: string; subtitle: string; badge: React.ReactNode; note?: string; actions?: React.ReactNode;
}) {
  return <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: "1px solid var(--color-border)", flexWrap: "wrap" }}>
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 14, fontWeight: 650, color: "var(--color-text-primary)" }}>{title}</div>
      <div className="privacy-sensitive" style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{subtitle}</div>
      {note && <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>{note}</div>}
    </div>
    {badge}
    {actions && <div style={{ display: "flex", gap: 6, alignItems: "center" }}>{actions}</div>}
  </div>;
}

function RoleLine({ icon, name, text, warn }: { icon: React.ReactNode; name: string; text: string; warn?: boolean }) {
  return <div style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12, lineHeight: 1.5 }}>
    <span style={{ marginTop: 2 }}>{icon}</span>
    <span><b style={{ color: "var(--color-text-primary)" }}>{name}</b>{" — "}
      <span style={{ color: warn ? "var(--color-accent-orange)" : "var(--color-text-secondary)" }}>{text}</span>
    </span>
  </div>;
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
    <span style={{ fontSize: 11, color: "var(--color-text-secondary)", minWidth: 90 }}>{label}</span>
    <code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: 12, padding: "6px 9px", borderRadius: 7, background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>{value}</code>
    <button style={ghost} onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? <Check size={13} color="#34c759" /> : <Copy size={13} />}
    </button>
  </div>;
}

const card: React.CSSProperties = { background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 24 };
const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px" };
const hint: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: "var(--color-text-secondary)", margin: 0 };
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 11, fontWeight: 650, color: "var(--color-text-secondary)" };
const primary: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, marginTop: 12, padding: "8px 14px", borderRadius: 8, border: 0, background: "var(--color-accent-blue)", color: "#fff", fontSize: 13, fontWeight: 650, cursor: "pointer" };
const ghost: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer" };
const badge = (color: string): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, background: `${color}1a`, border: `1px solid ${color}33`, color, fontSize: 12, fontWeight: 600 });
