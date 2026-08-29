"use client";

// Digest tab — build a Markdown summary over all sites or one tag (a site network),
// preview it on screen, send it to Telegram, and configure the recurring schedule.
// Building happens server-side from the local metric store; the optional AI paragraph
// uses the user's own AI key (server-side backup).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Send, Eye, Trash2, AlertTriangle, Newspaper, Save, Calendar, Clock, Tag, ChevronRight, Sparkles } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import { markdownToHtml } from "@/lib/seo/outlineFormat";
import DigestView from "@/components/DigestView";
import type { DigestData } from "@/lib/digest";

// Period options — labels resolved via i18n at render (see PERIOD_LABEL keys).
const PERIODS: { value: number; key: string }[] = [
  { value: 7,   key: "digestPeriod7" },
  { value: 14,  key: "digestPeriod14" },
  { value: 30,  key: "digestPeriod30" },
  { value: 90,  key: "digestPeriod90" },
  { value: 180, key: "digestPeriod180" },
  { value: 365, key: "digestPeriod365" },
  { value: 0,   key: "digestPeriodAll" },
];

export default function DigestPage() {
  const { t, language } = useLanguage() as any;
  const [tags, setTags] = useState<string[]>([]);
  const [telegram, setTelegram] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);

  const [tag, setTag] = useState("");
  // Digest days is saved automation config (the settings load below restores it), but the
  // pill you clicked should still survive a refresh before you save, and ?days= on the URL
  // shares a digest at a specific window. URL wins over the saved settings; the reload below
  // skips its restore when a param is present.
  const [days, setDays] = usePersistedState<number>("gsc_digest_days", 7, v => typeof v === "number" && [0, 7, 14, 30, 90, 180, 365].includes(v), "days");
  const [ai, setAi] = useState(false);
  const [preview, setPreview] = useState("");      // markdown (for history items)
  const [data, setData] = useState<DigestData | null>(null); // structured (rich view)
  const [aiText, setAiText] = useState<string | null>(null); // AI summary paragraph
  const [engines, setEngines] = useState<{ bing: boolean; yandex: boolean }>({ bing: false, yandex: false });
  const [busy, setBusy] = useState<"" | "preview" | "send" | "save">("");
  const [msg, setMsg] = useState("");

  // True if the user has configured at least one AI provider key (browser-side).
  const hasAiKey = () => {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("aiKey_") && (localStorage.getItem(k) || "").trim().length > 4) return true;
      }
      return (localStorage.getItem("aiApiKey") || "").trim().length > 4;
    } catch { return false; }
  };

  const reload = async () => {
    try {
      const d = await fetch("/api/digest").then(r => r.json());
      setTags(d.tags || []);
      setTelegram(!!d.telegram);
      setHistory(d.digests || []);
      setSettings(d.settings || null);
      setEngines(d.engines || { bing: false, yandex: false });
      // AI summary defaults ON when any AI key is configured (user can still turn it off).
      // The saved days restore is skipped when the URL pins a window (?days=) — a shared
      // digest link must not snap back to the owner's saved schedule.
      if (d.settings) {
        setTag(d.settings.tag ?? "");
        setAi(!!d.settings.ai || hasAiKey());
        if (!(typeof window !== "undefined" && new URLSearchParams(window.location.search).get("days") !== null)) {
          setDays(d.settings.days ?? 7);
        }
      }
    } catch {}
  };
  useEffect(() => { reload(); }, []);

  const run = async (action: "preview" | "send") => {
    setBusy(action); setMsg("");
    try {
      const d = await fetch("/api/digest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, tag, days, ai, lang: language }),
      }).then(r => r.json());
      if (d.data) { setData(d.data); setAiText(d.ai || null); setPreview(""); }
      else if (d.content) { setPreview(d.content); setData(null); setAiText(null); }
      if (action === "send") {
        setMsg(d.sent ? t("digestSentOk") : t("digestSentFail"));
        reload();
      }
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
    setBusy("");
  };

  // Lazy-load one engine's rich portfolio (per-site clicks/impr/position + period-over-period
  // change) for the DigestView tab. Reuses the cached engine portfolio, so it's instant after
  // the dashboard built it, and gives the same gainers/losers/attention sections as Google.
  const daysToPeriodKey = (dn: number) => dn >= 365 || dn === 0 ? "12m" : dn >= 180 ? "6m" : dn >= 90 ? "3m" : dn >= 28 ? "28d" : dn >= 14 ? "14d" : "7d";
  const fetchEngine = async (engine: "bing" | "yandex") => {
    const d = await fetch(`/api/gsc/portfolio-engine?engine=${engine}&period=${daysToPeriodKey(days)}`).then(r => r.json());
    return { sites: d.sites || [] };
  };

  const saveSchedule = async (patch: any) => {
    const next = { ...settings, ...patch, lang: language };
    setSettings(next);
    setBusy("save");
    try {
      await fetch("/api/digest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "settings", settings: next }),
      });
    } catch {}
    setBusy("");
  };

  const removeDigest = async (id: string) => {
    await fetch(`/api/digest?id=${id}`, { method: "DELETE" }).catch(() => {});
    setHistory(h => h.filter(x => x.id !== id));
  };

  const card: React.CSSProperties = {
    background: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: "14px",
    padding: "20px 24px",
  };

  const pillBtn = (active: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    borderRadius: "8px",
    border: "none",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.15s",
    background: active ? "var(--color-accent-blue)" : "rgba(255,255,255,0.06)",
    color: active ? "#fff" : "var(--color-text-secondary)",
  });

  const actionBtn = (primary: boolean, disabled: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    padding: "10px 18px",
    borderRadius: "10px",
    border: primary ? "none" : "1px solid var(--color-border)",
    fontSize: "13px",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    background: primary ? "var(--color-accent-blue)" : "var(--color-card)",
    color: primary ? "#fff" : "var(--color-text-primary)",
    transition: "all 0.15s",
  });

  return (
    <div className="main-content" style={{ gap: "18px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ width: 40, height: 40, borderRadius: "12px", background: "rgba(52,199,89,0.12)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Newspaper size={20} style={{ color: "#34c759" }} />
        </div>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.02em", margin: 0 }}>{t("digestTitle")}</h1>
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{t("digestSubtitle")}</div>
        </div>
      </div>

      {/* Telegram warning */}
      {!telegram && (
        <div style={{ padding: "12px 16px", borderRadius: "10px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.1)", fontSize: "13px", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <AlertTriangle size={14} style={{ color: "#f59e0b", flexShrink: 0 }} /> {t("digestNoTelegram")}
          <Link href="/settings?tab=notifications" style={{ color: "var(--color-accent-blue)", fontWeight: 600 }}>{t("digestConnectLink")}</Link>
        </div>
      )}

      {/* Builder */}
      <div style={card}>
        {/* Period picker */}
        <div style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", marginBottom: "8px" }}>
            <Calendar size={11} style={{ verticalAlign: "-1px", marginRight: "4px" }} />
            {t("digestPeriodLabel")}
          </div>
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {PERIODS.map(p => (
              <button key={p.value} onClick={() => setDays(p.value)} style={pillBtn(days === p.value)}>
                {t(p.key as any)}
              </button>
            ))}
          </div>
        </div>

        {/* Tag + AI + Actions row */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Tag size={13} style={{ color: "var(--color-text-secondary)" }} />
            <select value={tag} onChange={e => setTag(e.target.value)}
              style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", minWidth: "150px" }}>
              <option value="">{t("digestAllSites")}</option>
              {tags.map(x => <option key={x} value={x}>{t("digestTagPrefix")} {x}</option>)}
            </select>
          </div>

          <label title={t("digestAiHint")} style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: ai ? "#8B5CF6" : "var(--color-text-secondary)", fontWeight: ai ? 600 : 400, cursor: "pointer", padding: "6px 10px", borderRadius: "8px", background: ai ? "rgba(139,92,246,0.12)" : "transparent", border: ai ? "1px solid rgba(139,92,246,0.35)" : "1px solid var(--color-border)", transition: "all 0.15s" }}>
            <Sparkles size={12} style={{ color: ai ? "#8B5CF6" : "var(--color-text-secondary)" }} />
            <input type="checkbox" checked={ai} onChange={e => setAi(e.target.checked)} style={{ display: "none" }} />
            {t("digestAiToggle")} {ai ? "✓" : ""}
          </label>

          <span style={{ flex: 1 }} />

          <button onClick={() => run("preview")} disabled={!!busy} style={actionBtn(false, !!busy)}>
            {busy === "preview" ? <Loader2 size={14} className="spin" /> : <Eye size={14} />} {t("digestPreview")}
          </button>
          <button onClick={() => run("send")} disabled={!!busy || !telegram} style={actionBtn(true, !!busy || !telegram)}>
            {busy === "send" ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {t("digestSend")}
          </button>
        </div>
      </div>

      {/* Status message */}
      {msg && <div style={{ fontSize: "12px", fontWeight: 600, color: msg === t("digestSentOk") ? "#34c759" : "#f87171", textAlign: "center" }}>{msg}</div>}

      {/* AI summary paragraph (when enabled) */}
      {data && aiText && (
        <div style={{ ...card, border: "1px solid rgba(139,92,246,0.35)", background: "rgba(139,92,246,0.06)" }}>
          <div dangerouslySetInnerHTML={{ __html: markdownToHtml(aiText.replace(/^\*(.+)\*$/gm, "**$1**")) }}
            style={{ fontSize: "13px", lineHeight: 1.7, color: "var(--color-text-primary)" }} />
        </div>
      )}

      {/* Rich preview (freshly built) */}
      {data && <DigestView data={data} engines={engines} fetchEngine={fetchEngine} />}

      {/* Markdown preview (history item — stored as text) */}
      {!data && preview && (
        <div style={card}>
          <div style={{ fontSize: "12px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", marginBottom: "12px" }}>
            {t("digestPreviewTitle")}
          </div>
          <div dangerouslySetInnerHTML={{ __html: markdownToHtml(preview.replace(/^\*(.+)\*$/gm, "**$1**")) }}
            style={{ fontSize: "13px", lineHeight: 1.8, color: "var(--color-text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }} />
        </div>
      )}

      {/* Schedule */}
      {settings && (
        <div style={card}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Clock size={15} style={{ color: "var(--color-text-secondary)" }} />
            {t("digestScheduleTitle")}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {/* Enable toggle */}
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer" }}>
              <input type="checkbox" checked={!!settings.enabled} onChange={e => saveSchedule({ enabled: e.target.checked })}
                style={{ width: "16px", height: "16px", accentColor: "#34c759" }} />
              {t("digestScheduleEnable")}
            </label>

            {/* Settings row */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", opacity: settings.enabled ? 1 : 0.5 }}>
              <select value={settings.frequency} onChange={e => saveSchedule({ frequency: e.target.value })}
                style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px" }}>
                <option value="weekly">{t("digestWeekly")}</option>
                <option value="daily">{t("digestDaily")}</option>
              </select>

              <select value={settings.hourUtc} onChange={e => saveSchedule({ hourUtc: parseInt(e.target.value) })}
                style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px" }}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00 UTC</option>)}
              </select>

              <select value={settings.tag ?? ""} onChange={e => saveSchedule({ tag: e.target.value })}
                style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", minWidth: "130px" }}>
                <option value="">{t("digestAllSites")}</option>
                {tags.map(x => <option key={x} value={x}>{t("digestTagPrefix")} {x}</option>)}
              </select>

              <select value={settings.days ?? 7} onChange={e => saveSchedule({ days: parseInt(e.target.value) })}
                style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px" }}>
                {PERIODS.map(p => <option key={p.value} value={p.value}>{t(p.key as any)}</option>)}
              </select>

              <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
                <Sparkles size={11} />
                <input type="checkbox" checked={!!settings.ai} onChange={e => saveSchedule({ ai: e.target.checked })} style={{ display: "none" }} />
                {t("digestAiToggle")}
              </label>

              {busy === "save" ? <Loader2 size={13} className="spin" style={{ color: "var(--color-text-secondary)" }} /> : <Save size={13} style={{ color: "#34c759" }} />}
            </div>
          </div>

          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "10px", lineHeight: 1.5 }}>{t("digestScheduleNote")}</div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "12px" }}>{t("digestHistory")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {history.map(d => (
              <div key={d.id}
                onClick={() => { setData(null); setPreview(d.content); }}
                style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "8px", cursor: "pointer", transition: "background 0.12s" }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", minWidth: "130px" }}>{new Date(d.createdAt).toLocaleString()}</span>
                <span style={{ fontSize: "12px", color: "var(--color-text-primary)", fontWeight: 600 }}>
                  {d.tag ? `${t("digestTagPrefix")} ${d.tag}` : t("digestAllSites")}
                </span>
                <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: "4px" }}>
                  {d.days === 0 ? t("digestPeriodAllShort") : `${d.days}${t("digestDaysShort")}`}
                </span>
                {d.sentTo === "telegram" && <span style={{ fontSize: "10px", color: "#34c759", fontWeight: 600 }}>✓ Telegram</span>}
                <span style={{ flex: 1 }} />
                <ChevronRight size={14} style={{ color: "var(--color-text-secondary)", opacity: 0.4 }} />
                <button onClick={e => { e.stopPropagation(); removeDigest(d.id); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "4px", borderRadius: "4px", opacity: 0.5 }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
