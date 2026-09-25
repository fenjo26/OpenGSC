"use client";

// Wave-oct T3 — delivery channels (Discord / Teams / SMTP e-mail / generic webhook) under the
// existing Telegram and Slack blocks in Settings → Notifications. Secrets never come back from
// the server: the card edits a local draft and sends only what changed ("" = keep, notifyChKeep).

import { useEffect, useState } from "react";
import { CheckCircle, ChevronDown, X, Zap } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { NOTIFY_EVENTS } from "@/lib/notify/types";
import type { NotifyChannelView, NotifyEvent } from "@/lib/notify/types";

type StoredId = "discord" | "teams" | "email" | "webhook";

interface Draft {
  on: boolean;
  events: NotifyEvent[];
  url: string;
  secret: string;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

const seedDraft = (view: NotifyChannelView | undefined): Draft => ({
  on: view?.configured ? view.on : true,
  events: view?.events ?? [],
  url: "", secret: "",
  host: "", port: "587", secure: false,
  user: "", pass: "", from: "", to: "",
});

const input: React.CSSProperties = {
  flex: 1, minWidth: "180px", padding: "8px 11px", borderRadius: "8px",
  border: "1px solid var(--color-border)", background: "var(--color-bg)",
  color: "var(--color-text-primary)", fontSize: "12px", fontFamily: "monospace", outline: "none",
};
const label: React.CSSProperties = { fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "4px", display: "block" };
const smallBtn: React.CSSProperties = {
  padding: "8px 14px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: "pointer",
};

// Event multi-select shared by every channel row (and by the Telegram/Slack blocks on the page).
export function EventPicker({ events, onToggle }: { events: NotifyEvent[]; onToggle: (e: NotifyEvent) => void }) {
  const { t } = useLanguage();
  // wave-nov (N0): lead (N9), local (N3/N4), trend (N5) widened NotifyEvent — minimal labels
  // so the exhaustive Record compiles; N10 restyles this card together with the push row.
  const labelFor: Record<NotifyEvent, string> = {
    alert: t("notifyEv_alert"), digest: t("notifyEv_digest"), uptime: t("notifyEv_uptime"),
    index: t("notifyEv_index"), mention: t("notifyEv_mention"), test: "",
    lead: t("notifyEv_lead"), local: t("notifyEv_local"), trend: t("notifyEv_trend"),
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      {NOTIFY_EVENTS.map(ev => {
        const active = events.includes(ev);
        return (
          <button key={ev} type="button" onClick={() => onToggle(ev)} aria-pressed={active}
            style={{
              padding: "4px 11px", borderRadius: "20px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
              background: active ? "rgba(59,130,246,0.15)" : "transparent",
              color: active ? "#3B82F6" : "var(--color-text-secondary)",
              border: `1px solid ${active ? "rgba(59,130,246,0.35)" : "var(--color-border)"}`,
            }}>
            {labelFor[ev]}
          </button>
        );
      })}
      {events.length === 0 && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>({t("notifyChEventsAll")})</span>}
    </div>
  );
}

/** Server error codes → localized text. Raw transport errors pass through unchanged. */
function useErrText() {
  const { t } = useLanguage();
  return (code: string): string => {
    const short = code.startsWith("notifyChErr_") ? code.slice("notifyChErr_".length) : code;
    if (short === "invalid_url") return t("notifyChErr_invalid_url");
    if (short === "private_address") return t("notifyChErr_private_address");
    if (short === "smtp_auth") return t("notifyChErr_smtp_auth");
    if (short === "smtp_connect") return t("notifyChErr_smtp_connect");
    if (short === "not_migrated") return t("autoSyncNotMigrated");
    // Extra key requested in the T3 report — shows the key itself until R's locale pass.
    if (short === "invalid_value") return t("notifyChErr_invalid_value" as never);
    return code;
  };
}

/**
 * Event filter for Telegram / Slack. Their credentials stay in their own blocks; only this
 * "which events to send" picker is added there (rendered from settings/page.tsx).
 */
export function ChannelEventsRow({ id }: { id: "telegram" | "slack" }) {
  const { t } = useLanguage();
  const errText = useErrText();
  const [events, setEvents] = useState<NotifyEvent[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/settings/notify-channels").then(r => r.json()).then(d => {
      const v = (Array.isArray(d?.channels) ? d.channels : []).find((c: NotifyChannelView) => c.id === id);
      setEvents(v?.events ?? []);
    }).catch(() => setEvents([]));
  }, [id]);

  if (events === null) return null;

  const toggle = (ev: NotifyEvent) => {
    const next = events.includes(ev) ? events.filter(x => x !== ev) : [...events, ev];
    setEvents(next); setErr("");
    fetch("/api/settings/notify-channels", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, patch: { events: next } }),
    }).then(r => r.json().then(d => ({ ok: r.ok, d }))).then(({ ok, d }) => {
      if (!ok) setErr(errText(String(d?.error ?? "")));
      else { setSaved(true); setTimeout(() => setSaved(false), 1500); }
    }).catch(() => setErr(errText("not_migrated")));
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "10px 0", borderTop: "1px solid var(--color-border)", marginTop: "10px" }}>
      <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", minWidth: "90px" }}>{t("notifyChEvents")}</span>
      <EventPicker events={events} onToggle={toggle} />
      {saved && <span style={{ fontSize: "12px", color: "#10B981" }}>✓</span>}
      {err && <span style={{ fontSize: "12px", color: "#f87171" }}>{err}</span>}
    </div>
  );
}

