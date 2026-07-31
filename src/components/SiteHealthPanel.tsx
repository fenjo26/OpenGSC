"use client";

import { useEffect, useState, useCallback } from "react";
import { withShare, isGuestView } from "@/lib/shareParam";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  ShieldCheck, ShieldAlert, Lock, Unlock, Zap, ZapOff,
  Bug, AlertTriangle, RefreshCw, ExternalLink, Info,
  CheckCircle, XCircle, Clock, ChevronDown, ChevronUp,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface SslData {
  valid: boolean; daysLeft: number; issuer: string; subject: string;
  protocol: string; grade: string; error?: string;
}
interface SafeBrowsingData {
  safe: boolean; threats: string[]; error?: string;
}
interface VitalsData {
  lcp: number | null; inp: number | null; cls: number | null; ttfb: number | null;
  score: number | null; category: string; error?: string;
}
interface VirusTotalData {
  clean: boolean; malicious: number; suspicious: number; undetected: number; total: number; error?: string;
}
interface HealthData {
  cached: boolean; checkedAt: string | null;
  ssl: SslData | null; safeBrowsing: SafeBrowsingData | null;
  vitals: VitalsData | null; virusTotal: VirusTotalData | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function StatusBadge({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) {
  const color = warn ? "#F59E0B" : ok ? "#10B981" : "#EF4444";
  const bg    = warn ? "rgba(245,158,11,0.12)" : ok ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)";
  const icon  = warn ? <AlertTriangle size={10} /> : ok ? <CheckCircle size={10} /> : <XCircle size={10} />;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "20px", fontSize: "11px", fontWeight: 600, color, background: bg }}>
      {icon} {label}
    </span>
  );
}

function GradeChip({ grade }: { grade: string }) {
  const colors: Record<string, string> = { "A+": "#10B981", "A": "#34D399", "B": "#F59E0B", "C": "#F97316", "F": "#EF4444" };
  const color = colors[grade] ?? "#6B7280";
  return (
    <span style={{ fontWeight: 800, fontSize: "20px", color, letterSpacing: "-0.02em" }}>{grade}</span>
  );
}

function ScoreRing({ score }: { score: number }) {
  const color = score >= 90 ? "#10B981" : score >= 50 ? "#F59E0B" : "#EF4444";
  const r = 20, stroke = 4, circ = 2 * Math.PI * r;
  const dash = circ * (score / 100);
  return (
    <svg width={52} height={52} style={{ flexShrink: 0 }}>
      <circle cx={26} cy={26} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
      <circle cx={26} cy={26} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 26 26)" />
      <text x={26} y={30} textAnchor="middle" fontSize={12} fontWeight={700} fill={color}>{score}</text>
    </svg>
  );
}

function MetricPill({ label, value, unit = "", good }: { label: string; value: number | null; unit?: string; good?: boolean }) {
  if (value == null) return null;
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "2px" }}>{label}</div>
      <div style={{ fontSize: "14px", fontWeight: 700, color: good === undefined ? "var(--color-text-primary)" : good ? "#10B981" : "#EF4444" }}>
        {value >= 1000 ? (value / 1000).toFixed(1) + "s" : value + (unit || "ms")}
      </div>
    </div>
  );
}

function CardShell({ icon, title, children, topRight, loading }:
  { icon: React.ReactNode; title: string; children: React.ReactNode; topRight?: React.ReactNode; loading?: boolean }
) {
  return (
    <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "18px 20px", display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {icon}
          <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title}</span>
        </div>
        {loading ? (
          <RefreshCw size={13} style={{ color: "var(--color-text-secondary)", animation: "spin 1s linear infinite" }} />
        ) : topRight}
      </div>
      {children}
    </div>
  );
}

