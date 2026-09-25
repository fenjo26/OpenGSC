"use client";

// Workspace-wide uptime settings (Settings page): auto-enroll, default interval, "still down"
// reminders, slow-response alerts, and the heartbeat URL — the dead-man's switch that tells an
// external service when THIS server died.

import { useEffect, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { UPTIME_INTERVALS, type UptimeWorkspaceSettings } from "@/lib/uptime/types";

const label: React.CSSProperties = { fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 500 };
const hint: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)" };
const input: React.CSSProperties = {
  padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: "13px", outline: "none",
};

export default function UptimeSettingsCard() {
  const { t } = useLanguage();
  const [settings, setSettings] = useState<UptimeWorkspaceSettings | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetch("/api/uptime/settings")
      .then(r => r.json())
      .then(d => {
        if (d.notMigrated) setNotMigrated(true);
        else if (d.error) setError(d.error);
        else setSettings(d);
      })
      .catch(() => setError("network"));
  };

  useEffect(() => { load(); }, []);

  if (notMigrated) {
    return (
      <div className="card" style={{ color: "var(--color-accent-orange)", fontSize: "13px" }}>
        {t("uptimeSettingsTitle")} — npx prisma db push
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="card" style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-text-secondary)", fontSize: "13px" }}>
        <Loader2 size={14} className="spin" /> {t("uptimeSettingsTitle")}…
      </div>
    );
  }

  const save = async () => {
    setBusy(true); setSaved(false); setError(null);
    try {
      const res = await fetch("/api/uptime/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "server_error");
      setSettings(d);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network");
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string): number => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Bell size={16} color="var(--color-accent-green)" />
        <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("uptimeSettingsTitle")}</span>
        <span className="pill" style={{ marginLeft: "auto", fontSize: "11px" }}>{t("uptimeFree")}</span>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
        <input type="checkbox" checked={settings.autoEnroll} onChange={e => setSettings({ ...settings, autoEnroll: e.target.checked })} />
        <span style={label}>{t("uptimeAutoEnroll")}</span>
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={label}>{t("uptimeDefaultInterval")}</span>
        <select
          value={settings.defaultIntervalMin}
          onChange={e => setSettings({ ...settings, defaultIntervalMin: parseInt(e.target.value, 10) })}
          style={input}
        >
          {UPTIME_INTERVALS.map(v => (
            <option key={v} value={v}>{t("uptimeIntervalMin").replace("{n}", String(v))}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={label}>{t("uptimeReminder")}</span>
        <input
          type="number" min={0} max={168} value={settings.reminderHours}
          onChange={e => setSettings({ ...settings, reminderHours: num(e.target.value) })}
          style={{ ...input, width: "70px" }}
        />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
        <input type="checkbox" checked={settings.notifyDegraded} onChange={e => setSettings({ ...settings, notifyDegraded: e.target.checked })} />
        <span style={label}>{t("uptimeNotifyDegraded")}</span>
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={label}>{t("uptimeHeartbeat")}</span>
        <input
          type="url" value={settings.heartbeatUrl} placeholder="https://hc-ping.com/…"
          onChange={e => setSettings({ ...settings, heartbeatUrl: e.target.value })}
          style={{ ...input, width: "100%" }}
          aria-label={t("uptimeHeartbeat")}
        />
        <span style={hint}>{t("uptimeHeartbeatHint")}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button
          onClick={save} disabled={busy}
          style={{ padding: "7px 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "13px", background: "var(--color-accent-blue)", color: "#fff" }}
        >
          {busy ? "…" : t("claritySave")}
        </button>
        {saved && <span style={{ fontSize: "12px", color: "var(--color-accent-green)" }}>{t("notifyChSaved")}</span>}
        {error && <span style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>{error}</span>}
      </div>
    </div>
  );
}
