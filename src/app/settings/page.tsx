"use client";

import { useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import {
  ArrowLeft, Plus, X, CheckCircle, AlertCircle,
  Users, Settings, Globe, Key, KeyRound, Edit2, Copy,
  ChevronDown, Crown, Zap, Star, Eye, Sparkles, BarChart3,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import TeamMembersPanel from "@/components/TeamMembersPanel";
import SeoToolsSettings, { SeoProviderKeysSection, AeoProviderKeysSection } from "@/components/SeoToolsSettings";
import MetricsSettingsSection from "@/components/MetricsSettingsSection";

type NavItem = "accounts" | "bing" | "yandex" | "teams" | "api" | "api-keys" | "indexing-api" | "metrics" | "seo-tools" | "notifications" | "members" | "preferences" | "supersites";

// These screens predate a real organization/member authorization model. Keep them available to
// contributors who are working on that RFC, but do not present client-only mock state as a
// production feature. Existing installations can opt back in without a database migration.
const EXPERIMENTAL_TEAM_UI = process.env.NEXT_PUBLIC_EXPERIMENTAL_TEAM_UI === "1";

interface ConnectedAccount {
  id: string; email: string; picture: string | null; connected: boolean; gscAccess: boolean; ga4Access?: boolean;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────
function UserAvatar({ email, picture, size = 36 }: { email: string; picture?: string | null; size?: number }) {
  const colors = ["#8B5CF6","#3B82F6","#10B981","#F59E0B","#EF4444","#06B6D4"];
  const color = colors[email.charCodeAt(0) % colors.length];
  if (picture) return <img src={picture} alt={email} width={size} height={size} style={{ borderRadius: "50%", flexShrink: 0 }} />;
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
      {email[0].toUpperCase()}
    </div>
  );
}

// Generic browser-side key field (seoKey_* convention, synced via SeoKeysSync)
function LocalKeyField({ storageKey, placeholder }: { storageKey: string; placeholder: string }) {
  const [val, setVal] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setVal(localStorage.getItem(storageKey) || ""); }, [storageKey]);
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      <input
        type="password" value={val} onChange={e => { setVal(e.target.value); setSaved(false); }}
        placeholder={placeholder}
        style={{ width: "260px", padding: "8px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none" }}
      />
      <button onClick={() => { val.trim() ? localStorage.setItem(storageKey, val.trim()) : localStorage.removeItem(storageKey); setSaved(true); }}
        style={{ padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: saved ? "rgba(52,199,89,0.12)" : "var(--color-bg)", color: saved ? "var(--color-accent-green)" : "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
        {saved ? "✓" : "Save"}
      </button>
    </div>
  );
}

interface SearchEngineAccount {
  id: string;
  name: string;
  key: string;
}

// Collapsible step-by-step setup guide, shown above the Bing/Yandex account managers.
function EngineHowTo({ color, steps, note, docHref, linkHref, linkLabel }: { color: string; steps: string[]; note?: string; docHref: string; linkHref: string; linkLabel: string }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: `1px solid ${color}30`, background: `${color}0d`, borderRadius: "10px", overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", alignItems: "center", gap: "8px", padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 600 }}>
        <span style={{ color }}>💡</span> {t("seHowToTitle")}
        <span style={{ flex: 1 }} />
        <ChevronDown size={15} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", color: "var(--color-text-secondary)" }} />
      </button>
      {open && (
        <div style={{ padding: "0 16px 14px 16px" }}>
          <ol style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {note && <div style={{ marginTop: "8px", fontSize: "12px", color: "#f59e0b", fontWeight: 600 }}>⚠️ {note}</div>}
          <div style={{ marginTop: "10px", display: "flex", gap: "14px", flexWrap: "wrap" }}>
            <a href={linkHref} target="_blank" rel="noreferrer" style={{ fontSize: "12px", color: "var(--color-accent-blue)", fontWeight: 600 }}>{linkLabel} ↗</a>
            <a href={docHref} target="_blank" rel="noreferrer" style={{ fontSize: "12px", color: "var(--color-accent-blue)", fontWeight: 600 }}>{t("seSetupGuide")} ↗</a>
          </div>
        </div>
      )}
    </div>
  );
}

function BingAccountsManager() {
  const { t } = useLanguage();
  const [accounts, setAccounts] = useState<SearchEngineAccount[]>([]);
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    try {
      setAccounts(JSON.parse(localStorage.getItem("seoKey_bing_accounts_list") || "[]"));
    } catch (e) {
      setAccounts([]);
    }
  }, []);

  const addAccount = () => {
    if (!newKey.trim()) return;
    const name = newName.trim() || `Bing ${accounts.length + 1}`;
    const newList = [...accounts, { id: Math.random().toString(36).slice(2, 9), name, key: newKey.trim() }];
    setAccounts(newList);
    localStorage.setItem("seoKey_bing_accounts_list", JSON.stringify(newList));
    setNewName("");
    setNewKey("");
  };

  const removeAccount = (id: string) => {
    const newList = accounts.filter(a => a.id !== id);
    setAccounts(newList);
    localStorage.setItem("seoKey_bing_accounts_list", JSON.stringify(newList));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", width: "100%", marginTop: "14px" }}>
      <EngineHowTo
        color="#00809D"
        steps={[t("bingStep1"), t("bingStep2"), t("bingStep3")]}
        note={t("bingStepWarn")}
        docHref="https://github.com/fenjo26/opengsc/blob/main/docs/SEARCH-ENGINES-SETUP.md"
        linkHref="https://www.bing.com/webmasters" linkLabel="bing.com/webmasters"
      />
      <div>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px", color: "var(--color-text-primary)" }}>{t("seAccountsBing")} ({accounts.length})</div>
        {accounts.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{t("seAccountsEmpty")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" }}>
            {accounts.map(acc => (
              <div key={acc.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "8px", gap: "10px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{acc.name}</div>
                  <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontFamily: "monospace" }}>Key: {acc.key.slice(0, 8)}...</div>
                </div>
                <button onClick={() => removeAccount(acc.id)} style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid rgba(239,68,68,0.3)", background: "transparent", color: "#EF4444", fontSize: "11px", cursor: "pointer" }}>Delete</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", background: "rgba(255,255,255,0.02)", padding: "10px", borderRadius: "8px", border: "1px dashed var(--color-border)" }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: "11px", color: "var(--color-text-secondary)", display: "block", marginBottom: "4px" }}>{t("seAccountNameOpt")}</label>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. White Sites" style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none" }} />
          </div>
          <div style={{ flex: 2 }}>
            <label style={{ fontSize: "11px", color: "var(--color-text-secondary)", display: "block", marginBottom: "4px" }}>API Key</label>
            <input type="password" value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="Bing API key..." style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none" }} />
          </div>
          <button onClick={addAccount} disabled={!newKey.trim()} style={{ padding: "8px 14px", borderRadius: "6px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer", opacity: newKey.trim() ? 1 : 0.5 }}>{t("seAdd")}</button>
        </div>
      </div>
    </div>
  );
}

function YandexAccountsManager() {
  const { t } = useLanguage();
  const [accounts, setAccounts] = useState<SearchEngineAccount[]>([]);
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    try {
      setAccounts(JSON.parse(localStorage.getItem("seoKey_yandex_accounts_list") || "[]"));
    } catch (e) {
      setAccounts([]);
    }
  }, []);

  const addAccount = () => {
    if (!newKey.trim()) return;
    const name = newName.trim() || `Yandex ${accounts.length + 1}`;
    const newList = [...accounts, { id: Math.random().toString(36).slice(2, 9), name, key: newKey.trim() }];
    setAccounts(newList);
    localStorage.setItem("seoKey_yandex_accounts_list", JSON.stringify(newList));
    setNewName("");
    setNewKey("");
  };

  const removeAccount = (id: string) => {
    const newList = accounts.filter(a => a.id !== id);
    setAccounts(newList);
    localStorage.setItem("seoKey_yandex_accounts_list", JSON.stringify(newList));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", width: "100%", marginTop: "14px" }}>
      <EngineHowTo
        color="#FC3F1D"
        steps={[t("yandexStep1"), t("yandexStep2"), t("yandexStep3"), t("yandexStep4")]}
        docHref="https://github.com/fenjo26/opengsc/blob/main/docs/SEARCH-ENGINES-SETUP.md"
        linkHref="https://oauth.yandex.ru" linkLabel="oauth.yandex.ru"
      />
      <div>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px", color: "var(--color-text-primary)" }}>{t("seAccountsYandex")} ({accounts.length})</div>
        {accounts.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{t("seAccountsEmpty")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" }}>
            {accounts.map(acc => (
              <div key={acc.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "8px", gap: "10px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{acc.name}</div>
                  <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontFamily: "monospace" }}>Token: {acc.key.slice(0, 8)}...</div>
                </div>
                <button onClick={() => removeAccount(acc.id)} style={{ padding: "4px 8px", borderRadius: "6px", border: "1px solid rgba(239,68,68,0.3)", background: "transparent", color: "#EF4444", fontSize: "11px", cursor: "pointer" }}>Delete</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", background: "rgba(255,255,255,0.02)", padding: "10px", borderRadius: "8px", border: "1px dashed var(--color-border)" }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: "11px", color: "var(--color-text-secondary)", display: "block", marginBottom: "4px" }}>{t("seAccountNameOpt")}</label>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. White Sites" style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none" }} />
          </div>
          <div style={{ flex: 2 }}>
            <label style={{ fontSize: "11px", color: "var(--color-text-secondary)", display: "block", marginBottom: "4px" }}>OAuth Token</label>
            <input type="password" value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="Yandex token..." style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none" }} />
          </div>
          <button onClick={addAccount} disabled={!newKey.trim()} style={{ padding: "8px 14px", borderRadius: "6px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer", opacity: newKey.trim() ? 1 : 0.5 }}>{t("seAdd")}</button>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "24px", ...style }}>
      {children}
    </div>
  );
}

function SectionTitle({ icon, title, sub }: { icon?: React.ReactNode; title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: sub ? "6px" : "20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {icon && <span style={{ color: "var(--color-text-primary)" }}>{icon}</span>}
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title}</h2>
      </div>
      {sub && <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "4px", marginBottom: "20px" }}>{sub}</p>}
    </div>
  );
}

function GoogleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.618 14.115 17.64 11.807 17.64 9.2z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
      <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

function BingIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <polygon points="166.685,38.682 52.904,0 52.904,422.118 166.685,321.987" fill="#008373" />
      <polygon points="206.501,133.117 253.157,249.166 319.397,270.361 56.324,431.215 170.095,512 459.096,336.78 459.096,216.17" fill="#008373" />
    </svg>
  );
}

function YandexIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path d="M21.88,2h-4c-4,0-8.07,3-8.07,9.62a8.33,8.33,0,0,0,4.14,7.66L9,28.13A1.25,1.25,0,0,0,9,29.4a1.21,1.21,0,0,0,1,.6h2.49a1.24,1.24,0,0,0,1.2-.75l4.59-9h.34v8.62A1.14,1.14,0,0,0,19.82,30H22a1.12,1.12,0,0,0,1.16-1.06V3.22A1.19,1.19,0,0,0,22,2ZM18.7,16.28h-.59c-2.3,0-3.66-1.87-3.66-5,0-3.9,1.73-5.29,3.34-5.29h.94Z" fill="#d61e3b" />
    </svg>
  );
}