// ─── SSL Card ─────────────────────────────────────────────────────────────────
function SslCard({ data, loading }: { data: SslData | null; loading: boolean }) {
  const { t } = useLanguage();
  const ok   = data?.valid && (data?.daysLeft ?? 0) > 14;
  const warn = data?.valid && (data?.daysLeft ?? 0) <= 14;

  return (
    <CardShell
      icon={ok ? <Lock size={16} color="#10B981" /> : warn ? <Lock size={16} color="#F59E0B" /> : <Unlock size={16} color="#EF4444" />}
      title={t("healthSslCert") || "SSL Certificate"}
      loading={loading}
      topRight={data ? <GradeChip grade={data.grade} /> : undefined}
    >
      {!data && !loading && (
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("healthNotChecked") || "Not checked yet"}</p>
      )}
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            {data.error && data.error !== "Timeout" ? (
              <StatusBadge ok={false} label={data.error} />
            ) : (
              <StatusBadge ok={ok} warn={warn} label={data.valid ? (t("healthSslValid") || "Valid · {days}d left").replace("{days}", String(data.daysLeft)) : (t("healthSslExpired") || "Expired")} />
            )}
          </div>
          {!data.error && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              {[
                { l: t("healthSslIssuer") || "Issuer",   v: data.issuer   || "—" },
                { l: t("healthSslProtocol") || "Protocol", v: data.protocol || "—" },
              ].map(({ l, v }) => (
                <div key={l} style={{ background: "rgba(255,255,255,0.04)", borderRadius: "8px", padding: "8px 10px" }}>
                  <div style={{ fontSize: "10px", color: "var(--color-text-secondary)", marginBottom: "2px" }}>{l}</div>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{v}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
}

// ─── Safe Browsing Card ───────────────────────────────────────────────────────
function SafeBrowsingCard({ data, loading, noKey }: { data: SafeBrowsingData | null; loading: boolean; noKey: boolean }) {
  const { t } = useLanguage();
  return (
    <CardShell
      icon={data?.safe === false ? <ShieldAlert size={16} color="#EF4444" /> : <ShieldCheck size={16} color="#10B981" />}
      title={t("healthGoogleSb") || "Google Safe Browsing"}
      loading={loading}
      topRight={data && !noKey ? <StatusBadge ok={data.safe} label={data.safe ? (t("healthSbClean") || "Clean") : (t("healthSbFlagged") || "Flagged")} /> : undefined}
    >
      {noKey && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {t("healthSbNoKey") || "Add a Google Safe Browsing API key in Settings → API Keys to enable this check."}
          </p>
          <a href="https://developers.google.com/safe-browsing/v4/get-started" target="_blank" rel="noreferrer"
            style={{ fontSize: "11px", color: "var(--color-accent-blue)", display: "inline-flex", alignItems: "center", gap: "3px" }}>
            {t("healthSbGetApiKey") || "Get API key"} <ExternalLink size={10} />
          </a>
        </div>
      )}
      {!noKey && !data && !loading && (
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("healthNotChecked") || "Not checked yet"}</p>
      )}
      {!noKey && data && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {data.threats && data.threats.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {data.threats.map(t => (
                <StatusBadge key={t} ok={false} label={t.replace(/_/g, " ").toLowerCase()} />
              ))}
            </div>
          ) : (
            <p style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {data.error ? `Error: ${data.error}` : (t("healthSbNoThreats") || "No threats detected across all categories.")}
            </p>
          )}
        </div>
      )}
    </CardShell>
  );
}

// ─── Core Web Vitals Card ─────────────────────────────────────────────────────
function VitalsCard({ data, loading, noKey }: { data: VitalsData | null; loading: boolean; noKey: boolean }) {
  const { t } = useLanguage();
  const score = data?.score ?? null;
  return (
    <CardShell
      icon={score == null ? <Zap size={16} color="var(--color-text-secondary)" /> :
        score >= 90 ? <Zap size={16} color="#10B981" /> :
        score >= 50 ? <Zap size={16} color="#F59E0B" /> :
        <ZapOff size={16} color="#EF4444" />}
      title={t("healthVitalsTitle") || "Core Web Vitals"}
      loading={loading}
      topRight={score != null ? <StatusBadge ok={score >= 90} warn={score >= 50 && score < 90} label={data?.category === "good" ? (t("healthVitalsGood") || "Good") : data?.category === "needs_improvement" ? (t("healthVitalsNeedsWork") || "Needs Work") : (t("healthVitalsPoor") || "Poor")} /> : undefined}
    >
      {noKey && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {t("healthVitalsNoKey") || "Add a Google API key (PageSpeed Insights) in Settings → API Keys to enable this check."}
          </p>
          <a href="https://developers.google.com/speed/docs/insights/v5/get-started" target="_blank" rel="noreferrer"
            style={{ fontSize: "11px", color: "var(--color-accent-blue)", display: "inline-flex", alignItems: "center", gap: "3px" }}>
            {t("healthSbGetApiKey") || "Get API key"} <ExternalLink size={10} />
          </a>
        </div>
      )}
      {!noKey && !data && !loading && (
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("healthNotChecked") || "Not checked yet"}</p>
      )}
      {!noKey && data && (
        <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          {score != null && <ScoreRing score={score} />}
          <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", flex: 1 }}>
            <MetricPill label="LCP" value={data.lcp} good={data.lcp != null && data.lcp < 2500} />
            <MetricPill label="TTFB" value={data.ttfb} good={data.ttfb != null && data.ttfb < 800} />
            <MetricPill label="CLS" value={data.cls} unit="" good={data.cls != null && data.cls < 0.1} />
            {data.inp != null && <MetricPill label="INP" value={data.inp} good={data.inp <= 200} />}
          </div>
          {data.error && <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", width: "100%" }}>Error: {data.error}</p>}
        </div>
      )}
    </CardShell>
  );
}

