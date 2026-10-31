"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import {
  AlertTriangle, ArrowLeftRight, Check, Copy, Crown, KeyRound, Loader2, Lock, Plus,
  RefreshCw, Shield, SlidersHorizontal, Trash2, UserX,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  deltaFor, effectiveCapabilities, toggleableFor, TUNABLE_CAPABILITIES, type Capability,
} from "@/lib/team/roles";

type Role = "viewer" | "editor" | "admin";
/** Dictionary key accepted by the t() from useLanguage (computed at compile time, erased at runtime). */
type TKey = Parameters<ReturnType<typeof useLanguage>["t"]>[0];
type Member = {
  id: string; email: string; name: string | null; role: Role; status: string;
  capabilities: { add: string[]; remove: string[] };
  invitePending: boolean; inviteExpiresAt: string | null; acceptedAt: string | null;
  lastSeenAt: string | null; canSignIn: boolean;
};

/** Display order: what a member sees first is what the owner tunes most often. */
const CAPABILITY_ORDER: readonly Capability[] = [
  "read", ...TUNABLE_CAPABILITIES, "manageAdmins", "manageSecrets", "manageInstance",
];
const OWNER_ONLY: readonly Capability[] = ["manageAdmins", "manageSecrets", "manageInstance"];
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
  const [tuning, setTuning] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<Member | null>(null);
  const [transferInput, setTransferInput] = useState("");

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
    if (!window.confirm(t("teamRemoveConfirm").replace("{email}", email))) return;
    if (await call(`/api/team/members/${encodeURIComponent(id)}`, { method: "DELETE" }, `remove-${id}`)) void load();
  }

  /**
   * One switch = one PATCH with the whole recomputed delta. The same pure functions the server
   * uses decide what the new state means, so a switch can never even display a combination the
   * fences would reject — the server re-sanitizes anyway, as every server must.
   */
  async function toggleCapability(member: Member, capability: Capability, next: boolean) {
    const current = effectiveCapabilities(member.role, member.capabilities);
    const desired = next ? [...current, capability] : current.filter(cap => cap !== capability);
    await patchMember(member.id, { capabilities: deltaFor(member.role, desired) }, `cap-${member.id}`);
  }

  async function transferTo(member: Member) {
    const body = await call("/api/team/transfer", {
      method: "POST",
      body: JSON.stringify({ membershipId: member.id, confirm: true }),
    }, "transfer");
    if (!body) return;
    setTransfer(null); setTransferInput("");
    void load();
  }

  if (loading && !data) return <div style={card}><Loader2 className="spin" size={20} /></div>;
  if (data?.notMigrated) return <div style={card}><AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("teamNotMigrated")}</div>;
  if (!data) return <div style={card}>{error || t("teamLoadFailed")}</div>;

  const canManage = data.me.capabilities.includes("manageMembers");
  const isOwner = data.me.role === "owner";
  const assignable: Role[] = isOwner ? ROLE_ORDER : ROLE_ORDER.filter(role => role !== "admin");

  return <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <div style={card}>
      <h2 style={h2}>{t("teamRolesTitle")}</h2>
      <p style={hint}>{t("teamRolesIntro")}</p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <RoleLine icon={<Crown size={13} color="#F59E0B" />} name={t("teamRoleOwner")} text={t("teamRoleOwnerText")} />
        <RoleLine icon={<Shield size={13} color="#bf5af2" />} name={t("teamRoleAdmin")} text={t("teamRoleAdminText")} warn />
        <RoleLine icon={<Check size={13} color="#34c759" />} name={t("teamRoleEditor")} text={t("teamRoleEditorText")} />
        <RoleLine icon={<Check size={13} color="#8e8e93" />} name={t("teamRoleViewer")} text={t("teamRoleViewerText")} />
      </div>
      <p style={{ ...hint, marginTop: 10 }}>{t("teamRolesTuneNote")}</p>
    </div>

    {error && <div style={{ ...card, borderColor: "rgba(255,69,58,.35)", color: "#ff6b62" }}>{t(`teamError_${error}` as TKey) !== `teamError_${error}` ? t(`teamError_${error}` as TKey) : error}</div>}

    {transfer && <div style={{ ...card, borderColor: "rgba(255,159,10,.45)" }}>
      <h2 style={h2}>{t("teamTransferTitle")}</h2>
      <p style={{ ...hint, color: "var(--color-accent-orange)" }}>{t("teamTransferIntro").replace("{email}", transfer.email)}</p>
      <label style={{ ...label, marginTop: 12 }}>{t("teamTransferType")}
        <input
          className="tool-input" value={transferInput} autoFocus
          onChange={e => setTransferInput(e.target.value)}
          placeholder={transfer.email}
          onKeyDown={e => { if (e.key === "Enter" && transferInput.trim().toLowerCase() === transfer.email && !busy) void transferTo(transfer); }}
        />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          style={{ ...primary, marginTop: 0, background: "#ff6b62" }}
          disabled={!!busy || transferInput.trim().toLowerCase() !== transfer.email}
          onClick={() => void transferTo(transfer)}
        >
          {busy === "transfer" ? <Loader2 className="spin" size={14} /> : <ArrowLeftRight size={14} />} {t("teamTransferGo")}
        </button>
        <button style={ghost} onClick={() => { setTransfer(null); setTransferInput(""); }}>{t("teamTransferCancel")}</button>
      </div>
    </div>}

    {secret && <div style={{ ...card, borderColor: "rgba(52,199,89,.35)" }}>
      <h2 style={h2}>{secret.password ? t("teamPasswordReady") : t("teamInviteReady")}</h2>
      <p style={hint}>{t("teamSecretOnce")}</p>
      <CopyRow label={t("teamEmail")} value={secret.email} />
      {secret.password && <CopyRow label={t("teamPassword")} value={secret.password} />}
      {secret.inviteToken && <CopyRow label={t("teamInviteLink")} value={`${typeof window === "undefined" ? "" : window.location.origin}/join?token=${secret.inviteToken}`} />}
      <button style={ghost} onClick={() => setSecret(null)}>{t("teamDone")}</button>
    </div>}

    {canManage && <div style={card}>
      <h2 style={h2}>{t("teamAddMember")}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginTop: 12 }}>
        <label style={label}>{t("teamEmail")}
          <input className="tool-input" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="editor@agency.com" />
        </label>
        <label style={label}>{t("teamName")}
          <input className="tool-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </label>
        <label style={label}>{t("teamRole")}
          <select className="tool-input" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as Role }))}>
            {assignable.map(role => <option key={role} value={role}>{t(`teamRole${role[0].toUpperCase()}${role.slice(1)}` as TKey)}</option>)}
          </select>
        </label>
        <label style={label}>{t("teamHowToAdd")}
          <select className="tool-input" value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value as "password" | "invite" }))}>
            <option value="password">{t("teamModePassword")}</option>
            <option value="invite">{t("teamModeInvite")}</option>
          </select>
        </label>
      </div>
      <p style={{ ...hint, marginTop: 8 }}>{t(form.role === "admin" ? "teamRoleAdminText" : form.role === "editor" ? "teamRoleEditorText" : "teamRoleViewerText")}</p>
      <p style={{ ...hint, marginTop: 4 }}>{t(form.mode === "password" ? "teamModePasswordHint" : "teamModeInviteHint")}</p>
      <button style={primary} disabled={!form.email.trim() || !!busy} onClick={addMember}>
        {busy === "add" ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} {t("teamAdd")}
      </button>
    </div>}

    <MyPassword me={data.me} t={t as (k: string) => string} />

    <div style={{ ...card, padding: 0 }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ ...h2, margin: 0 }}>{t("teamMembers")} · {data.members.length + 1}</h2>
        <button style={ghost} onClick={() => void load()}><RefreshCw size={13} /> {t("teamRefresh")}</button>
      </div>

      <Row
        title={data.owner?.name || data.owner?.email || "—"}
        subtitle={data.owner?.email || ""}
        badge={<span style={badge("#F59E0B")}><Crown size={11} /> {t("teamRoleOwner")}</span>}
        note={t("teamOwnerNote")}
      />

      {data.members.map(member => <Fragment key={member.id}>
        <Row
          title={member.name || member.email}
          subtitle={member.email}
          badge={<span style={badge(member.role === "admin" ? "#bf5af2" : member.role === "editor" ? "#34c759" : "#8e8e93")}>
            {t(`teamRole${member.role[0].toUpperCase()}${member.role.slice(1)}` as TKey)}
          </span>}
          note={member.invitePending ? t("teamInvitePending") : member.status === "suspended" ? t("teamSuspended")
            : member.lastSeenAt ? `${t("teamLastSeen")}: ${new Date(member.lastSeenAt).toLocaleString()}` : t("teamNeverSignedIn")}
          actions={canManage && (member.role !== "admin" || isOwner) ? <>
            <select
              className="tool-input" style={{ width: "auto" }} value={member.role} disabled={!!busy}
              onChange={e => patchMember(member.id, { role: e.target.value }, `role-${member.id}`)}
            >
              {assignable.map(role => <option key={role} value={role}>{t(`teamRole${role[0].toUpperCase()}${role.slice(1)}` as TKey)}</option>)}
            </select>
            <button style={ghost} disabled={!!busy} title={t("teamResetPassword")}
              onClick={() => patchMember(member.id, { action: "reset_password" }, `pw-${member.id}`)}>
              <KeyRound size={13} />
            </button>
            <button style={ghost} disabled={!!busy} title={t(member.status === "suspended" ? "teamReactivate" : "teamSuspend")}
              onClick={() => patchMember(member.id, { status: member.status === "suspended" ? "active" : "suspended" }, `st-${member.id}`)}>
              <UserX size={13} />
            </button>
            <button style={{ ...ghost, color: "#ff6b62" }} disabled={!!busy} title={t("teamRemove")}
              onClick={() => removeMember(member.id, member.email)}>
              <Trash2 size={13} />
            </button>
          </> : null}
          ownerActions={isOwner ? <>
            <button
              style={tuning === member.id ? { ...ghost, borderColor: "var(--color-accent-blue)", color: "var(--color-accent-blue)" } : ghost}
              disabled={!!busy} title={t("teamTune")}
              onClick={() => setTuning(tuning === member.id ? null : member.id)}
            >
              <SlidersHorizontal size={13} />
            </button>
            {member.role === "admin" && member.status === "active" && !member.invitePending &&
              <button style={{ ...ghost, color: "#F59E0B" }} disabled={!!busy} title={t("teamTransfer")}
                onClick={() => { setTransfer(member); setTransferInput(""); }}>
                <ArrowLeftRight size={13} />
              </button>}
          </> : null}
        />
        {tuning === member.id && <CapabilityEditor
          member={member} busy={!!busy}
          onToggle={(capability, next) => void toggleCapability(member, capability, next)}
          onReset={() => void patchMember(member.id, { capabilities: null }, `cap-${member.id}`)}
          t={t as (k: string) => string}
        />}
      </Fragment>)}
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
function MyPassword({ me, t }: { me: Me; t: (k: string) => string }) {
  const hasPassword = me.hasPassword !== false;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      await signOut({ callbackUrl: "/login" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "password_change_failed"); }
    finally { setBusy(false); }
  }

  return <div style={{ ...card, ...(hasPassword ? {} : { borderColor: "rgba(255,159,10,.4)" }) }}>
    <h2 style={h2}>{hasPassword ? t("myPasswordTitle") : t("myPasswordSetTitle")}</h2>
    <p style={hint}>{hasPassword ? t("myPasswordHint") : t("myPasswordSetHint")}</p>
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