// ─── Section: My Google Accounts ──────────────────────────────────────────────
function AccountsSection({ user, accounts, loadingAccounts, removing, onAdd, onRemove, onReauth }: {
  user: any; accounts: ConnectedAccount[]; loadingAccounts: boolean;
  removing: string | null; onAdd: () => void; onRemove: (id: string) => void; onReauth: (email: string) => void;
}) {
  const { t } = useLanguage();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: "20px", alignItems: "flex-start" }}>
      <SectionCard>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "20px" }}>
          <GoogleIcon size={17} />
          <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("yourAccount")}</h2>
        </div>
        {user && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "16px" }}>
              <UserAvatar email={user.email ?? ""} picture={user.image} size={44} />
              <div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{user.name}</div>
                <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{user.email}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
                {t("scStatus")}: <span style={{ color: "#10B981" }}>{t("scConnected")}</span>
              </span>
              <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
                {t("ga4Status")}: {accounts.some(a => a.ga4Access) ? (
                  <span style={{ color: "#10B981" }}>{t("scConnected")}</span>
                ) : (
                  <span style={{ color: "#F59E0B" }}>{t("scNotConnected")}</span>
                )}
              </span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
              {t("revokeDesc")}{" "}
              <a href="https://myaccount.google.com/" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>https://myaccount.google.com/</a>
              {" "}{t("revokeDesc2")}
            </p>
          </>
        )}
      </SectionCard>

      <SectionCard>
        <div style={{ marginBottom: "16px" }}>
          {/* Title row */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
            <GoogleIcon size={15} />
            <h2 style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("linkedAccounts")}</h2>
            {!loadingAccounts && (
              <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.06)", borderRadius: "20px", padding: "2px 8px" }}>
                {accounts.length} {accounts.length !== 1 ? t("accounts") : t("account")}
              </span>
            )}
          </div>
          {/* Action buttons row */}
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => {
              fetch("/api/gsc/sync", { method: "POST" });
              alert(t("syncStarted"));
            }} style={{ display: "flex", alignItems: "center", gap: "5px", padding: "7px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, background: "rgba(16,185,129,0.12)", color: "#10B981", border: "1px solid rgba(16,185,129,0.25)", cursor: "pointer" }}
              onMouseOver={e => e.currentTarget.style.background = "rgba(16,185,129,0.2)"} onMouseOut={e => e.currentTarget.style.background = "rgba(16,185,129,0.12)"}
            ><Globe size={13} /> {t("syncNow")}</button>

            <button onClick={onAdd} style={{ display: "flex", alignItems: "center", gap: "5px", padding: "7px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, background: "rgba(59,130,246,0.12)", color: "#3B82F6", border: "1px solid rgba(59,130,246,0.25)", cursor: "pointer" }}
              onMouseOver={e => e.currentTarget.style.background = "rgba(59,130,246,0.2)"} onMouseOut={e => e.currentTarget.style.background = "rgba(59,130,246,0.12)"}
            ><Plus size={13} /> {t("addAccount")}</button>
          </div>
        </div>

        {/* OAuth Test Users warning */}
        <div style={{ padding: "12px 14px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: "8px", marginBottom: "16px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "#F59E0B", marginBottom: "4px" }}>{t("oauthTestModeTitle")}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>{t("oauthTestModeDesc")}</div>
        </div>
        {loadingAccounts ? (
          <div style={{ color: "var(--color-text-secondary)", fontSize: "13px", padding: "12px 0" }}>{t("loadingAccounts")}</div>
        ) : accounts.length === 0 ? (
          <div style={{ textAlign: "center", padding: "28px 0" }}>
            <Globe size={28} style={{ color: "var(--color-text-secondary)", marginBottom: "10px", opacity: 0.4 }} />
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("noAccountsLinked")}<br />{t("noAccountsLinkedHint")}
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {accounts.map(acc => (
              <div key={acc.id} style={{ borderRadius: "8px", border: confirmDeleteId === acc.id ? "1px solid rgba(239,68,68,0.4)" : acc.gscAccess ? "1px solid transparent" : "1px solid rgba(239,68,68,0.2)", background: confirmDeleteId === acc.id ? "rgba(239,68,68,0.07)" : acc.gscAccess ? "transparent" : "rgba(239,68,68,0.04)", transition: "all 0.15s" }}>

                {/* Main account row */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 8px" }}>
                  <UserAvatar email={acc.email} picture={acc.picture} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{acc.email.split("@")[0]}</div>
                    <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{acc.email}</div>
                  </div>
                  <span style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "3px", color: acc.gscAccess ? "#10B981" : "#f87171", flexShrink: 0 }}>
                    GSC {acc.gscAccess ? <CheckCircle size={11} color="#10B981" /> : <AlertCircle size={11} color="#f87171" />}
                  </span>
                  <span style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "3px", color: acc.ga4Access ? "#10B981" : "var(--color-text-secondary)", flexShrink: 0 }}>
                    GA4 {acc.ga4Access ? <CheckCircle size={11} color="#10B981" /> : <AlertCircle size={11} color="#94a3b8" />}
                  </span>
                  {/* Delete button */}
                  {confirmDeleteId !== acc.id && (
                    <button
                      onClick={() => setConfirmDeleteId(acc.id)}
                      disabled={removing === acc.id}
                      style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 9px", borderRadius: "6px", fontSize: "11px", fontWeight: 500, background: "rgba(255,255,255,0.04)", color: "var(--color-text-secondary)", border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer", flexShrink: 0, opacity: removing === acc.id ? 0.4 : 1 }}
                      onMouseOver={e => { e.currentTarget.style.background = "rgba(239,68,68,0.1)"; e.currentTarget.style.color = "#f87171"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.25)"; }}
                      onMouseOut={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = "var(--color-text-secondary)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
                    >
                      <X size={11} /> {t("remove")}
                    </button>
                  )}
                </div>

                {/* Inline delete confirmation */}
                {confirmDeleteId === acc.id && (
                  <div style={{ padding: "0 8px 10px 50px", display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "#f87171", flex: 1 }}>
                      {t("setRemoveAccountQ1")} <strong>{acc.email}</strong>{t("setRemoveAccountQ2")}
                    </span>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      style={{ padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, background: "rgba(255,255,255,0.06)", color: "var(--color-text-secondary)", border: "1px solid rgba(255,255,255,0.1)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                      onMouseOver={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
                      onMouseOut={e => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                    >
                      {t("cancel")}
                    </button>
                    <button
                      onClick={() => { setConfirmDeleteId(null); onRemove(acc.id); }}
                      disabled={removing === acc.id}
                      style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, background: "rgba(239,68,68,0.15)", color: "#f87171", border: "1px solid rgba(239,68,68,0.35)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, opacity: removing === acc.id ? 0.5 : 1 }}
                      onMouseOver={e => e.currentTarget.style.background = "rgba(239,68,68,0.28)"}
                      onMouseOut={e => e.currentTarget.style.background = "rgba(239,68,68,0.15)"}
                    >
                      <X size={11} /> {t("setConfirmRemove")}
                    </button>
                  </div>
                )}

                {/* GSC re-auth warning */}
                {!acc.gscAccess && confirmDeleteId !== acc.id && (
                  <div style={{ padding: "0 8px 10px 50px", display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "11px", color: "#f87171", flex: 1 }}>
                      {t("setNoGscAccess")}
                    </span>
                    <button
                      onClick={() => onReauth(acc.email)}
                      style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                      onMouseOver={e => e.currentTarget.style.background = "rgba(239,68,68,0.22)"}
                      onMouseOut={e => e.currentTarget.style.background = "rgba(239,68,68,0.12)"}
                    >
                      <GoogleIcon size={11} /> {t("setReauthorize")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─── Section: My Teams ────────────────────────────────────────────────────────
function TeamsSection({ user }: { user: any }) {
  const { t } = useLanguage();
  const teamName = user?.name ? `${user.name.split(" ")[0]}'s Team` : "My Team";
  return (
    <SectionCard>
      <SectionTitle icon={<Users size={17} />} title={t("myTeams")} />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {[t("teamColTeam"), t("teamColShares"), t("teamColBilling")].map(h => (
              <th key={h} style={{ textAlign: "left", fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 500, paddingBottom: "14px", borderBottom: "1px solid var(--color-border)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: "16px 0 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <UserAvatar email={user?.email ?? "a"} picture={user?.image} size={28} />
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{teamName}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "2px" }}>
                    <Crown size={11} color="#F59E0B" />
                    <span style={{ fontSize: "11px", color: "#F59E0B", fontWeight: 600 }}>{t("owner")}</span>
                  </div>
                </div>
              </div>
            </td>
            <td style={{ padding: "16px 0 0" }}>
              <button style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}>
                <CheckCircle size={14} color="#10B981" /> {t("yes")} <ChevronDown size={13} color="var(--color-text-secondary)" />
              </button>
            </td>
            <td style={{ padding: "16px 0 0" }}>
              <button style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "13px", color: "var(--color-accent-blue)", background: "none", border: "none", cursor: "pointer", fontWeight: 500 }}>
                {t("view")} <span style={{ fontSize: "11px" }}>↗</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </SectionCard>
  );
}

// ─── Section: API & MCP Keys ──────────────────────────────────────────────────
function ApiSection() {
  const { t } = useLanguage();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState<string>("");
  const [client, setClient] = useState<"claude-code" | "claude-desktop" | "cursor" | "codex">("claude-code");
  // Read from the server rather than hand-maintained here: a second copy of the registry
  // in the UI is a copy that silently goes stale, which is exactly what happened before.
  const [tools, setTools] = useState<{ name: string; cost: string }[]>([]);

  const appUrl = typeof window !== "undefined" ? window.location.origin : "https://your-domain.com";
  const endpoint = `${appUrl}/api/mcp`;
  const shownToken = token ?? "<TOKEN>";

  useEffect(() => {
    fetch("/api/settings/mcp-token").then(r => r.json()).then(d => { setToken(d.token ?? null); setLoading(false); }).catch(() => setLoading(false));
    // Same-origin, so the session cookie authenticates it — no MCP token needed to look.
    fetch("/api/mcp/tools").then(r => r.json()).then(d => setTools(Array.isArray(d.tools) ? d.tools : [])).catch(() => setTools([]));
  }, []);

  const generate = async () => {
    setBusy(true);
    try {
      const d = await fetch("/api/settings/mcp-token", { method: "POST" }).then(r => r.json());
      if (d.token) { setToken(d.token); setVisible(true); }
    } catch {}
    setBusy(false);
  };
  const revoke = async () => {
    setBusy(true);
    try { await fetch("/api/settings/mcp-token", { method: "DELETE" }); setToken(null); } catch {}
    setBusy(false);
  };
  const copy = (what: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 2000);
  };

  const commands: Record<typeof client, { label: string; cmd: string }> = {
    "claude-code": {
      label: "Claude Code",
      cmd: `claude mcp add --transport http opengsc ${endpoint} --header "Authorization: Bearer ${shownToken}"`,
    },
    // Claude Desktop's "Add custom connector" dialog has a URL field and, behind Advanced
    // settings, OAuth Client ID / Client Secret — and nothing else. There is no header
    // field, so the Bearer line this panel used to print had nowhere to go; pasting the
    // token into OAuth Client ID (the obvious guess) silently does nothing. Hence the URL
    // carries the token instead, with the header-based alternative underneath for anyone
    // who would rather keep it out of a URL.
    "claude-desktop": {
      label: "Claude Desktop",
      cmd: `${t("mcpDesktopHint")}

URL: ${endpoint}?token=${shownToken}

${t("mcpDesktopNoHeader")}

${t("mcpDesktopBridge")}

{
  "mcpServers": {
    "opengsc": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${endpoint}",
               "--header", "Authorization: Bearer ${shownToken}"]
    }
  }
}`,
    },
    "cursor": {
      label: "Cursor",
      cmd: `{
  "mcpServers": {
    "opengsc": {
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer ${shownToken}" }
    }
  }
}`,
    },
    "codex": {
      label: "Codex CLI",
      cmd: `[mcp_servers.opengsc]
url = "${endpoint}"
http_headers = { "Authorization" = "Bearer ${shownToken}" }`,
    },
  };

  // Cost tiers, in the order they are shown. Colour carries the meaning that matters at a
  // glance: blue is free, amber costs a Google quota or a fetch, red spends real money.
  // `border` is spelled out rather than derived from `color` with an alpha suffix, because
  // one of these colours is a CSS variable and `var(--x)33` is not a colour.
  const TIERS: { key: "local" | "quota" | "net" | "paid"; label: string; color: string; bg: string; border: string }[] = [
    { key: "local", label: t("mcpTierLocal"), color: "var(--color-accent-blue)", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.2)" },
    { key: "quota", label: t("mcpTierQuota"), color: "#FCD34D", bg: "rgba(252,211,77,0.08)", border: "rgba(252,211,77,0.25)" },
    { key: "net", label: t("mcpTierNet"), color: "#FCD34D", bg: "rgba(252,211,77,0.08)", border: "rgba(252,211,77,0.25)" },
    { key: "paid", label: t("mcpTierPaid"), color: "#f87171", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.25)" },
  ];

  const codeBox: React.CSSProperties = { display: "flex", alignItems: "stretch", background: "rgba(255,255,255,0.04)", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <SectionCard>
        <SectionTitle icon={<Zap size={17} />} title={t("mcpTitle")} sub={t("mcpSub")} />

        {/* Token management */}
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "8px" }}>{t("mcpTokenTitle")}</div>
          {loading ? (
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>…</div>
          ) : token ? (
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <code style={{ flex: 1, minWidth: "220px", padding: "10px 14px", fontSize: "12px", fontFamily: "monospace", color: "var(--color-text-primary)", background: "rgba(255,255,255,0.04)", border: "1px solid var(--color-border)", borderRadius: "8px", wordBreak: "break-all" }}>
                {visible ? token : token.slice(0, 10) + "•".repeat(24)}
              </code>
              <button onClick={() => setVisible(v => !v)} style={{ padding: "9px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}><Eye size={14} /></button>
              <button onClick={() => copy("token", token)} style={{ padding: "9px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: copied === "token" ? "#10B981" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: "5px" }}>
                {copied === "token" ? <CheckCircle size={13} /> : <Copy size={13} />} {copied === "token" ? t("mcpCopied") : t("mcpCopy")}
              </button>
              <button onClick={generate} disabled={busy} style={{ padding: "9px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>{t("mcpRotate")}</button>
              <button onClick={revoke} disabled={busy} style={{ padding: "9px 12px", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.08)", color: "#f87171", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>{t("mcpRevoke")}</button>
            </div>
          ) : (
            <button onClick={generate} disabled={busy} style={{ padding: "10px 18px", borderRadius: "8px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              {busy ? "…" : t("mcpGenerate")}
            </button>
          )}
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "8px", lineHeight: 1.6 }}>{t("mcpTokenNote")}</div>
        </div>

        {/* Endpoint */}
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "8px" }}>{t("mcpEndpointTitle")}</div>
          <div style={codeBox}>
            <code style={{ flex: 1, padding: "12px 16px", fontSize: "12px", fontFamily: "monospace", color: "var(--color-text-secondary)", wordBreak: "break-all" }}>{endpoint}</code>
            <button onClick={() => copy("endpoint", endpoint)} style={{ padding: "0 14px", background: "transparent", border: "none", borderLeft: "1px solid var(--color-border)", color: copied === "endpoint" ? "#10B981" : "var(--color-text-secondary)", cursor: "pointer" }}>
              {copied === "endpoint" ? <CheckCircle size={15} /> : <Copy size={15} />}
            </button>
          </div>
        </div>

        {/* Connect guide */}
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("mcpConnectTitle")}</h3>
          <div style={{ display: "flex", gap: "2px", background: "rgba(255,255,255,0.06)", borderRadius: "8px", padding: "3px", width: "fit-content", flexWrap: "wrap" }}>
            {(Object.keys(commands) as (typeof client)[]).map(id => (
              <button key={id} onClick={() => setClient(id)} style={{ padding: "6px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer", background: client === id ? "var(--color-card)" : "transparent", color: client === id ? "var(--color-text-primary)" : "var(--color-text-secondary)", border: "none", transition: "all 0.15s" }}>
                {commands[id].label}
              </button>
            ))}
          </div>
          {!token && <div style={{ fontSize: "12px", color: "#FCD34D" }}>{t("mcpNoTokenYet")}</div>}
          <div style={codeBox}>
            <pre style={{ flex: 1, padding: "12px 16px", fontSize: "12px", fontFamily: "monospace", color: "var(--color-text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{commands[client].cmd}</pre>
            <button onClick={() => copy("cmd", commands[client].cmd)} style={{ padding: "0 14px", background: "transparent", border: "none", borderLeft: "1px solid var(--color-border)", color: copied === "cmd" ? "#10B981" : "var(--color-text-secondary)", cursor: "pointer", flexShrink: 0 }}>
              {copied === "cmd" ? <CheckCircle size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6, margin: 0 }}>
            {t("mcpTryPrompt")} <em style={{ color: "var(--color-text-primary)" }}>{t("mcpTryPromptExample")}</em>
          </p>
        </div>

        {/* Available tools */}
        <div style={{ marginTop: "20px" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>
            {t("mcpToolsTitle")} {tools.length > 0 && <span style={{ fontWeight: 500, color: "var(--color-text-secondary)" }}>({tools.length})</span>}
          </div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "12px", lineHeight: 1.6 }}>{t("mcpToolsCostNote")}</div>
          {TIERS.map(tier => {
            const inTier = tools.filter(x => x.cost === tier.key);
            if (!inTier.length) return null;
            return (
              <div key={tier.key} style={{ marginBottom: "12px" }}>
                <div style={{ fontSize: "11.5px", fontWeight: 600, color: tier.color, marginBottom: "6px" }}>{tier.label}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {inTier.map(x => (
                    <code key={x.name} style={{ fontSize: "11px", fontFamily: "monospace", padding: "4px 9px", borderRadius: "6px", background: tier.bg, border: `1px solid ${tier.border}`, color: tier.color }}>{x.name}</code>
                  ))}
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", marginTop: "14px", lineHeight: 1.6, padding: "12px 14px", borderRadius: "8px", background: "rgba(59,130,246,0.05)", border: "1px solid rgba(59,130,246,0.12)", display: "flex", flexDirection: "column", gap: "6px" }}>
            <span>
              💡 <b>{t("mcpSkillsTitle") || "AI Agent Skills:"}</b> {t("mcpSkillsNote")}
            </span>
            <a href="https://github.com/fenjo26/opengsc/tree/main/.agents/skills" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "4px", width: "fit-content" }}>
              <span>GitHub: opengsc/.agents/skills</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
            </a>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

// ─── Section: Team Members ────────────────────────────────────────────────────
function MembersSection({ user }: { user: any }) {
  const { t } = useLanguage();
  return (
    <SectionCard>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("members")}</h2>
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.06)", borderRadius: "20px", padding: "2px 8px" }}>{t("membersCount")}</span>
        </div>
        <button style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 16px", borderRadius: "8px", background: "rgba(59,130,246,0.12)", color: "#3B82F6", border: "1px solid rgba(59,130,246,0.25)", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          <Plus size={14} /> {t("invite")}
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 0", borderTop: "1px solid var(--color-border)" }}>
        <UserAvatar email={user?.email ?? "a"} picture={user?.image} size={36} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>{user?.name ?? t("yourAccount")}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{user?.email}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "20px", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)" }}>
          <Crown size={12} color="#F59E0B" />
          <span style={{ fontSize: "12px", color: "#F59E0B", fontWeight: 600 }}>{t("owner")}</span>
        </div>
      </div>
    </SectionCard>
  );
}

// ─── Section: Preferences ─────────────────────────────────────────────────────
function PreferencesSection({ user }: { user: any }) {
  const { t, language, setLanguage } = useLanguage();
  const teamName = user?.name ? `${user.name.split(" ")[0]}'s Team` : "My Team";
  const [shareWithTeam, setShareWithTeam] = useState(true);
  const [useAI, setUseAI] = useState(true);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Sharing */}
      {EXPERIMENTAL_TEAM_UI && <SectionCard>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("sharingTitle")}</h2>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{teamName}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("sharingDesc")}</div>
          </div>
          <button onClick={() => setShareWithTeam(s => !s)} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}>
            {shareWithTeam ? <CheckCircle size={14} color="#10B981" /> : <X size={14} color="#6b7280" />}
            {shareWithTeam ? t("yes") : t("no")}
            <ChevronDown size={13} color="var(--color-text-secondary)" />
          </button>
        </div>
      </SectionCard>}

      {!EXPERIMENTAL_TEAM_UI && (
        <SectionCard>
          <SectionTitle title={t("singleOperatorTitle")} sub={t("singleOperatorDesc")} />
        </SectionCard>
      )}

      {/* Language */}
      <SectionCard>
        <SectionTitle title={t("language")} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("language")}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>English / Русский / Українська / Français / Español / Deutsch / 简体中文</div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", justifyContent: "flex-end" }}>
            {(["en", "ru", "uk", "fr", "es", "de", "zh"] as const).map(lang => (
              <button key={lang} onClick={() => setLanguage(lang)} style={{ padding: "6px 12px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, cursor: "pointer", background: language === lang ? "rgba(139,92,246,0.15)" : "transparent", color: language === lang ? "#8B5CF6" : "var(--color-text-secondary)", border: `1px solid ${language === lang ? "rgba(139,92,246,0.3)" : "var(--color-border)"}`, transition: "all 0.15s" }}>
                {lang === "en" ? "🇬🇧 EN" : lang === "ru" ? "🇷🇺 RU" : lang === "uk" ? "🇺🇦 UK" : lang === "fr" ? "🇫🇷 FR" : lang === "es" ? "🇪🇸 ES" : lang === "de" ? "🇩🇪 DE" : "🇨🇳 ZH"}
              </button>
            ))}
          </div>
        </div>
      </SectionCard>

      {/* Team Preferences */}
      {EXPERIMENTAL_TEAM_UI && <SectionCard>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("teamPreferences")}</h2>
          <button style={{ fontSize: "13px", color: "var(--color-accent-blue)", background: "none", border: "none", cursor: "pointer", fontWeight: 500, display: "flex", alignItems: "center", gap: "4px" }}>
            <Edit2 size={13} /> {t("edit")}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("useAI")}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("useAIDesc")}</div>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {[t("yes"), t("no")].map((opt, idx) => {
              const isActive = idx === 0 ? useAI : !useAI;
              return (
                <button key={opt} onClick={() => setUseAI(idx === 0)} style={{ padding: "6px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, cursor: "pointer", background: isActive ? "rgba(59,130,246,0.15)" : "transparent", color: isActive ? "#3B82F6" : "var(--color-text-secondary)", border: `1px solid ${isActive ? "rgba(59,130,246,0.3)" : "var(--color-border)"}`, transition: "all 0.15s" }}>
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      </SectionCard>}
      {/* Automatic sync. Lives here rather than next to the Google accounts: it is a preference
          about how the instance behaves, not a property of any one connected account. */}
      <SyncScheduleSection />
    </div>
  );
}

// ─── Automatic sync schedule (Settings → Preferences) ────────────────────────
// The hour is stored in the user's own zone rather than UTC, because the thing being scheduled
// is "be ready before I start work" and a UTC hour drifts away from that at every DST change.
// See src/lib/syncSchedule.ts.
function SyncScheduleSection() {
  const { t } = useLanguage() as any;
  type Schedule = { enabled: boolean; hour: number; timeZone: string; lastRunAt: string | null };
  const [s, setS] = useState<Schedule | null>(null);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/sync").then(r => r.json()).then(d => {
      if (!d?.settings) return;
      // The stored default is UTC, which is nobody's working day. Until the user saves anything,
      // show the zone their own browser is in — that is the one they mean by "nine in the morning".
      const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      setS({ ...d.settings, timeZone: d.settings.timeZone === "UTC" ? browserZone : d.settings.timeZone });
    }).catch(() => {});
  }, []);

  const save = async (next: Schedule) => {
    setS(next); setErr(""); setSaved(false);
    try {
      const res = await fetch("/api/settings/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: next }),
      });
      if (!res.ok) { setErr(t("autoSyncNotMigrated")); return; }
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch {
      setErr(t("autoSyncNotMigrated"));
    }
  };

  if (!s) return null;

  const select: React.CSSProperties = {
    padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
    background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px",
  };

  return (
    <SectionCard>
      <SectionTitle icon={<Zap size={17} color="#10B981" />} title={t("autoSyncTitle")} sub={t("autoSyncSub")} />
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer" }}>
          <input type="checkbox" checked={s.enabled} onChange={e => save({ ...s, enabled: e.target.checked })} />
          {t("autoSyncEnable")}
        </label>
        <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("autoSyncAt")}</span>
        <select value={s.hour} onChange={e => save({ ...s, hour: Number(e.target.value) })} style={select}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
          ))}
        </select>
        <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("autoSyncZone")}: {s.timeZone}</span>
        {saved && <span style={{ fontSize: "12px", color: "#10B981" }}>✓</span>}
      </div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "10px", lineHeight: 1.6 }}>
        {t("autoSyncLastRun")}: {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : t("autoSyncNever")}
        <br />
        {t("autoSyncNote")}
      </div>
      {err && <div style={{ fontSize: "12px", color: "#f87171", marginTop: "8px" }}>{err}</div>}
    </SectionCard>
  );
}

// ─── Notifications Section (Telegram bot + alert rules) ───────────────────────
function NotificationsSection() {
  const { t, language } = useLanguage() as any;
  // Telegram state
  const [tg, setTg] = useState<{ connected: boolean; botTokenMasked: string | null; chatId: string | null } | null>(null);
  const [botToken, setBotToken] = useState("");
  const [tgBusy, setTgBusy] = useState("");
  const [tgMsg, setTgMsg] = useState("");
  // Slack state
  const [slack, setSlack] = useState<{ connected: boolean; webhookMasked: string | null } | null>(null);
  const [slackWebhook, setSlackWebhook] = useState("");
  const [slackBusy, setSlackBusy] = useState("");
  const [slackMsg, setSlackMsg] = useState("");
  // Alerts state
  const [alerts, setAlerts] = useState<any>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [alertsSaved, setAlertsSaved] = useState(false);

  const reloadTg = () => fetch("/api/settings/telegram").then(r => r.json()).then(setTg).catch(() => {});
  const reloadSlack = () => fetch("/api/settings/slack").then(r => r.json()).then(setSlack).catch(() => {});
  const reloadAlerts = () => fetch("/api/settings/alerts").then(r => r.json()).then(d => { setAlerts(d.settings); setRecent(d.recent || []); }).catch(() => {});
  useEffect(() => { reloadTg(); reloadSlack(); reloadAlerts(); }, []);

  const tgAction = async (action: string, body: any = {}) => {
    setTgBusy(action); setTgMsg("");
    try {
      const res = await fetch("/api/settings/telegram", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const d = await res.json();
      if (!res.ok) setTgMsg(t("tgErr") + ": " + (d.error ?? res.status));
      else if (action === "detect") setTgMsg(`${t("tgDetected")} ${d.username || d.chatId}`);
      else if (action === "test") setTgMsg(t("tgTestOk"));
      reloadTg();
    } catch (e: any) { setTgMsg(String(e?.message ?? e)); }
    setTgBusy("");
  };

  const slackAction = async (action: string, body: any = {}) => {
    setSlackBusy(action); setSlackMsg("");
    try {
      const res = await fetch("/api/settings/slack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const d = await res.json();
      if (!res.ok) setSlackMsg((t("tgErr") || "Error") + ": " + (d.error ?? res.status));
      else if (action === "save") setSlackMsg(t("slackSaved") || "Slack Webhook saved successfully.");
      else if (action === "test") setSlackMsg(t("slackTestOk") || "Test message sent to Slack channel.");
      reloadSlack();
    } catch (e: any) { setSlackMsg(String(e?.message ?? e)); }
    setSlackBusy("");
  };

  const saveAlerts = async (next: any) => {
    setAlerts(next);
    try {
      await fetch("/api/settings/alerts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { ...next, lang: language } }),
      });
      setAlertsSaved(true); setTimeout(() => setAlertsSaved(false), 1500);
    } catch {}
  };

  const numInput: React.CSSProperties = { width: "64px", padding: "6px 8px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px" };
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--color-border)", flexWrap: "wrap" };
  const smallBtn: React.CSSProperties = { padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };

  const AlertRow = ({ id, label, value, unit, field }: { id: string; label: string; value: any; unit: string; field: string }) => (
    <div style={rowStyle}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer", minWidth: "260px" }}>
        <input type="checkbox" checked={!!value.on} onChange={e => saveAlerts({ ...alerts, [id]: { ...value, on: e.target.checked } })} />
        {label}
      </label>
      <input type="number" value={value[field]} style={numInput}
        onChange={e => saveAlerts({ ...alerts, [id]: { ...value, [field]: Number(e.target.value) } })} />
      <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{unit}</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Telegram */}
      <SectionCard>
        <SectionTitle icon={<Zap size={17} color="#2AABEE" />} title={t("tgTitle")} sub={t("tgSub")} />
        {tg?.connected ? (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#10B981", fontWeight: 600 }}>
              <CheckCircle size={14} /> {t("tgConnected")}
            </span>
            <code style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontFamily: "monospace" }}>{tg.botTokenMasked} · chat {tg.chatId}</code>
            <button onClick={() => tgAction("test")} disabled={!!tgBusy} style={smallBtn}>{tgBusy === "test" ? "…" : t("tgTest")}</button>
            <button onClick={async () => { await fetch("/api/settings/telegram", { method: "DELETE" }); reloadTg(); }} style={{ ...smallBtn, border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.08)", color: "#f87171" }}>{t("tgDisconnect")}</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <ol style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.8, paddingLeft: "18px", margin: 0 }}>
              <li>{t("tgStep1")} <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>@BotFather</a> → <code>/newbot</code></li>
              <li>{t("tgStep2")}</li>
              <li>{t("tgStep3")}</li>
            </ol>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input value={botToken} onChange={e => setBotToken(e.target.value)} placeholder="123456789:AA..." type="password"
                style={{ flex: 1, minWidth: "220px", padding: "9px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontFamily: "monospace" }} />
              <button onClick={() => tgAction("save", { botToken })} disabled={!botToken.trim() || !!tgBusy}
                style={{ ...smallBtn, background: "var(--color-accent-blue)", color: "#fff", border: "none" }}>{tgBusy === "save" ? "…" : t("tgSaveToken")}</button>
            </div>
            {tg?.botTokenMasked && !tg.chatId && (
              <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("tgDetectHint")}</span>
                <button onClick={() => tgAction("detect")} disabled={!!tgBusy} style={smallBtn}>{tgBusy === "detect" ? "…" : t("tgDetect")}</button>
              </div>
            )}
          </div>
        )}
        {tgMsg && <div style={{ fontSize: "12px", color: tgMsg.startsWith(t("tgErr")) ? "#f87171" : "#10B981", marginTop: "10px" }}>{tgMsg}</div>}
      </SectionCard>

      {/* Slack Webhook */}
      <SectionCard>
        <SectionTitle icon={
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#E01E5A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" />
          </svg>
        } title={t("slackTitle") || "Slack Webhook"} sub={t("slackSub") || "Send alerts and digests directly to a Slack channel."} />
        {slack?.connected ? (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#10B981", fontWeight: 600 }}>
              <CheckCircle size={14} /> {t("slackConnected") || "Connected"}
            </span>
            <code style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontFamily: "monospace" }}>{slack.webhookMasked}</code>
            <button onClick={() => slackAction("test")} disabled={!!slackBusy} style={smallBtn}>{slackBusy === "test" ? "…" : t("tgTest")}</button>
            <button onClick={async () => { await fetch("/api/settings/slack", { method: "DELETE" }); reloadSlack(); }} style={{ ...smallBtn, border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.08)", color: "#f87171" }}>{t("tgDisconnect")}</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>
              {t("slackStep1") || "Create an Incoming Webhook in your Slack Workspace settings and paste the Webhook URL below:"}
            </p>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input value={slackWebhook} onChange={e => setSlackWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/..." type="password"
                style={{ flex: 1, minWidth: "220px", padding: "9px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontFamily: "monospace" }} />
              <button onClick={() => slackAction("save", { webhookUrl: slackWebhook })} disabled={!slackWebhook.trim() || !!slackBusy}
                style={{ ...smallBtn, background: "var(--color-accent-blue)", color: "#fff", border: "none" }}>{slackBusy === "save" ? "…" : t("tgSaveToken")}</button>
            </div>
          </div>
        )}
        {slackMsg && <div style={{ fontSize: "12px", color: slackMsg.includes("Error") || slackMsg.includes("invalid") ? "#f87171" : "#10B981", marginTop: "10px" }}>{slackMsg}</div>}
      </SectionCard>

      {/* Alert rules */}
      {alerts && (
        <SectionCard>
          <SectionTitle icon={<AlertCircle size={17} color="#F59E0B" />} title={t("alertsTitle")} sub={t("alertsSub")} />
          <AlertRow id="rankDrop" label={t("alertRankDrop")} value={alerts.rankDrop} unit={t("alertPositionsUnit")} field="threshold" />
          <AlertRow id="trafficDrop" label={t("alertTrafficDrop")} value={alerts.trafficDrop} unit="%" field="percent" />
          <AlertRow id="ssl" label={t("alertSsl")} value={alerts.ssl} unit={t("alertDaysUnit")} field="days" />
          <AlertRow id="audit" label={t("alertAudit")} value={alerts.audit} unit={t("alertScoreUnit")} field="minScore" />
          {/* Off by default and dependent on a loaded backlink profile — it reads stored rows
              and never calls a provider, so enabling it cannot cost anything by itself. */}
          <AlertRow id="lostLink" label={t("alertLostLink")} value={alerts.lostLink} unit={t("alertLostLinkDr")} field="minDr" />
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
            <button onClick={async () => {
              const d = await fetch("/api/settings/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) }).then(r => r.json());
              setTgMsg(`${t("alertsRanNow")}: ${d.fired ?? 0}`);
              reloadAlerts();
            }} style={smallBtn}>{t("alertsRunNow")}</button>
            {alertsSaved && <span style={{ fontSize: "12px", color: "#10B981" }}>✓ {t("seoModelSaved")}</span>}
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("alertsCadenceNote")}</span>
          </div>
        </SectionCard>
      )}

      {/* Recent alerts */}
      {recent.length > 0 && (
        <SectionCard>
          <SectionTitle icon={<AlertCircle size={17} color="#EF4444" />} title={t("alertsRecent")} sub="" />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {recent.map(a => (
              <div key={a.id} style={{ padding: "10px 12px", borderRadius: "8px", background: "rgba(255,255,255,0.03)", border: "1px solid var(--color-border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{a.title}</span>
                  {a.sent && <span style={{ fontSize: "11px", color: "#34c759" }}>✓ {t("alertSent") || "Sent"}</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{new Date(a.createdAt).toLocaleString()}</span>
                </div>
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "3px" }}>{a.message.replace(/\*/g, "")}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ─── AI Configuration Section Component ───────────────────────────────────────
const AI_PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    model: "Claude Haiku 4.5",
    placeholder: "sk-ant-api03-...",
    hint: "Default: Claude Haiku 4.5 — fast and affordable; pick Sonnet/Opus below for higher quality",
    docsUrl: "https://console.anthropic.com/settings/keys",
    docsLabel: "console.anthropic.com",
    color: "#CF6B4A",
    logo: "A",
  },
  {
    id: "openai",
    name: "OpenAI",
    model: "GPT-5.6 Luna",
    placeholder: "sk-...",
    hint: "Default: GPT-5.6 Luna — cost-optimized; Terra/Sol available in the model list",
    docsUrl: "https://platform.openai.com/api-keys",
    docsLabel: "platform.openai.com",
    color: "#10A37F",
    logo: "O",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    model: "Gemini 3 Flash",
    placeholder: "AIzaSy...",
    hint: "Default: Gemini 3 Flash — Google's fast multimodal model",
    docsUrl: "https://aistudio.google.com/app/apikey",
    docsLabel: "aistudio.google.com",
    color: "#4285F4",
    logo: "G",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    model: "Claude Haiku 4.5",
    placeholder: "sk-or-...",
    hint: "Access 200+ models through one API; default: Claude Haiku 4.5",
    docsUrl: "https://openrouter.ai/keys",
    docsLabel: "openrouter.ai",
    color: "#7C3AED",
    logo: "R",
  },
  {
    id: "cheaperinference",
    name: "Cheaper Inference",
    model: "GPT-5.6 Luna",
    placeholder: "ir_live_...",
    hint: "Wallet-backed gateway that routes each request to the cheapest available provider for that model; one key for Claude, GPT, Gemini, GLM and Kimi ids",
    docsUrl: "https://cheaperinference.com/docs",
    docsLabel: "cheaperinference.com",
    color: "#0F9D58",
    logo: "C",
  },
  {
    id: "zai",
    name: "Z.AI",
    model: "GLM-4.5-Air",
    placeholder: "z-api-...",
    hint: "Affordable GLM models, Anthropic-compatible API",
    docsUrl: "https://z.ai/manage-apikey/apikey-list",
    docsLabel: "z.ai",
    color: "#0EA5E9",
    logo: "Z",
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot AI)",
    model: "Kimi K3",
    placeholder: "sk-...",
    hint: "Default: Kimi K3 — flagship, 1M context, vision; OpenAI-compatible API",
    docsUrl: "https://platform.moonshot.ai/console/api-keys",
    docsLabel: "platform.moonshot.ai",
    color: "#16C2A3",
    logo: "K",
  },
  {
    id: "kie",
    name: "Kie.ai",
    model: "GPT-5.5 (Codex)",
    placeholder: "kie-...",
    hint: "OpenAI-compatible Responses API, agentic coding/reasoning model",
    docsUrl: "https://kie.ai",
    docsLabel: "kie.ai",
    color: "#F97316",
    logo: "K",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    model: "deepseek-v4-flash",
    placeholder: "sk-...",
    hint: "Default: deepseek-v4-flash — extremely affordable and fast; pick deepseek-v4-pro below for deep reasoning and complex coding",
    docsUrl: "https://platform.deepseek.com",
    docsLabel: "platform.deepseek.com",
    color: "#4D6BFE",
    logo: "D",
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba Cloud)",
    model: "qwen-max",
    placeholder: "sk-...",
    hint: "Default: qwen-max — flagship model by Alibaba Cloud; supports qwen-plus and qwen-turbo in the model list",
    docsUrl: "https://modelstudio.console.alibabacloud.com",
    docsLabel: "modelstudio.console.alibabacloud.com",
    color: "#6E55D0",
    logo: "Q",
  },
] as const;

function AIProviderCard({ provider }: { provider: typeof AI_PROVIDERS[number] }) {
  const { t } = useLanguage();
  const storageKey = `aiKey_${provider.id}`;
  const modelKey = `aiModel_${provider.id}`;
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsErr, setModelsErr] = useState(false);
  // Only rendered for zai; "" means the general API endpoint (the default in lib/llm.ts).
  const [endpoint, setEndpoint] = useState("");
  const isConfigured = key.trim().length > 6;

  useEffect(() => {
    setKey(localStorage.getItem(storageKey) || "");
    setModel(localStorage.getItem(modelKey) || "");
    setEndpoint(localStorage.getItem(`aiBaseUrl_${provider.id}`) || "");
  }, [storageKey, modelKey, provider.id]);

  // Live model list from the provider's own API (server-side proxy avoids CORS).
  const loadModels = async (apiKey: string) => {
    if (!apiKey.trim()) return;
    setModelsLoading(true); setModelsErr(false);
    try {
      const res = await fetch("/api/seo/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.id, apiKey: apiKey.trim() }),
      });
      const d = await res.json();
      const list = Array.isArray(d?.models) ? d.models : [];
      setModels(list);
      if (!list.length) setModelsErr(true);
    } catch { setModelsErr(true); }
    setModelsLoading(false);
  };

  const pickModel = (id: string) => {
    setModel(id);
    if (id) localStorage.setItem(modelKey, id);
    else localStorage.removeItem(modelKey);
  };

  const handleSave = () => {
    localStorage.setItem(storageKey, key.trim());
    // Also update aiProvider/aiApiKey for compatibility with SetupModal
    if (key.trim()) {
      localStorage.setItem("aiProvider", provider.id);
      localStorage.setItem("aiApiKey", key.trim());
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    setKey("");
    localStorage.removeItem(storageKey);
    // If this was the active provider, clear global key too
    if (localStorage.getItem("aiProvider") === provider.id) {
      localStorage.removeItem("aiApiKey");
    }
  };

  return (
    <div style={{
      padding: "16px",
      borderRadius: "10px",
      border: `1px solid ${isConfigured ? `${provider.color}40` : "var(--color-border)"}`,
      background: isConfigured ? `${provider.color}08` : "rgba(255,255,255,0.02)",
      transition: "all 0.2s",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
        <div style={{
          width: "30px", height: "30px", borderRadius: "8px",
          background: `${provider.color}20`, border: `1px solid ${provider.color}40`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "13px", fontWeight: 700, color: provider.color, flexShrink: 0,
        }}>
          {provider.logo}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{provider.name}</div>
          <div style={{ fontSize: "11px", color: model ? provider.color : "var(--color-text-secondary)", fontFamily: model ? "monospace" : undefined }}>{model || provider.model}</div>
        </div>
        {isConfigured ? (
          <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#10B981", fontWeight: 600, flexShrink: 0 }}>
            <CheckCircle size={12} color="#10B981" /> {t("scConnected") || "Connected"}
          </span>
        ) : (
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", flexShrink: 0 }}>{t("apiKeyNotConfigured") || "Not set"}</span>
        )}
      </div>

      {/* Input row */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <input
            type={visible ? "text" : "password"}
            placeholder={provider.placeholder}
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSave()}
            style={{
              width: "100%", padding: "8px 36px 8px 12px",
              borderRadius: "8px", border: "1px solid var(--color-border)",
              background: "var(--color-card)", color: "var(--color-text-primary)",
              fontSize: "12px", outline: "none", boxSizing: "border-box",
              fontFamily: "monospace",
            }}
          />
          <button
            onClick={() => setVisible(v => !v)}
            style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 0, display: "flex", alignItems: "center" }}
          >
            {visible ? <Eye size={14} /> : <Eye size={14} style={{ opacity: 0.5 }} />}
          </button>
        </div>
        {isConfigured && (
          <button
            onClick={handleClear}
            style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.08)", color: "#f87171", fontSize: "12px", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center" }}
            title={t("apiKeyDelete") || "Remove key"}
          >
            <X size={13} />
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={!key.trim()}
          style={{
            padding: "8px 14px", borderRadius: "8px", border: "none",
            background: saved ? "rgba(16,185,129,0.2)" : key.trim() ? `${provider.color}25` : "rgba(255,255,255,0.06)",
            color: saved ? "#10B981" : key.trim() ? provider.color : "var(--color-text-secondary)",
            fontSize: "12px", fontWeight: 600, cursor: key.trim() ? "pointer" : "not-allowed",
            flexShrink: 0, transition: "all 0.15s", display: "flex", alignItems: "center", gap: "4px",
          }}
        >
          {saved ? <><CheckCircle size={12} /> {t("apiKeySaved") || "✓ Saved"}</> : (t("apiKeySave") || "Save")}
        </button>
      </div>

      {/* Model picker — live list from the provider's API; empty selection = provider default */}
      {isConfigured && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
          <select
            value={model}
            onChange={e => pickModel(e.target.value)}
            onFocus={() => { if (!models.length && !modelsLoading) loadModels(key); }}
            style={{ flex: 1, padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none" }}
          >
            <option value="">{t("aiModelDefaultOpt")} ({provider.model})</option>
            {model && !models.some(m => m.id === model) && <option value={model}>{model}</option>}
            {models.map(m => <option key={m.id} value={m.id}>{m.label !== m.id ? `${m.label} — ${m.id}` : m.id}</option>)}
          </select>
          <button
            onClick={() => loadModels(key)}
            title={t("aiModelRefresh")}
            style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", flexShrink: 0 }}
          >
            <Sparkles size={12} className={modelsLoading ? "spin" : undefined} /> {modelsLoading ? "…" : t("aiModelRefresh")}
          </button>
        </div>
      )}
      {isConfigured && modelsErr && (
        <div style={{ fontSize: "11px", color: "#f87171", marginBottom: "8px" }}>{t("aiModelLoadFail")}</div>
      )}

      {/* Z.AI ships the same models behind two products on ONE account key, and the endpoint is
          what decides which balance a request spends. Sending app traffic to the Coding Plan
          endpoint burns that plan's 5-hour quota (and Z.AI limits the plan to supported coding
          tools), while the general endpoint bills the pay-as-you-go balance. Nothing in the key
          itself reveals the choice, so it has to be made here. */}
      {provider.id === "zai" && (
        <div style={{ marginBottom: "10px" }}>
          <select
            value={endpoint}
            onChange={e => {
              const v = e.target.value;
              setEndpoint(v);
              if (v) localStorage.setItem("aiBaseUrl_zai", v); else localStorage.removeItem("aiBaseUrl_zai");
            }}
            style={{ width: "100%", padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px" }}
          >
            <option value="">{t("zaiEndpointGeneral" as never)}</option>
            <option value="https://api.z.ai/api/anthropic">{t("zaiEndpointCoding" as never)}</option>
          </select>
          <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "5px", lineHeight: 1.5 }}>
            {t("zaiEndpointHint" as never)}
          </div>
        </div>
      )}

      {/* Hint + link */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{provider.hint}</span>
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: "11px", color: "var(--color-accent-blue)", display: "flex", alignItems: "center", gap: "3px", textDecoration: "none", flexShrink: 0 }}
        >
          Get key ↗
        </a>
      </div>
    </div>
  );
}

function AIConfigSection() {
  const { t } = useLanguage();
  return (
    <SectionCard>
      <SectionTitle
        icon={<Zap size={17} color="#8B5CF6" />}
        title="AI Providers"
        sub="Connect an AI provider to enable intelligent clustering in One Click Setup. The AI analyzes your GSC queries and URLs to create meaningful topic clusters and content groups — much more accurate than the algorithmic fallback."
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {AI_PROVIDERS.map(p => <AIProviderCard key={p.id} provider={p} />)}
      </div>
      <div style={{ marginTop: "14px", padding: "11px 14px", borderRadius: "8px", background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.18)", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        💡 {t("aiKeysHint")}
      </div>
    </SectionCard>
  );
}

// ─── Section: Indexing API Keys ───────────────────────────────────────────────
function IndexApiSection() {
  const { t } = useLanguage();

  // NeuralIndexer state
  const [nnToken,      setNnToken]      = useState("");
  const [nnConfigured, setNnConfigured] = useState(false);
  const [nnStatus,     setNnStatus]     = useState<"idle"|"checking"|"ok"|"error">("idle");
  const [nnMsg,        setNnMsg]        = useState("");
  const [nnSaving,     setNnSaving]     = useState(false);
  const [nnSaved,      setNnSaved]      = useState(false);
  const [nnBalance,    setNnBalance]    = useState<number|null>(null);

  // XML River state
  const [xrUserId,  setXrUserId]  = useState("");
  const [xrApiKey,  setXrApiKey]  = useState("");
  const [xrStatus,  setXrStatus]  = useState<"idle"|"checking"|"ok"|"error">("idle");
  const [xrMsg,     setXrMsg]     = useState("");
  const [xrSaving,  setXrSaving]  = useState(false);
  const [xrSaved,   setXrSaved]   = useState(false);

  // 2index state
  const [niToken,      setNiToken]      = useState("");
  const [niConfigured, setNiConfigured] = useState(false);
  const [niStatus,     setNiStatus]     = useState<"idle"|"checking"|"ok"|"error">("idle");
  const [niMsg,        setNiMsg]        = useState("");
  const [niSaving,     setNiSaving]     = useState(false);
  const [niSaved,      setNiSaved]      = useState(false);
  const [niBalance,    setNiBalance]    = useState<number|null>(null);

  // Load existing (masked) state on mount
  useEffect(() => {
    fetch("/api/settings/api-keys")
      .then(r => r.json())
      .then(d => {
        // NOTE: we do NOT load masked tokens into input fields to avoid overwriting real tokens on save
        if (d.neuralIndexer?.configured)  { setNnConfigured(true); setNnStatus("ok"); setNnBalance(d.neuralIndexer.balance); }
        if (d.xmlRiver?.userId)           setXrUserId(d.xmlRiver.userId);
        // xrApiKey is masked — don't put it in the input; just track configured state
        if (d.xmlRiver?.configured)       setXrStatus("ok");
        if (d.twoIndex?.configured)       { setNiConfigured(true); setNiStatus("ok"); }
      })
      .catch(() => {});
  }, []);

  // NeuralIndexer actions
  const validateNn = async () => {
    setNnStatus("checking"); setNnMsg(""); setNnBalance(null);
    const res = await fetch("/api/settings/api-keys/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "neural", token: nnToken }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: "Network error" }));
    setNnStatus(res.ok ? "ok" : "error");
    setNnMsg(res.ok ? t("apiKeyTokenValid") : res.error ?? t("apiKeyError"));
    if (res.balance != null) setNnBalance(res.balance);
  };

  const saveNn = async () => {
    if (!nnToken) return; // don't save empty/masked value
    setNnSaving(true);
    await fetch("/api/settings/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ neuralIndexerToken: nnToken }),
    });
    setNnSaving(false); setNnSaved(true); setNnConfigured(true);
    setTimeout(() => setNnSaved(false), 2000);
  };

  const deleteNn = async () => {
    setNnSaving(true);
    await fetch("/api/settings/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ neuralIndexerToken: null }),
    });
    setNnToken(""); setNnConfigured(false); setNnStatus("idle"); setNnMsg(""); setNnBalance(null);
    setNnSaving(false);
  };

  const validateXr = async () => {
    setXrStatus("checking"); setXrMsg("");
    const res = await fetch("/api/settings/api-keys/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "xmlriver", userId: xrUserId, apiKey: xrApiKey }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: "Network error" }));
    setXrStatus(res.ok ? "ok" : "error");
    setXrMsg(res.ok ? t("apiKeyTokenValid") : res.error ?? t("apiKeyError"));
  };

  const saveXr = async () => {
    setXrSaving(true);
    await fetch("/api/settings/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xmlRiverUserId: xrUserId, xmlRiverApiKey: xrApiKey }),
    });
    setXrSaving(false); setXrSaved(true);
    setTimeout(() => setXrSaved(false), 2000);
  };

  const validateNi = async () => {
    setNiStatus("checking"); setNiMsg(""); setNiBalance(null);
    const res = await fetch("/api/settings/api-keys/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "2index", token: niToken }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: "Network error" }));
    setNiStatus(res.ok ? "ok" : "error");
    setNiMsg(res.ok ? t("apiKeyTokenValid") : res.error ?? t("apiKeyError"));
    if (res.balance != null) setNiBalance(res.balance);
  };

  const saveNi = async () => {
    if (!niToken) return;
    setNiSaving(true);
    await fetch("/api/settings/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ twoIndexToken: niToken }),
    });
    setNiSaving(false); setNiSaved(true); setNiConfigured(true);
    setTimeout(() => setNiSaved(false), 2000);
  };

  const deleteNi = async () => {
    setNiSaving(true);
    await fetch("/api/settings/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ twoIndexToken: null }),
    });
    setNiToken(""); setNiConfigured(false); setNiStatus("idle"); setNiMsg(""); setNiBalance(null);
    setNiSaving(false);
  };

  const statusColor = (s: string) => s === "ok" ? "#10B981" : s === "error" ? "#EF4444" : s === "checking" ? "#F59E0B" : "var(--color-text-secondary)";
  const statusDot   = (s: string) => s === "ok" ? "●" : s === "error" ? "●" : s === "checking" ? "◌" : "○";
  const statusLabel = (s: string) => s === "ok" ? t("apiKeyConfigured") : s === "error" ? t("apiKeyError") : s === "checking" ? t("apiKeyChecking") : t("apiKeyNotConfigured");

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: "9px 12px", background: "transparent",
    border: "none", color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
    fontFamily: "monospace",
  };
  const rowStyle: React.CSSProperties = {
    display: "flex", gap: "0", border: "1px solid var(--color-border)",
    borderRadius: "8px", overflow: "hidden", marginBottom: "10px",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "5px", display: "block",
  };
  /* Apple-style pill buttons — primary = solid Action Blue, secondary = ghost */
  const btnStyle = (primary?: boolean): React.CSSProperties => ({
    padding: "8px 18px",
    borderRadius: "9999px",
    border: primary ? "none" : "1px solid var(--color-border)",
    background: primary ? "var(--color-accent-blue)" : "transparent",
    color: primary ? "#ffffff" : "var(--color-text-primary)",
    fontSize: "13px", fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap",
    transition: "opacity 0.15s, background 0.15s",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

      {/* ── NeuralIndexer (featured / primary) ── */}
      <SectionCard>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ width: 32, height: 32, borderRadius: "8px", background: "linear-gradient(135deg,rgba(139,92,246,0.25),rgba(59,130,246,0.25))", border: "1px solid rgba(139,92,246,0.35)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 800, color: "#a78bfa" }}>NI</div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>NeuralIndexer</span>
                  <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 7px", borderRadius: "6px", background: "rgba(139,92,246,0.15)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.3)" }}>{t("apiKeyPrimary")}</span>
                </div>
                <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
                  {t("nnBotDesc")}
                </p>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: statusColor(nnStatus) }}>
              {statusDot(nnStatus)} {statusLabel(nnStatus)}
            </span>
            {nnBalance != null && (
              <span style={{ fontSize: "12px", fontWeight: 700, color: "#4ADE80" }}>${nnBalance.toFixed(4)}</span>
            )}
          </div>
        </div>

        {/* Info strip */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
          {[
            { label: "Slow (Google+Bing)", price: "$0.0122/URL" },
            { label: "Fast (Google API)", price: "$0.50/URL" },
            { label: "Yandex", price: "$0.0122/URL" },
            { label: "Index check", price: "$0.0024/URL" },
          ].map(({ label, price }) => (
            <div key={label} style={{ padding: "4px 10px", borderRadius: "7px", background: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.18)", fontSize: "11px", color: "var(--color-text-secondary)" }}>
              {label} <span style={{ color: "#a78bfa", fontWeight: 600 }}>{price}</span>
            </div>
          ))}
        </div>

        <label style={labelStyle}>API Token</label>
        {nnConfigured && !nnToken && (
          <p style={{ fontSize: "12px", color: "#4ADE80", marginBottom: "8px" }}>✓ {t("apiKeyConfigured")} · {t("apiKeyEnterToReplace")}</p>
        )}
        <div style={rowStyle}>
          <input value={nnToken} onChange={e => setNnToken(e.target.value)}
            placeholder={nnConfigured ? t("apiKeyEnterToReplace") : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
            type="password" style={inputStyle} />
        </div>

        {nnMsg && <p style={{ fontSize: "12px", color: statusColor(nnStatus), marginBottom: "10px" }}>{nnMsg}</p>}

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={validateNn} disabled={!nnToken || nnStatus === "checking"}
            style={{ ...btnStyle(), opacity: !nnToken ? 0.4 : 1 }}>
            {nnStatus === "checking" ? t("apiKeyChecking") : t("apiKeyVerify")}
          </button>
          <button onClick={saveNn} disabled={!nnToken || nnSaving}
            style={{ ...btnStyle(true), opacity: !nnToken ? 0.4 : 1 }}>
            {nnSaved ? t("apiKeySaved") : nnSaving ? t("apiKeySaving") : t("apiKeySave")}
          </button>
          {nnConfigured && (
            <button onClick={deleteNn} disabled={nnSaving}
              style={{ padding: "9px 12px", background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "8px", color: "#EF4444", fontSize: "12px", cursor: "pointer" }}>
              {t("apiKeyDelete")}
            </button>
          )}
          <a href="https://t.me/InderixingBot" target="_blank" rel="noopener noreferrer"
            style={{ marginLeft: "auto", fontSize: "12px", color: "#a78bfa", textDecoration: "none", display: "flex", alignItems: "center", gap: "4px" }}
            onMouseOver={e => e.currentTarget.style.textDecoration = "underline"}
            onMouseOut={e => e.currentTarget.style.textDecoration = "none"}>
            {t("nnGetToken")}
          </a>
        </div>
      </SectionCard>

      {/* ── XML River ── */}
      <SectionCard>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: 28, height: 28, borderRadius: "6px", background: "rgba(59,130,246,0.15)", border: "1px solid rgba(59,130,246,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 800, color: "#3B82F6" }}>XR</div>
              <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>XML River API</span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "6px", maxWidth: "480px", lineHeight: 1.5 }}>
              {t("xrDesc")}{" "}
              <a href="https://xmlriver.com" target="_blank" rel="noopener noreferrer" style={{ color: "#3B82F6" }}>xmlriver.com</a>
            </p>
          </div>
          <span style={{ fontSize: "12px", fontWeight: 600, color: statusColor(xrStatus) }}>
            {statusDot(xrStatus)} {statusLabel(xrStatus)}
          </span>
        </div>

        <label style={labelStyle}>User ID</label>
        <div style={rowStyle}>
          <input value={xrUserId} onChange={e => setXrUserId(e.target.value)} placeholder="12345" style={inputStyle} />
        </div>

        <label style={labelStyle}>API Key</label>
        <div style={rowStyle}>
          <input value={xrApiKey} onChange={e => setXrApiKey(e.target.value)} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" type="password" style={inputStyle} />
        </div>

        {xrMsg && <p style={{ fontSize: "12px", color: statusColor(xrStatus), marginBottom: "10px" }}>{xrMsg}</p>}

        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={validateXr} disabled={!xrUserId || !xrApiKey || xrStatus === "checking"} style={{ ...btnStyle(), opacity: (!xrUserId || !xrApiKey) ? 0.4 : 1 }}>
            {xrStatus === "checking" ? t("apiKeyChecking") : t("apiKeyVerify")}
          </button>
          <button onClick={saveXr} disabled={!xrUserId || !xrApiKey || xrSaving} style={{ ...btnStyle(true), opacity: (!xrUserId || !xrApiKey) ? 0.4 : 1 }}>
            {xrSaved ? t("apiKeySaved") : xrSaving ? t("apiKeySaving") : t("apiKeySave")}
          </button>
          {(xrUserId || xrApiKey) && (
            <button onClick={() => { setXrUserId(""); setXrApiKey(""); setXrStatus("idle"); setXrMsg(""); saveXr(); }}
              style={{ padding: "9px 12px", background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "8px", color: "#EF4444", fontSize: "12px", cursor: "pointer" }}>
              {t("apiKeyDelete")}
            </button>
          )}
        </div>
      </SectionCard>

      {/* ── 2index.ninja ── */}
      <SectionCard>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: 28, height: 28, borderRadius: "6px", background: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 800, color: "#10B981" }}>2I</div>
              <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>2index.ninja API</span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "6px", maxWidth: "480px", lineHeight: 1.5 }}>
              {t("niDesc")}{" "}
              <a href="https://2index.ninja" target="_blank" rel="noopener noreferrer" style={{ color: "#10B981" }}>2index.ninja</a>
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: statusColor(niStatus) }}>
              {statusDot(niStatus)} {statusLabel(niStatus)}
            </span>
            {niBalance != null && (
              <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("balanceLabel")}: {niBalance}</span>
            )}
          </div>
        </div>

        <label style={labelStyle}>Bearer token</label>
        {niConfigured && !niToken && (
          <p style={{ fontSize: "12px", color: "#4ADE80", marginBottom: "8px" }}>✓ {t("apiKeyConfigured")} · {t("apiKeyEnterToReplace")}</p>
        )}
        <div style={rowStyle}>
          <input value={niToken} onChange={e => setNiToken(e.target.value)} placeholder={niConfigured ? t("apiKeyEnterToReplace") : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"} type="password" style={inputStyle} />
        </div>

        {niMsg && <p style={{ fontSize: "12px", color: statusColor(niStatus), marginBottom: "10px" }}>{niMsg}</p>}

        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={validateNi} disabled={!niToken || niStatus === "checking"} style={{ ...btnStyle(), opacity: !niToken ? 0.4 : 1 }}>
            {niStatus === "checking" ? t("apiKeyChecking") : t("apiKeyVerify")}
          </button>
          <button onClick={saveNi} disabled={!niToken || niSaving} style={{ ...btnStyle(true), opacity: !niToken ? 0.4 : 1 }}>
            {niSaved ? t("apiKeySaved") : niSaving ? t("apiKeySaving") : t("apiKeySave")}
          </button>
          {niConfigured && (
            <button onClick={deleteNi} disabled={niSaving}
              style={{ padding: "9px 12px", background: "transparent", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "8px", color: "#EF4444", fontSize: "12px", cursor: "pointer" }}>
              {t("apiKeyDelete")}
            </button>
          )}
        </div>
      </SectionCard>

      {/* ── IndexNow key ── */}
      <SectionCard>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: 28, height: 28, borderRadius: "6px", background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 800, color: "#7C3AED" }}>IN</div>
            <div>
              <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>IndexNow</span>
              <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
                {t("indexNowDesc")}{" "}
                <a href="https://github.com/fenjo26/opengsc/blob/main/docs/SEARCH-ENGINES-SETUP.md" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>{t("seSetupGuide")}</a>
              </p>
            </div>
          </div>
          <LocalKeyField storageKey="seoKey_indexnow" placeholder="IndexNow key (hex)" />
        </div>
      </SectionCard>

      {/* ── Microsoft Clarity (note: token is per-site, configured in site UX tab) ── */}
      <SectionCard>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: 28, height: 28, borderRadius: "6px", background: "rgba(0,102,204,0.12)", border: "1px solid rgba(0,102,204,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 800, color: "var(--color-accent-blue)" }}>MC</div>
            <div>
              <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>Microsoft Clarity</span>
              <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("claritySettingsNote")}</p>
            </div>
          </div>
          <a href="#" onClick={e => { e.preventDefault(); }} style={{
            fontSize: "11px", fontWeight: 600, padding: "4px 10px", borderRadius: "9999px",
            background: "rgba(0,102,204,0.10)", color: "var(--color-accent-blue)",
            border: "1px solid rgba(0,102,204,0.25)", textDecoration: "none",
            display: "inline-flex", alignItems: "center", gap: "4px",
          }}>
            {t("claritySettingsWhere")}
          </a>
        </div>
      </SectionCard>
    </div>
  );
}

