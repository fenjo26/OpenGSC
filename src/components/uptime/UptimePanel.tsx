"use client";

// Site → Health tab: the uptime card. Big status, latency, check-now, the four uptime numbers,
// a 30-day latency sparkline (days with downtime marked red — hand-rolled SVG after
// DrSparkline, no new chart dependency), the incident list, and a collapsible settings block.
//
// Read-only share view (/share/[siteId]/[token]): the dot and the numbers show, every mutating
// control (check-now, settings) does not — the panel derives both from the pathname because
// the site page renders it without a readOnly prop.

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Activity, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import UptimeDot from "./UptimeDot";
import { UPTIME_INTERVALS, type UptimeCause, type UptimeSummary } from "@/lib/uptime/types";

const label: React.CSSProperties = { fontSize: "13px", color: "var(--color-text-primary)", fontWeight: 500 };
const muted: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)" };
const input: React.CSSProperties = {
  padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--color-border)",
  background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: "13px",
  outline: "none", width: "100%", boxSizing: "border-box", minWidth: 0,
};

function causeLabel(t: ReturnType<typeof useLanguage>["t"], cause: UptimeCause, httpStatus: number | null): string {
  const key = cause === "http_status"
    ? `uptimeCause_http_status` as Parameters<typeof t>[0]
    : `uptimeCause_${cause}` as Parameters<typeof t>[0];
  const text = t(key);
  return cause === "http_status" ? text.replace("{code}", String(httpStatus ?? "?")) : text;
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** 30-day latency sparkline. Days inside an incident get a red tick at the baseline; days
 *  without data leave a gap rather than a zero — no check is not a 0 ms answer. Hand-rolled
 *  SVG after DrSparkline: a chart library at this size costs more than the chart. */
function LatencySparkline({ days, downDays }: { days: UptimeSummary["latency"]; downDays: Set<string> }) {
  const width = 300, height = 40, pad = 3;
  const values = days.filter(d => d.avg != null);
  if (values.length < 2) return null;
  const max = Math.max(...days.map(d => d.max ?? d.avg ?? 0), 1);
  const xOf = (i: number) => pad + (i / Math.max(1, days.length - 1)) * (width - pad * 2);
  const yOf = (v: number) => height - pad - (v / max) * (height - pad * 2);
  // Split into contiguous segments wherever a day has no average.
  const segments: string[][] = [];
  let current: string[] = [];
  days.forEach((d, i) => {
    if (d.avg == null) {
      if (current.length > 1) segments.push(current);
      current = [];
      return;
    }
    current.push(`${xOf(i).toFixed(1)},${yOf(d.avg).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current);
  const down = days.map((d, i) => ({ day: d.day, i })).filter(({ day }) => downDays.has(day));
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height + 6}`} style={{ display: "block" }} role="img" aria-label={down.length ? `latency, 30 d, ${down.length} down` : "latency, 30 d"}>
      {segments.map((seg, i) => (
        <polyline key={i} points={seg.join(" ")} fill="none" stroke="var(--color-accent-blue)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {down.map(({ day, i }) => (
        <circle key={day} cx={xOf(i)} cy={height - 1} r="2" fill="var(--color-accent-red)" />
      ))}
    </svg>
  );
}

/** Days an incident list overlaps the 30-day window (ongoing ones count to today). Computed
 *  when data arrives, not during render — "today" is impure. */
function incidentDays(incidents: UptimeSummary["incidents"], windowStart: string, nowMs: number): Set<string> {
  const days = new Set<string>();
  for (const inc of incidents) {
    const start = new Date(inc.startedAt);
    const end = inc.endedAt ? new Date(inc.endedAt).getTime() : nowMs;
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
         d.getTime() <= end && d.getTime() <= nowMs;
         d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      if (key >= windowStart) days.add(key);
    }
  }
  return days;
}

export default function UptimePanel({ siteDbId }: { siteDbId: string }) {
  const { t, language } = useLanguage();
  const pathname = usePathname();
  const readOnly = pathname?.startsWith("/share/") === true;
  const shareToken = readOnly ? (pathname?.split("/")[3] ?? "") : "";

  const [summary, setSummary] = useState<UptimeSummary | null>(null);
  const [downDays, setDownDays] = useState<Set<string>>(new Set());
  const [noMonitor, setNoMonitor] = useState(false);
  const [notMigrated, setNotMigrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UptimeSummary["monitor"] | null>(null);

  const load = useCallback(() => {
    const url = `/api/uptime/${encodeURIComponent(siteDbId)}${shareToken ? `?shareToken=${encodeURIComponent(shareToken)}` : ""}`;
    return fetch(url)
      .then(r => r.json())
      .then(d => {
        if (d.notMigrated) { setNotMigrated(true); return; }
        if (d.error) { setError(d.error); return; }
        if (d.monitor === null) { setNoMonitor(true); setSummary(null); return; }
        setNoMonitor(false);
        setSummary(d as UptimeSummary);
        setDraft(prev => prev ?? (d as UptimeSummary).monitor);
        const s = d as UptimeSummary;
        setDownDays(incidentDays(s.incidents, s.latency[0]?.day ?? "", Date.now()));
      })
      .catch(() => setError("network"))
      .finally(() => setLoading(false));
  }, [siteDbId, shareToken]);

  useEffect(() => { void load(); }, [load]);

  const checkNow = async () => {
    if (checking) return;
    setChecking(true); setError(null);
    try {
      const res = await fetch(`/api/uptime/${encodeURIComponent(siteDbId)}/check`, { method: "POST" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "server_error");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "network");
    } finally {
      setChecking(false);
    }
  };

  const saveMonitor = async (patch: Partial<UptimeSummary["monitor"]>) => {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/uptime/${encodeURIComponent(siteDbId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "server_error");
      setSummary(d as UptimeSummary);
      setDraft((d as UptimeSummary).monitor);
      setNoMonitor(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network");
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <Activity size={16} color="var(--color-accent-green)" />
      <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("uptimeTitle")}</span>
      <span className="pill" style={{ marginLeft: "auto", fontSize: "11px" }}>{t("uptimeFree")}</span>
    </div>
  );

  if (notMigrated) {
    return (
      <div className="card" style={{ color: "var(--color-accent-orange)", fontSize: "13px" }}>
        {header}
        <div style={{ marginTop: "8px" }}>npx prisma db push</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="card" style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-text-secondary)", fontSize: "13px" }}>
        <Loader2 size={14} className="spin" /> {t("uptimeTitle")}…
      </div>
    );
  }

  // No monitor yet: one switch to start watching with the defaults (the URL defaults to the
  // site root server-side; the settings block below appears once a monitor exists).
  if (noMonitor || !summary || !draft) {
    return (
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {header}
        {!readOnly ? (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <input
                type="checkbox" checked={false}
                onChange={e => { if (e.target.checked) void saveMonitor({ enabled: true }); }}
              />
              <span style={label}>{t("uptimeEnabled")}</span>
            </label>
            {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>{error}</div>}
          </>
        ) : <div style={muted}>{t("uptimeStatus_unknown")}</div>}
      </div>
    );
  }

  const b = summary.badge;
  const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
  const sinceText = b.since
    ? t("uptimeSince").replace("{time}", new Date(b.since).toLocaleString(language, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }))
    : "";

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {header}

      {/* Status + latency + check-now */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <UptimeDot badge={b} size={12} />
        <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>
          {t(`uptimeStatus_${b.status}` as Parameters<typeof t>[0])}
        </span>
        {sinceText && <span style={muted}>{sinceText}</span>}
        {b.latencyMs != null && (
          <span style={muted}>{t("uptimeLatency").replace("{ms}", String(b.latencyMs))}</span>
        )}
        {!readOnly && (
          <button
            onClick={checkNow} disabled={checking}
            title={t("uptimeCheckNow")}
            style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg-secondary)", color: "var(--color-text-primary)", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {t("uptimeCheckNow")}
          </button>
        )}
      </div>
      {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>{error}</div>}

      {/* Four uptime numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: "8px" }}>
        {([
          { k: "uptime24h", v: summary.uptime.d1 },
          { k: "uptime7d", v: summary.uptime.d7 },
          { k: "uptime30d", v: summary.uptime.d30 },
          { k: "uptime90d", v: summary.uptime.d90 },
        ] as const).map(({ k, v }) => (
          <div key={k} style={{ padding: "8px 12px", borderRadius: "10px", background: "var(--color-bg-secondary)", border: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("uptimePct").replace("{d}", t(k))}</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)" }}>{pct(v)}</div>
          </div>
        ))}
      </div>

      {/* Latency sparkline — the caption is the window, not the ms formatter key */}
      {summary.latency.length > 1 && (
        <div>
          <div style={{ ...muted, marginBottom: "4px" }}>{t("uptime30d")}</div>
          <LatencySparkline days={summary.latency} downDays={downDays} />
        </div>
      )}

      {/* Incidents */}
      <div>
        <div style={{ ...muted, fontWeight: 600, marginBottom: "6px" }}>{t("uptimeIncidents")}</div>
        {summary.incidents.length === 0 ? (
          <div style={muted}>{t("uptimeNoIncidents")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {summary.incidents.map(inc => (
              <div key={inc.id} style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: "12px", padding: "6px 10px", borderRadius: "8px", background: "var(--color-bg-secondary)" }}>
                <span style={{ color: inc.endedAt ? "var(--color-text-secondary)" : "var(--color-accent-red)", fontWeight: 600 }}>
                  {new Date(inc.startedAt).toLocaleString(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <span style={{ color: "var(--color-text-primary)" }}>
                  {inc.endedAt && inc.durationMs != null
                    ? t("uptimeDuration").replace("{d}", fmtDuration(inc.durationMs))
                    : t("uptimeOngoing")}
                </span>
                <span style={{ color: "var(--color-text-secondary)", marginLeft: "auto" }}>
                  {causeLabel(t, inc.cause, inc.httpStatus)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      {!readOnly && (
        <div>
          <button
            onClick={() => setShowSettings(v => !v)} aria-expanded={showSettings}
            style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, padding: 0 }}
          >
            <ChevronDown size={14} style={{ transform: showSettings ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
            {t("uptimeSettingsTitle")}
          </button>
          {showSettings && draft && (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
                <span style={label}>{t("uptimeEnabled")}</span>
              </label>
              <div>
                <div style={{ ...muted, marginBottom: "4px" }}>{t("uptimeUrl")}</div>
                <input type="url" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} style={input} aria-label={t("uptimeUrl")} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: "10px" }}>
                <div>
                  <div style={{ ...muted, marginBottom: "4px" }}>{t("uptimeInterval")}</div>
                  <select value={draft.intervalMin} onChange={e => setDraft({ ...draft, intervalMin: parseInt(e.target.value, 10) })} style={input} aria-label={t("uptimeInterval")}>
                    {UPTIME_INTERVALS.map(v => <option key={v} value={v}>{t("uptimeIntervalMin").replace("{n}", String(v))}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ ...muted, marginBottom: "4px" }}>{t("uptimeTimeout")}</div>
                  <input type="number" min={1} max={120} value={Math.round(draft.timeoutMs / 1000)} onChange={e => setDraft({ ...draft, timeoutMs: (parseInt(e.target.value, 10) || 15) * 1000 })} style={input} aria-label={t("uptimeTimeout")} />
                </div>
                <div>
                  <div style={{ ...muted, marginBottom: "4px" }}>{t("uptimeAccept")}</div>
                  <input type="text" value={draft.acceptStatus} onChange={e => setDraft({ ...draft, acceptStatus: e.target.value })} style={input} aria-label={t("uptimeAccept")} />
                </div>
                <div>
                  <div style={{ ...muted, marginBottom: "4px" }}>{t("uptimeKeyword")}</div>
                  <input type="text" value={draft.keyword} onChange={e => setDraft({ ...draft, keyword: e.target.value })} style={input} aria-label={t("uptimeKeyword")} />
                </div>
                <div>
                  <div style={{ ...muted, marginBottom: "4px" }}>{t("uptimeSlow")}</div>
                  <input type="number" min={100} max={600000} step={100} value={draft.slowMs} onChange={e => setDraft({ ...draft, slowMs: parseInt(e.target.value, 10) || 5000 })} style={input} aria-label={t("uptimeSlow")} />
                </div>
                <div>
                  <div style={{ ...muted, marginBottom: "4px" }}>{t("uptimeFailThreshold")}</div>
                  <input type="number" min={1} max={10} value={draft.failThreshold} onChange={e => setDraft({ ...draft, failThreshold: parseInt(e.target.value, 10) || 2 })} style={input} aria-label={t("uptimeFailThreshold")} />
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input type="checkbox" checked={draft.alerts} onChange={e => setDraft({ ...draft, alerts: e.target.checked })} />
                <span style={label}>{t("uptimeAlerts")}</span>
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <button
                  onClick={() => void saveMonitor(draft)} disabled={saving}
                  style={{ padding: "7px 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: "13px", background: "var(--color-accent-blue)", color: "#fff" }}
                >
                  {saving ? "…" : t("claritySave")}
                </button>
                {error && <span style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>{error}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