/** One collapsible channel row. */
function ChannelRow({ view, draft, setDraft, busy, msg, onSave, onTest, onToggleOpen, open }: {
  view: NotifyChannelView;
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  busy: string;
  msg: { ok: boolean; text: string } | undefined;
  onSave: () => void;
  onTest: () => void;
  onToggleOpen: () => void;
  open: boolean;
}) {
  const { t } = useLanguage();
  const name = view.id === "discord" ? t("notifyChDiscord")
    : view.id === "teams" ? t("notifyChTeams")
    : view.id === "email" ? t("notifyChEmail")
    : t("notifyChWebhook");

  const status = !view.configured
    ? <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("apiKeyNotConfigured")}</span>
    : view.on
      ? <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#10B981", fontWeight: 600 }}><CheckCircle size={13} /> {t("scConnected")}</span>
      : <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--color-text-secondary)", fontWeight: 600 }}><X size={13} /> {t("no")}</span>;

  const field = (key: keyof Draft, placeholder: string, labelText: string, type: string, extraStyle: React.CSSProperties = {}) => (
    <div style={{ flex: "1 1 180px", minWidth: "160px" }}>
      <label style={label}>{labelText}</label>
      <input type={type} value={String(draft[key] ?? "")} placeholder={placeholder}
        onChange={e => setDraft({ [key]: e.target.value } as Partial<Draft>)}
        style={{ ...input, ...extraStyle }} />
    </div>
  );

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "10px", overflow: "hidden" }}>
      <button type="button" onClick={onToggleOpen} aria-expanded={open}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: "10px", padding: "11px 14px", background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 600, flexWrap: "wrap" }}>
        <span>{name}</span>
        {status}
        <span style={{ flex: 1 }} />
        {view.configured && !view.lastError && view.lastOkAt && (
          <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontWeight: 400 }}>
            {t("notifyChLastOk").replace("{time}", new Date(view.lastOkAt).toLocaleString())}
          </span>
        )}
        {view.lastError && (
          <span style={{ fontSize: "11px", color: "#f87171", fontWeight: 400, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={view.lastError}>
            {t("notifyChLastError").replace("{error}", view.lastError)}
          </span>
        )}
        <ChevronDown size={15} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", color: "var(--color-text-secondary)" }} />
      </button>

      {open && (
        <div style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", gap: "12px", borderTop: "1px solid var(--color-border)" }}>
          {(view.id === "discord" || view.id === "teams" || view.id === "webhook") && (
            <>
              {view.id === "teams" && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("notifyChTeamsHint")}</div>}
              <div>
                <label style={label}>{t("notifyChUrl")}</label>
                <input type="password" value={draft.url} onChange={e => setDraft({ url: e.target.value })}
                  placeholder={view.configured ? (view.target ?? "https://…") : view.id === "discord" ? "https://discord.com/api/webhooks/…" : view.id === "teams" ? "https://….logic.azure.com:443/workflows/…" : "https://…"}
                  style={input} />
                {view.configured && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "4px" }}>{t("notifyChKeep")}</div>}
              </div>
            </>
          )}
          {view.id === "webhook" && (
            <div>
              <label style={label}>{t("notifyChSecret")}</label>
              <input type="password" value={draft.secret} onChange={e => setDraft({ secret: e.target.value })} placeholder="…" style={input} />
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "4px" }}>{t("notifyChSecretHint")}</div>
            </div>
          )}
          {view.id === "email" && (
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {field("host", "smtp.gmail.com", t("notifyChSmtpHost"), "text")}
              {field("port", "587 / 465", t("notifyChSmtpPort"), "text", { flex: "0 1 90px", minWidth: "70px" })}
              <div style={{ flex: "0 1 auto", alignSelf: "flex-end", paddingBottom: "9px" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "7px", fontSize: "12px", color: "var(--color-text-primary)", cursor: "pointer" }}>
                  <input type="checkbox" checked={draft.secure} onChange={e => setDraft({ secure: e.target.checked })} />
                  {t("notifyChSmtpSecure")}
                </label>
              </div>
              {field("user", "user@gmail.com", t("notifyChSmtpUser"), "text")}
              {field("pass", "•••• •••• ••••", t("notifyChSmtpPass"), "password")}
              {field("from", "user@gmail.com", t("notifyChFrom"), "text")}
              {field("to", "chief@company.com, seo@company.com", t("notifyChTo"), "text")}
              {view.configured && <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", flexBasis: "100%" }}>{t("notifyChKeep")} ({t("notifyChSmtpPass")})</div>}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", minWidth: "90px" }}>{t("notifyChEvents")}</span>
            <EventPicker events={draft.events} onToggle={ev =>
              setDraft({ events: draft.events.includes(ev) ? draft.events.filter(x => x !== ev) : [...draft.events, ev] })} />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {/* on/off: the same yes/no pair the Preferences section uses for switches */}
            <div style={{ display: "flex", gap: "6px" }}>
              {[t("yes"), t("no")].map((opt, idx) => {
                const active = idx === 0 ? draft.on : !draft.on;
                return (
                  <button key={opt} type="button" onClick={() => setDraft({ on: idx === 0 })} aria-pressed={active}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "5px", padding: "6px 13px", borderRadius: "8px",
                      fontSize: "12px", fontWeight: 600, cursor: "pointer",
                      background: active ? (idx === 0 ? "rgba(16,185,129,0.12)" : "rgba(255,255,255,0.05)") : "transparent",
                      color: idx === 0 && active ? "#10B981" : active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                      border: `1px solid ${idx === 0 && active ? "rgba(16,185,129,0.3)" : "var(--color-border)"}`,
                    }}>
                    {idx === 0 ? <CheckCircle size={12} /> : <X size={12} />} {opt}
                  </button>
                );
              })}
            </div>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={onSave} disabled={!!busy} style={{ ...smallBtn, background: "var(--color-accent-blue)", color: "#fff", border: "none", opacity: busy ? 0.5 : 1 }}>
              {busy === "save" ? "…" : "Save"}
            </button>
            <button type="button" onClick={onTest} disabled={!!busy || !view.configured} style={{ ...smallBtn, opacity: busy || !view.configured ? 0.5 : 1 }}>
              {busy === "test" ? "…" : t("notifyChTest")}
            </button>
          </div>

          {msg && <div style={{ fontSize: "12px", color: msg.ok ? "#10B981" : "#f87171" }}>{msg.text}</div>}
        </div>
      )}
    </div>
  );
}