function Row({ title, subtitle, badge, note, actions, ownerActions }: {
  title: string; subtitle: string; badge: React.ReactNode; note?: string; actions?: React.ReactNode;
  ownerActions?: React.ReactNode;
}) {
  return <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: "1px solid var(--color-border)", flexWrap: "wrap" }}>
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ fontSize: 14, fontWeight: 650, color: "var(--color-text-primary)" }}>{title}</div>
      <div className="privacy-sensitive" style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{subtitle}</div>
      {note && <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>{note}</div>}
    </div>
    {badge}
    {actions && <div style={{ display: "flex", gap: 6, alignItems: "center" }}>{actions}</div>}
    {ownerActions && <div style={{ display: "flex", gap: 6, alignItems: "center" }}>{ownerActions}</div>}
  </div>;
}

/**
 * The per-member permission editor (issue #39): one row per capability, a switch where the fences
 * allow a change, a lock and a reason where they do not. The state shown is the same effective
 * capabilities the server enforces, computed by the same pure functions — there is no second
 * permission list here to drift out of sync.
 */
function CapabilityEditor({ member, busy, onToggle, onReset, t }: {
  member: Member; busy: boolean;
  onToggle: (capability: Capability, next: boolean) => void;
  onReset: () => void;
  t: (k: string) => string;
}) {
  const effective = effectiveCapabilities(member.role, member.capabilities);
  const hasOverride = member.capabilities.add.length > 0 || member.capabilities.remove.length > 0;
  return <div style={{ padding: "12px 20px 16px", borderBottom: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
    <div style={{ ...hint, marginBottom: 8 }}>
      <b style={{ color: "var(--color-text-primary)" }}>{t("teamTuneTitle")} — {member.email}</b>
      <br />
      {t("teamTuneIntro")}
    </div>
    <div style={{ display: "grid", gap: 4 }}>
      {CAPABILITY_ORDER.map(capability => {
        const has = effective.includes(capability);
        const canToggle = toggleableFor(member.role, capability, has);
        const lockedReason = capability === "read" ? t("teamCapAlways")
          : OWNER_ONLY.includes(capability) ? t("teamCapOwnerOnly")
          : t("teamCapFixed");
        return <div key={capability} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "3px 0" }}>
          <input
            type="checkbox" checked={has} disabled={busy || !canToggle}
            onChange={e => onToggle(capability, e.target.checked)}
            style={{ width: 15, height: 15, accentColor: "var(--color-accent-blue)", cursor: canToggle ? "pointer" : "not-allowed", flexShrink: 0 }}
          />
          <span style={{ minWidth: 150, fontWeight: 600, color: "var(--color-text-primary)" }}>{t(`teamCap_${capability}`)}</span>
          <span style={{ flex: 1, color: "var(--color-text-secondary)" }}>{t(`teamCapDesc_${capability}`)}</span>
          {!canToggle && <span title={lockedReason} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--color-text-tertiary)", fontSize: 11 }}>
            <Lock size={11} /> {lockedReason}
          </span>}
        </div>;
      })}
    </div>
    <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
      <button style={ghost} disabled={busy || !hasOverride} onClick={onReset}>{t("teamTuneReset")}</button>
      {hasOverride && <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{t("teamTuneCustomized")}</span>}
    </div>
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