// ─── Section: Health API Keys ─────────────────────────────────────────────────
const HEALTH_PROVIDERS = [
  {
    id: "safeBrowsing",
    name: "Google Safe Browsing",
    placeholder: "AIzaSy...",
    hint: "Detects malware, phishing, and harmful content on your site.",
    docsUrl: "https://developers.google.com/safe-browsing/v4/get-started",
    color: "#4285F4",
    logo: "SB",
    storageKey: "healthKey_safeBrowsing",
  },
  {
    id: "google",
    name: "PageSpeed Insights (Core Web Vitals)",
    placeholder: "AIzaSy...",
    hint: "Fetches LCP, INP, CLS, TTFB and overall Performance score via PageSpeed Insights API.",
    docsUrl: "https://developers.google.com/speed/docs/insights/v5/get-started",
    color: "#34A853",
    logo: "PS",
    storageKey: "healthKey_google",
  },
  {
    id: "virusTotal",
    name: "VirusTotal",
    placeholder: "abc123...",
    hint: "Scans domain against 70+ antivirus engines and URL scanners.",
    docsUrl: "https://www.virustotal.com/gui/my-apikey",
    color: "#1565C0",
    logo: "VT",
    storageKey: "healthKey_virusTotal",
  },
] as const;

function HealthKeyCard({ provider }: { provider: typeof HEALTH_PROVIDERS[number] }) {
  const { t } = useLanguage();
  const [key, setKey]       = useState("");
  const [visible, setVisible] = useState(false);
  const [saved, setSaved]   = useState(false);
  const isConfigured = key.trim().length > 6;

  useEffect(() => { setKey(localStorage.getItem(provider.storageKey) || ""); }, [provider.storageKey]);

  const handleSave = () => {
    localStorage.setItem(provider.storageKey, key.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  const handleClear = () => { setKey(""); localStorage.removeItem(provider.storageKey); };

  return (
    <div style={{ padding: "16px", borderRadius: "10px", border: `1px solid ${isConfigured ? `${provider.color}40` : "var(--color-border)"}`, background: isConfigured ? `${provider.color}08` : "rgba(255,255,255,0.02)", transition: "all 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
        <div style={{ width: "30px", height: "30px", borderRadius: "8px", background: `${provider.color}20`, border: `1px solid ${provider.color}40`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 700, color: provider.color, flexShrink: 0 }}>
          {provider.logo}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{provider.name}</div>
        </div>
        {isConfigured ? (
          <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#10B981", fontWeight: 600, flexShrink: 0 }}>
            <CheckCircle size={12} color="#10B981" /> {t("scConnected") || "Connected"}
          </span>
        ) : (
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", flexShrink: 0 }}>{t("apiKeyNotConfigured") || "Not set"}</span>
        )}
      </div>
      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
        <div style={{ flex: 1, position: "relative" }}>
          <input
            type={visible ? "text" : "password"}
            placeholder={provider.placeholder}
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSave()}
            style={{ width: "100%", padding: "8px 36px 8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", boxSizing: "border-box", fontFamily: "monospace" }}
          />
          <button onClick={() => setVisible(v => !v)} style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 0, display: "flex", alignItems: "center" }}>
            <Eye size={14} style={{ opacity: visible ? 1 : 0.5 }} />
          </button>
        </div>
        {isConfigured && (
          <button onClick={handleClear} style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.08)", color: "#f87171", fontSize: "12px", cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center" }} title={t("apiKeyDelete") || "Remove key"}>
            <X size={13} />
          </button>
        )}
        <button onClick={handleSave} disabled={!key.trim()} style={{ padding: "8px 14px", borderRadius: "8px", border: "none", background: saved ? "rgba(16,185,129,0.2)" : key.trim() ? `${provider.color}25` : "rgba(255,255,255,0.06)", color: saved ? "#10B981" : key.trim() ? provider.color : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: key.trim() ? "pointer" : "not-allowed", flexShrink: 0, transition: "all 0.15s", display: "flex", alignItems: "center", gap: "4px" }}>
          {saved ? <><CheckCircle size={12} /> {t("apiKeySaved") || "✓ Saved"}</> : (t("apiKeySave") || "Save")}
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{provider.hint}</span>
        <a href={provider.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: "11px", color: "var(--color-accent-blue)", display: "flex", alignItems: "center", gap: "3px", textDecoration: "none", flexShrink: 0 }}>{t("healthGetKey") || "Get key ↗"}</a>
      </div>
    </div>
  );
}