// ─── VirusTotal Card ──────────────────────────────────────────────────────────
function VirusTotalCard({ data, loading, noKey }: { data: VirusTotalData | null; loading: boolean; noKey: boolean }) {
  const { t } = useLanguage();
  const flagged = data && !data.clean;
  return (
    <CardShell
      icon={flagged ? <Bug size={16} color="#EF4444" /> : <Bug size={16} color={data?.clean ? "#10B981" : "var(--color-text-secondary)"} />}
      title={t("healthVtTitle") || "VirusTotal"}
      loading={loading}
      topRight={data && !noKey ? <StatusBadge ok={data.clean} label={data.clean ? (t("healthSbClean") || "Clean") : (t("healthVtThreats") || "{count} threats").replace("{count}", String(data.malicious + data.suspicious))} /> : undefined}
    >
      {noKey && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            {t("healthVtNoKey") || "Add a VirusTotal API key in Settings → API Keys to enable this check."}
          </p>
          <a href="https://www.virustotal.com/gui/my-apikey" target="_blank" rel="noreferrer"
            style={{ fontSize: "11px", color: "var(--color-accent-blue)", display: "inline-flex", alignItems: "center", gap: "3px" }}>
            {t("healthSbGetApiKey") || "Get API key"} <ExternalLink size={10} />
          </a>
        </div>
      )}
      {!noKey && !data && !loading && (
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("healthNotChecked") || "Not checked yet"}</p>
      )}
      {!noKey && data && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {data.total > 0 && (
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              {[
                { l: t("healthVtMalicious") || "Malicious",  v: data.malicious,  color: data.malicious  > 0 ? "#EF4444" : "#10B981" },
                { l: t("healthVtSuspicious") || "Suspicious", v: data.suspicious, color: data.suspicious > 0 ? "#F59E0B" : "#10B981" },
                { l: t("healthVtClean") || "Clean",      v: data.undetected, color: "var(--color-text-secondary)" },
                { l: t("healthVtTotal") || "Total",      v: data.total,      color: "var(--color-text-secondary)" },
              ].map(({ l, v, color }) => (
                <div key={l} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "10px", color: "var(--color-text-secondary)", marginBottom: "2px" }}>{l}</div>
                  <div style={{ fontSize: "18px", fontWeight: 700, color }}>{v}</div>
                </div>
              ))}
            </div>
          )}
          {data.error && <p style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>Error: {data.error}</p>}
        </div>
      )}
    </CardShell>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────