const ROWS: StoredId[] = ["discord", "teams", "email", "webhook"];

export default function NotifyChannelsCard() {
  const { t } = useLanguage();
  const errText = useErrText();
  const [views, setViews] = useState<NotifyChannelView[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState("");
  const [msgs, setMsgs] = useState<Record<string, { ok: boolean; text: string }>>({});
  const load = () => fetch("/api/settings/notify-channels")
    .then(r => r.json())
    .then(d => {
      const list: NotifyChannelView[] = Array.isArray(d?.channels) ? d.channels : [];
      setViews(list);
      // Refresh the event/on part of every draft from the server; typed fields stay as typed.
      setDrafts(prev => {
        const next = { ...prev };
        for (const v of list) {
          if (next[v.id]) next[v.id] = { ...next[v.id], on: v.configured ? v.on : next[v.id].on, events: v.events };
          else next[v.id] = seedDraft(v);
        }
        return next;
      });
    }).catch(() => setViews([]));

  useEffect(() => { load(); }, []);

  const setDraft = (id: string) => (patch: Partial<Draft>) =>
    setDrafts(prev => ({ ...prev, [id]: { ...(prev[id] ?? seedDraft(undefined)), ...patch } }));

  const expand = (id: StoredId) => {
    setOpenId(cur => (cur === id ? null : id));
    setDrafts(prev => (prev[id] ? prev : { ...prev, [id]: seedDraft(views?.find(v => v.id === id)) }));
  };

  const save = async (id: StoredId) => {
    const d = drafts[id];
    const view = views?.find(v => v.id === id);
    if (!d) return;
    const patch: Record<string, unknown> = { on: d.on, events: d.events };
    if (id === "email") {
      patch.host = d.host.trim();
      patch.port = Number(d.port) || 0;
      patch.secure = d.secure;
      patch.user = d.user.trim();
      patch.pass = d.pass; // "" = keep
      patch.from = d.from.trim();
      patch.to = d.to.split(",").map(s => s.trim()).filter(Boolean).slice(0, 10);
      if (!view?.configured && (!patch.host || !patch.port || !(patch.to as string[]).length || !patch.from)) {
        setMsgs(m => ({ ...m, [id]: { ok: false, text: errText("invalid_value") } }));
        return;
      }
    } else {
      patch.url = d.url.trim(); // "" = keep when already configured
      if (id === "webhook") patch.secret = d.secret;
      if (!view?.configured && !patch.url) {
        setMsgs(m => ({ ...m, [id]: { ok: false, text: errText("invalid_url") } }));
        return;
      }
    }
    setBusyId(`save:${id}`);
    try {
      const res = await fetch("/api/settings/notify-channels", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, patch }),
      });
      const data = await res.json();
      setMsgs(m => ({ ...m, [id]: res.ok
        ? { ok: true, text: t("notifyChSaved") }
        : { ok: false, text: errText(String(data?.error ?? "db_error")) } }));
      if (res.ok) await load();
    } catch {
      setMsgs(m => ({ ...m, [id]: { ok: false, text: errText("not_migrated") } }));
    }
    setBusyId("");
  };

  const test = async (id: StoredId) => {
    setBusyId(`test:${id}`);
    try {
      const res = await fetch("/api/settings/notify-channels/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await res.json();
      setMsgs(m => ({ ...m, [id]: !res.ok
        ? { ok: false, text: errText(String(d?.error ?? "db_error")) }
        : d?.ok
          ? { ok: true, text: t("notifyChTestOk") }
          : { ok: false, text: errText(String(d?.error ?? "error")) } }));
      await load(); // lastOkAt / lastError just changed
    } catch {
      setMsgs(m => ({ ...m, [id]: { ok: false, text: errText("not_migrated") } }));
    }
    setBusyId("");
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Zap size={17} color="#8B5CF6" />
        <h2 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("notifyChTitle")}</h2>
      </div>
      {views === null ? (
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>…</div>
      ) : (
        <>
          {ROWS.map(id => {
            const view = views.find(v => v.id === id)
              ?? { id, configured: false, on: false, events: [] as NotifyEvent[], target: null, lastOkAt: null, lastError: null };
            return (
              <ChannelRow
                key={id}
                view={view}
                draft={drafts[id] ?? seedDraft(view)}
                setDraft={setDraft(id)}
                busy={busyId === `save:${id}` ? "save" : busyId === `test:${id}` ? "test" : ""}
                msg={msgs[id]}
                onSave={() => save(id)}
                onTest={() => test(id)}
                onToggleOpen={() => expand(id)}
                open={openId === id}
              />
            );
          })}
          {/* wave-nov (N10): the push channel. Its config is per-device (PushSettingsCard
              right below in Settings), so this row only reports state and links there. */}
          {(() => {
            const view = views.find(v => v.id === "webpush");
            if (!view) return null;
            return (
              <div style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "11px 14px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("pwaPushChannel")}</span>
                {view.configured ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#10B981", fontWeight: 600 }}>
                    <CheckCircle size={13} /> {t("pwaPushCount").replace("{n}", view.target ?? "0")}
                  </span>
                ) : (
                  <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("apiKeyNotConfigured")}</span>
                )}
                {view.configured && !view.lastError && view.lastOkAt && (
                  <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontWeight: 400 }}>
                    {t("notifyChLastOk").replace("{time}", new Date(view.lastOkAt).toLocaleString())}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <a href="#push-settings" style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-accent-blue)" }}>
                  {t("pwaPushDevices")} →
                </a>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