function HealthApiKeysSection() {
  const { t } = useLanguage();
  return (
    <SectionCard>
      <SectionTitle
        icon={<CheckCircle size={17} color="#10B981" />}
        title={t("healthApiKeysTitle") || "Health Check API Keys"}
        sub={t("healthApiKeysSub") || "Used in the Health tab on each site page. SSL is always checked for free. Add keys below to enable Safe Browsing, Core Web Vitals, and VirusTotal checks."}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {HEALTH_PROVIDERS.map(p => <HealthKeyCard key={p.id} provider={p} />)}
      </div>
      <div style={{ marginTop: "14px", padding: "11px 14px", borderRadius: "8px", background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.18)", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        {t("healthApiKeysHint")}
      </div>
    </SectionCard>
  );
}

// ─── Section: API Keys (unified) ──────────────────────────────────────────────
// Single place for every external provider key used across the app: AI providers
// (content generation / One Click Setup clustering), SEO Tools' SERP + AEO/AI
// Visibility providers, and Health-check providers. Previously split across
// Preferences and SEO Tools, which was confusing — everything lives here now.
function ApiKeysSection() {
  const { t } = useLanguage();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ padding: "12px 16px", borderRadius: "8px", border: "1px solid rgba(59,130,246,0.25)", background: "rgba(59,130,246,0.06)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
        💡 {t("apiKeysHubDesc")}
      </div>
      <AIConfigSection />
      <SectionCard><SeoProviderKeysSection /></SectionCard>
      <SectionCard><AeoProviderKeysSection /></SectionCard>
      <HealthApiKeysSection />
    </div>
  );
}