export function SiteHealthPanel({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [health, setHealth]     = useState<HealthData | null>(null);
  const [loading, setLoading]   = useState(false);
  const [checking, setChecking] = useState(false);

  // API keys from localStorage
  const [sbKey, setSbKey]   = useState("");
  const [gKey, setGKey]     = useState("");
  const [vtKey, setVtKey]   = useState("");

  useEffect(() => {
    setSbKey(localStorage.getItem("healthKey_safeBrowsing") ?? "");
    setGKey(localStorage.getItem("healthKey_google") ?? "");
    setVtKey(localStorage.getItem("healthKey_virusTotal") ?? "");
  }, []);

  const fetchCached = useCallback(async () => {
    if (!siteDbId) return;
    setLoading(true);
    try {
      const res = await fetch(withShare(`/api/gsc/health?siteId=${encodeURIComponent(siteDbId)}`));
      const data = await res.json();
      setHealth(data);
    } catch {}
    setLoading(false);
  }, [siteDbId]);

  useEffect(() => { fetchCached(); }, [fetchCached]);

  const runChecks = async () => {
    if (!siteDbId) return;
    setChecking(true);
    try {
      const res = await fetch("/api/gsc/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, safeBrowsingKey: sbKey, googleApiKey: gKey, virusTotalKey: vtKey }),
      });
      const data = await res.json();
      setHealth(data);
    } catch {}
    setChecking(false);
  };

  const checkedAt = health?.checkedAt ? new Date(health.checkedAt) : null;
  const ageLabel  = checkedAt
    ? checkedAt.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const hasAnyData = health?.ssl || health?.safeBrowsing || health?.vitals || health?.virusTotal;

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: "24px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h2 style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("healthTitle") || "Site Health"}</h2>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "4px 0 0" }}>
            {t("healthDesc") || "SSL, Safe Browsing, Core Web Vitals, and malware checks."}
            {ageLabel && <span style={{ marginLeft: "8px" }}><Clock size={11} style={{ display: "inline", verticalAlign: "middle", marginRight: "3px" }} />{(t("healthChecked") || "Checked {time}").replace("{time}", ageLabel)}</span>}
          </p>
        </div>
        {!isGuestView() && <button
          onClick={runChecks}
          disabled={checking || loading}
          style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "9px 18px", borderRadius: "8px",
            background: "var(--color-accent-blue)", color: "#fff",
            fontSize: "13px", fontWeight: 600, border: "none", cursor: checking ? "not-allowed" : "pointer",
            opacity: checking || loading ? 0.7 : 1,
          }}
        >
          <RefreshCw size={13} style={{ animation: checking ? "spin 1s linear infinite" : "none" }} />
          {checking ? (t("healthChecking") || "Checking…") : hasAnyData ? (t("healthRecheck") || "Re-check") : (t("healthRunChecks") || "Run Checks")}
        </button>}
      </div>

      {/* Cards grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "16px" }}>
        <SslCard          data={health?.ssl ?? null}          loading={checking || (loading && !health)} />
        <SafeBrowsingCard data={health?.safeBrowsing ?? null} loading={checking || (loading && !health)} noKey={!sbKey} />
        <VitalsCard       data={health?.vitals ?? null}       loading={checking || (loading && !health)} noKey={!gKey} />
        <VirusTotalCard   data={health?.virusTotal ?? null}   loading={checking || (loading && !health)} noKey={!vtKey} />
      </div>

      {/* Info note */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", padding: "12px 14px", background: "rgba(255,255,255,0.04)", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
        <Info size={14} style={{ color: "var(--color-text-secondary)", flexShrink: 0, marginTop: "1px" }} />
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6, margin: 0 }}>
          {t("healthCacheNote") || "Results are cached for 24 hours. SSL check runs directly from your server with no API key needed. Safe Browsing, Core Web Vitals, and VirusTotal require API keys — add them in"}{" "}
          <a href="/settings" style={{ color: "var(--color-accent-blue)" }}>{t("healthSettingsApiKeys") || "Settings → API Keys"}</a>.
        </p>
      </div>

    </div>
  );
}

// Export a lightweight status summary for use in SiteCard
export function useHealthStatus(siteDbId: string | null) {
  const [status, setStatus] = useState<"ok" | "warn" | "error" | null>(null);

  useEffect(() => {
    if (!siteDbId) return;
    fetch(withShare(`/api/gsc/health?siteId=${encodeURIComponent(siteDbId)}`))
      .then(r => r.json())
      .then((d: HealthData) => {
        if (!d.ssl && !d.safeBrowsing && !d.virusTotal) { setStatus(null); return; }
        const hasError =
          (d.ssl && !d.ssl.valid) ||
          (d.safeBrowsing && !d.safeBrowsing.safe) ||
          (d.virusTotal && !d.virusTotal.clean);
        const hasWarn =
          (d.ssl && d.ssl.valid && d.ssl.daysLeft <= 14) ||
          (d.vitals && d.vitals.score != null && d.vitals.score < 50);
        setStatus(hasError ? "error" : hasWarn ? "warn" : "ok");
      })
      .catch(() => {});
  }, [siteDbId]);

  return status;
}