// ─── Section: Super Sites ─────────────────────────────────────────────────────
interface GscSite { id: string; url: string; siteId: string; }

function SuperSitesSection() {
  const { t } = useLanguage();
  const [superSites, setSuperSites] = useState<string[]>([]);
  const [allSites, setAllSites] = useState<GscSite[]>([]);
  const [loadingSites, setLoadingSites] = useState(true);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    fetch("/api/gsc/sites")
      .then(r => r.json())
      .then(data => setAllSites(data.sites || []))
      .catch(() => {})
      .finally(() => setLoadingSites(false));
  }, []);

  const cleanDomain = (url: string) =>
    url.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/^sc-domain:/, "");

  const suggestions = allSites.filter(s =>
    !superSites.includes(s.url) &&
    cleanDomain(s.url).toLowerCase().includes(query.toLowerCase())
  );

  const showDropdown = focused && query.length > 0;

  const addFromGsc = (url: string) => {
    if (!superSites.includes(url)) setSuperSites(prev => [...prev, url]);
    setQuery("");
  };

  const addManual = () => {
    const trimmed = query.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!trimmed || superSites.includes(trimmed)) return;
    setSuperSites(prev => [...prev, trimmed]);
    setQuery("");
  };

  const remove = (url: string) => setSuperSites(prev => prev.filter(s => s !== url));

  const searchPlaceholder = loadingSites
    ? t("loadingGscProps")
    : allSites.length > 0
      ? t("searchGscProps").replace("{n}", String(allSites.length))
      : t("enterDomainToAdd");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <SectionCard>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
          <Star size={17} color="#F59E0B" />
          <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("superSites")}</h2>
          {superSites.length > 0 && (
            <span style={{ fontSize: "11px", color: "#F59E0B", background: "rgba(245,158,11,0.1)", borderRadius: "20px", padding: "2px 8px", fontWeight: 600 }}>
              {superSites.length} {t("upgraded")}
            </span>
          )}
        </div>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.7, marginBottom: "20px" }}>
          {t("superSitesDesc")}
        </p>

        {/* Combined search + picker */}
        <div style={{ position: "relative", marginBottom: "20px" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: "8px",
            padding: "0 14px",
            borderRadius: showDropdown ? "10px 10px 0 0" : "10px",
            borderTop: `1px solid ${focused ? "#F59E0B" : "var(--color-border)"}`,
            borderLeft: `1px solid ${focused ? "#F59E0B" : "var(--color-border)"}`,
            borderRight: `1px solid ${focused ? "#F59E0B" : "var(--color-border)"}`,
            borderBottom: showDropdown ? "1px solid var(--color-border)" : `1px solid ${focused ? "#F59E0B" : "var(--color-border)"}`,
            background: "rgba(255,255,255,0.04)",
            transition: "border-color 0.15s",
          }}>
            <span style={{ fontSize: "14px", opacity: 0.5, flexShrink: 0 }}>🔍</span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  if (suggestions.length > 0) addFromGsc(suggestions[0].url);
                  else addManual();
                }
              }}
              placeholder={searchPlaceholder}
              disabled={loadingSites}
              style={{
                flex: 1, padding: "10px 0",
                background: "transparent", border: "none",
                color: "var(--color-text-primary)", fontSize: "13px",
                fontFamily: "inherit", outline: "none",
              }}
            />
            {query && (
              <button
                onMouseDown={e => { e.preventDefault(); addManual(); }}
                style={{
                  flexShrink: 0, padding: "4px 10px", borderRadius: "6px",
                  background: "rgba(245,158,11,0.1)", color: "#F59E0B",
                  border: "1px solid rgba(245,158,11,0.25)",
                  fontSize: "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                }}
              >{t("addManual")}</button>
            )}
          </div>

          {/* Dropdown suggestions */}
          {showDropdown && (
            <div style={{
              position: "absolute", top: "100%", left: 0, right: 0,
              background: "var(--color-card)",
              border: "1px solid #F59E0B",
              borderTop: "none",
              borderRadius: "0 0 10px 10px",
              zIndex: 50,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              maxHeight: "240px", overflowY: "auto",
            }}>
              {suggestions.length > 0 ? suggestions.map(site => (
                <button
                  key={site.id}
                  onMouseDown={e => { e.preventDefault(); addFromGsc(site.url); }}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: "10px",
                    padding: "9px 14px", background: "transparent",
                    border: "none", cursor: "pointer", textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = "rgba(245,158,11,0.07)")}
                  onMouseOut={e => (e.currentTarget.style.background = "transparent")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/favicon?domain=${cleanDomain(site.url)}`} width={14} height={14} alt="" style={{ borderRadius: "3px", flexShrink: 0 }} onError={e=>((e.target as HTMLImageElement).style.display="none")} />
                  <span style={{ fontSize: "13px", color: "var(--color-text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {cleanDomain(site.url)}
                  </span>
                  <span style={{ fontSize: "11px", color: "#F59E0B", flexShrink: 0 }}>{t("upgradeLabel")}</span>
                </button>
              )) : (
                <div style={{ padding: "11px 14px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
                  {t("noGscMatch")}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Upgraded list */}
        {superSites.length === 0 ? (
          <div style={{ padding: "24px", borderRadius: "10px", border: "1px dashed var(--color-border)", textAlign: "center" }}>
            <div style={{ fontSize: "22px", marginBottom: "8px" }}>⭐</div>
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {t("noSuperSitesYet")}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {superSites.map(site => (
              <div key={site} style={{
                display: "flex", alignItems: "center", gap: "10px",
                padding: "10px 12px",
                background: "rgba(245,158,11,0.05)",
                border: "1px solid rgba(245,158,11,0.15)",
                borderRadius: "8px",
              }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/favicon?domain=${cleanDomain(site)}`} width={16} height={16} alt="" style={{ borderRadius: "3px" }} onError={e=>((e.target as HTMLImageElement).style.display="none")} />
                <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", flex: 1 }}>{cleanDomain(site)}</span>
                <Star size={12} color="#F59E0B" />
                <button
                  onClick={() => remove(site)}
                  style={{
                    padding: "4px 10px", borderRadius: "6px",
                    background: "rgba(239,68,68,0.08)", color: "#f87171",
                    border: "1px solid rgba(239,68,68,0.2)",
                    fontSize: "11px", fontWeight: 600, cursor: "pointer",
                  }}
                >{t("remove")}</button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const { data: session } = useSession();
  const user = session?.user;

  const [nav, setNav] = useState<NavItem>("accounts");
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [editingTeam, setEditingTeam] = useState(false);

  const defaultTeamName = user?.name ? `${user.name.split(" ")[0]}'s Team` : "My Team";

  // Deep-link support (e.g. /settings?tab=seo-tools from the SEO Tools pages) — read via
  // window.location in an effect rather than useSearchParams(), so this stays a plain client
  // render with no SSR/hydration mismatch and no Suspense-boundary requirement.
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    const valid: NavItem[] = [
      "accounts", "bing", "yandex", "api", "api-keys", "indexing-api", "metrics",
      "seo-tools", "notifications", "preferences",
      "members",
      ...(EXPERIMENTAL_TEAM_UI ? ["teams", "supersites"] as NavItem[] : []),
    ];
    if (tab && (valid as string[]).includes(tab)) setNav(tab as NavItem);
  }, []);

  const fetchAccounts = async () => {
    setLoadingAccounts(true);
    try { const res = await fetch("/api/gsc/accounts"); const data = await res.json(); setAccounts(data.accounts || []); } catch {}
    setLoadingAccounts(false);
  };
  useEffect(() => { fetchAccounts(); }, []);

  const handleAdd = () => signIn("google", { callbackUrl: "/settings" });
  const handleReauth = (email: string) =>
    signIn("google", { callbackUrl: "/settings", login_hint: email });
  const handleRemove = async (id: string) => {
    if (!confirm(t("disconnectConfirm"))) return;
    setRemoving(id);
    await fetch("/api/gsc/accounts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: id }) });
    await fetchAccounts();
    setRemoving(null);
  };

  const NavBtn = ({ id, icon, label, badge }: { id: NavItem; icon: React.ReactNode; label: string; badge?: string }) => (
    <button
      onClick={() => setNav(id)}
      className={nav === id ? "nav-btn active" : "nav-btn"}
      style={{
        display: "flex", alignItems: "center", gap: "10px",
        padding: "8px 12px", borderRadius: "8px", width: "100%",
        background: "transparent", color: nav === id ? "#fff" : "var(--color-text-secondary)",
        fontSize: "13px", fontWeight: 400, border: "none", cursor: "pointer", textAlign: "left",
      }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {badge && <span style={{ fontSize: "10px", color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.07)", borderRadius: "10px", padding: "1px 7px" }}>{badge}</span>}
    </button>
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Page header */}
      <div style={{ padding: "20px 32px 0" }}>
        <button onClick={() => router.push("/")} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "var(--color-accent-blue)", background: "none", border: "none", cursor: "pointer", marginBottom: "8px" }}>
          <ArrowLeft size={14} /> {t("back")}
        </button>
        <h1 style={{ fontSize: "26px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.02em" }}>{t("settingsTitle")}</h1>
      </div>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, gap: 0, padding: "24px 32px", alignItems: "flex-start" }}>

        {/* Left sidebar */}
        <div style={{ width: "200px", flexShrink: 0, paddingRight: "24px" }}>
          {/* Account */}
          <div style={{ marginBottom: "28px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "2px" }}>{t("sidebarAccount")}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{user?.email}</div>
            <NavBtn id="accounts" icon={<GoogleIcon size={14} />} label={t("navMyGoogleAccounts")} />
            <NavBtn id="bing" icon={<BingIcon size={14} />} label="Bing Webmaster" />
            <NavBtn id="yandex" icon={<YandexIcon size={14} />} label="Яндекс.Вебмастер" />
            {EXPERIMENTAL_TEAM_UI && <NavBtn id="teams" icon={<Users size={14} />} label={t("myTeams")} />}
            <NavBtn id="api-keys" icon={<KeyRound size={14} />} label={t("navApiKeys")} />
            <NavBtn id="api" icon={<Key size={14} />} label={t("navApiMcpKeys")} />
            <NavBtn id="indexing-api" icon={<Globe size={14} />} label={t("navIndexingApi")} />
            <NavBtn id="metrics" icon={<BarChart3 size={14} />} label={t("navMetrics")} />
            <NavBtn id="seo-tools" icon={<Sparkles size={14} />} label={t("navSeoTools")} />
            <NavBtn id="notifications" icon={<Zap size={14} />} label={t("navNotifications")} />
          </div>

          {/* Team */}
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "2px" }}>
              {EXPERIMENTAL_TEAM_UI ? t("sidebarTeam") : t("sidebarInstance")}
            </div>
            {EXPERIMENTAL_TEAM_UI ? <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" }}>
              {editingTeam ? (
                <input
                  autoFocus value={teamName || defaultTeamName}
                  onChange={e => setTeamName(e.target.value)}
                  onBlur={() => setEditingTeam(false)}
                  onKeyDown={e => e.key === "Enter" && setEditingTeam(false)}
                  style={{ fontSize: "12px", color: "var(--color-text-primary)", background: "transparent", border: "none", borderBottom: "1px solid var(--color-accent-blue)", outline: "none", width: "120px", padding: "1px 0" }}
                />
              ) : (
                <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{teamName || defaultTeamName}</span>
              )}
              <Edit2 size={11} style={{ color: "var(--color-text-secondary)", cursor: "pointer", flexShrink: 0 }} onClick={() => setEditingTeam(true)} />
            </div> : (
              <div style={{ fontSize: "11px", lineHeight: 1.45, color: "var(--color-text-secondary)", marginBottom: "10px" }}>
                {t("workspaceSidebarHint")}
              </div>
            )}
            <NavBtn id="members" icon={<Users size={14} />} label={t("navTeamMembers")} />
            <NavBtn id="preferences" icon={<Settings size={14} />} label={t("navPreferences")} />
            {EXPERIMENTAL_TEAM_UI && <NavBtn id="supersites" icon={<Star size={14} />} label={t("navSuperSites")} />}
          </div>
        </div>

        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {nav === "accounts"     && <AccountsSection user={user} accounts={accounts} loadingAccounts={loadingAccounts} removing={removing} onAdd={handleAdd} onRemove={handleRemove} onReauth={handleReauth} />}
          {nav === "bing"         && (
            <SectionCard>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                <div style={{ width: 28, height: 28, borderRadius: "6px", background: "rgba(0,131,115,0.10)", border: "1px solid rgba(0,131,115,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}><BingIcon size={18} /></div>
                <div>
                  <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>Bing Webmaster API</h2>
                  <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px", margin: 0 }}>
                    {t("bingDesc") || "Used to fetch traffic stats and submit sitemaps directly to Bing Webmaster Tools."}{" "}
                    <a href="https://www.bing.com/webmasters" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>bing.com/webmasters</a>
                    {" · "}
                    <a href="https://github.com/fenjo26/opengsc/blob/main/docs/SEARCH-ENGINES-SETUP.md" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>{t("seSetupGuide")}</a>
                  </p>
                </div>
              </div>
              <BingAccountsManager />
            </SectionCard>
          )}
          {nav === "yandex"       && (
            <SectionCard>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                <div style={{ width: 28, height: 28, borderRadius: "6px", background: "rgba(214,30,59,0.10)", border: "1px solid rgba(214,30,59,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}><YandexIcon size={18} /></div>
                <div>
                  <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>Яндекс.Вебмастер API</h2>
                  <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px", margin: 0 }}>
                    {t("yandexDesc")}{" "}
                    <a href="https://oauth.yandex.ru" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>oauth.yandex.ru</a>
                    {" · "}
                    <a href="https://github.com/fenjo26/opengsc/blob/main/docs/SEARCH-ENGINES-SETUP.md" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)" }}>{t("seSetupGuide")}</a>
                  </p>
                </div>
              </div>
              <YandexAccountsManager />
            </SectionCard>
          )}
          {EXPERIMENTAL_TEAM_UI && nav === "teams" && <TeamsSection user={user} />}
          {nav === "api-keys"     && <ApiKeysSection />}
          {nav === "api"          && <ApiSection />}
          {nav === "indexing-api" && <IndexApiSection />}
          {nav === "metrics"      && <MetricsSettingsSection />}
          {nav === "seo-tools"    && <SeoToolsSettings />}
          {nav === "notifications" && <NotificationsSection />}
          {nav === "members" && <TeamMembersPanel />}
          {nav === "preferences"  && <PreferencesSection user={user} />}
          {EXPERIMENTAL_TEAM_UI && nav === "supersites" && <SuperSitesSection />}
        </div>
      </div>

    </div>
  );
}
