"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Fingerprint, Globe2, Info, Layers, Loader2, Radar, Search, Server,
  ShieldAlert, Trash2, XCircle,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

type Finding = { id: string; severity: "critical" | "warning" | "info"; evidence?: string };
type Related = { host: string; scanId: string; matches: string[]; strength: "strong" | "weak" };
type Report = {
  url: string; finalUrl: string; host: string; https: boolean; httpStatus: number; redirected: boolean;
  loadMs: number; bytes: number;
  facts: { title: string; titleLength: number; metaDescription: string; h1Count: number; wordCount: number; canonical: string | null; robots: string; indexable: boolean | null; schemaBlocks: number; imagesNoAlt: number; language: string };
  findings: Finding[]; score: number;
  platform: { cms: string | null; generator: string | null; framework: string | null; server: string | null; poweredBy: string | null; hints: string[]; wordpress?: { themes: string[]; plugins: string[]; restUsers: string[]; xmlrpc: boolean; readme: boolean } };
  infra: { ips: string[]; nameservers: string[]; mx: string[]; cdn: string | null };
  scale: { sitemaps: string[]; sitemapUrls: number | null; languages: string[] };
  ai: { robotsTxt: boolean; llmsTxt: boolean; blockedBots: string[] };
  fingerprints: Record<string, any>;
  scannedAt: string;
};
type Scan = {
  id: string; host: string; url: string; finalUrl: string | null; status: string; httpStatus: number;
  score: number | null; error: string | null; report: Report | null; createdAt: string; related: Related[];
};

export default function CrawlerPage() {
  const { t } = useLanguage();
  const [target, setTarget] = useState("");
  const [scans, setScans] = useState<Scan[]>([]);
  const [current, setCurrent] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notMigrated, setNotMigrated] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/scan", { cache: "no-store" });
      const body = await res.json();
      if (body.notMigrated) { setNotMigrated(true); return; }
      setScans(Array.isArray(body.scans) ? body.scans : []);
    } catch { /* the list is a convenience; a failure here must not block a new scan */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function scan() {
    if (!target.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: target.trim() }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "scan_failed");
      setCurrent(body.scan);
      if (body.scan?.status === "error") setError(body.scan.error || "scan_failed");
      void load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "scan_failed"); }
    finally { setBusy(false); }
  }

  async function open(id: string) {
    const res = await fetch(`/api/scan/${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await res.json();
    if (res.ok) setCurrent(body.scan);
  }

  async function remove(id: string) {
    if (!window.confirm(t("crawlerDeleteConfirm" as any))) return;
    await fetch(`/api/scan/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (current?.id === id) setCurrent(null);
    void load();
  }

  const report = current?.report;

  return <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 20, paddingBottom: 40 }}>
    <div>
      <h1 style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 22, margin: 0, color: "var(--color-text-primary)" }}>
        <Radar size={20} /> {t("crawlerTitle" as any)}
      </h1>
      <p style={{ ...hint, marginTop: 6, maxWidth: 820 }}>{t("crawlerSubtitle" as any)}</p>
    </div>

    {notMigrated && <div className="panel" style={{ color: "var(--color-accent-orange)" }}>
      <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{t("crawlerNotMigrated" as any)}
    </div>}

    <div className="panel" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <Search size={16} color="var(--color-text-tertiary)" />
      <input
        className="tool-input" style={{ flex: 1, minWidth: 240 }} value={target}
        onChange={e => setTarget(e.target.value)} onKeyDown={e => e.key === "Enter" && scan()}
        placeholder="competitor.com"
      />
      <button onClick={scan} disabled={busy || !target.trim()} style={primary}>
        {busy ? <Loader2 className="spin" size={14} /> : <Radar size={14} />} {t("crawlerRun" as any)}
      </button>
    </div>

    {error && <div className="panel" style={{ borderColor: "rgba(255,69,58,.35)", color: "#ff6b62", fontSize: 13 }}>
      {t(`crawlerError_${error}` as any) !== `crawlerError_${error}` ? t(`crawlerError_${error}` as any) : `${t("crawlerFailed" as any)}: ${error}`}
    </div>}

    <div className="crawler-grid">
      <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--color-border)", fontSize: 13, fontWeight: 700 }}>
          {t("crawlerHistory" as any)} · {scans.length}
        </div>
        {!scans.length && <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--color-text-secondary)" }}>{t("crawlerNoScans" as any)}</div>}
        {scans.map(item => <div key={item.id} style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--color-border)" }}>
          <button onClick={() => open(item.id)} style={{ flex: 1, minWidth: 0, textAlign: "left", border: 0, background: item.id === current?.id ? "rgba(41,151,255,.07)" : "transparent", color: "var(--color-text-primary)", padding: "11px 14px", cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {item.status === "completed" ? <CheckCircle2 size={13} color={scoreColor(item.score ?? 0)} /> : <XCircle size={13} color="#ff453a" />}
              <b style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{item.host}</b>
              {item.score != null && <span style={{ color: scoreColor(item.score), fontWeight: 800, fontSize: 12 }}>{item.score}</span>}
            </div>
            <small style={{ display: "block", marginTop: 3, color: "var(--color-text-tertiary)" }}>{new Date(item.createdAt).toLocaleString()}</small>
          </button>
          <button onClick={() => remove(item.id)} title={t("crawlerDelete" as any)} style={{ border: 0, background: "transparent", color: "var(--color-text-tertiary)", padding: "0 10px", cursor: "pointer" }}><Trash2 size={13} /></button>
        </div>)}
      </div>

      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        {!report ? <div className="panel" style={{ padding: 34, textAlign: "center", color: "var(--color-text-secondary)" }}>{t("crawlerSelect" as any)}</div> : <>
          <div className="panel" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ width: 68, height: 68, borderRadius: "50%", display: "grid", placeItems: "center", border: `4px solid ${scoreColor(report.score)}`, color: scoreColor(report.score), fontSize: 21, fontWeight: 850 }}>{report.score}</div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{report.host}</h2>
              <a href={report.finalUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--color-accent-blue)" }}>{report.finalUrl}</a>
              <div style={{ ...hint, marginTop: 5 }}>
                HTTP {report.httpStatus} · {report.https ? "HTTPS" : "HTTP"} · {report.loadMs} ms · {Math.round(report.bytes / 1024)} KB
                {report.redirected && ` · ${t("crawlerRedirected" as any)}`}
              </div>
            </div>
          </div>

          {current?.related?.length ? <div className="panel">
            <h3 style={sectionTitle}><Fingerprint size={15} /> {t("crawlerRelated" as any)} · {current.related.length}</h3>
            <p style={hint}>{t("crawlerRelatedHint" as any)}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
              {current.related.map(item => <div key={item.scanId} style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap", padding: "8px 10px", borderRadius: 8, background: item.strength === "strong" ? "rgba(255,69,58,.08)" : "var(--color-bg)", border: `1px solid ${item.strength === "strong" ? "rgba(255,69,58,.25)" : "var(--color-border)"}` }}>
                <b style={{ fontSize: 12 }}>{item.host}</b>
                <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", color: item.strength === "strong" ? "#ff6b62" : "var(--color-text-tertiary)" }}>
                  {t(item.strength === "strong" ? "crawlerStrong" : "crawlerWeak" as any)}
                </span>
                <span style={{ flex: 1, minWidth: 180, fontSize: 11, color: "var(--color-text-secondary)" }}>{item.matches.join(" · ")}</span>
                <button onClick={() => open(item.scanId)} style={ghost}>{t("crawlerOpen" as any)}</button>
              </div>)}
            </div>
          </div> : null}

          <div className="panel">
            <h3 style={sectionTitle}><ShieldAlert size={15} /> {t("crawlerFindings" as any)} · {report.findings.length}</h3>
            {!report.findings.length ? <p style={{ ...hint, color: "var(--color-accent-green)" }}>{t("crawlerNoFindings" as any)}</p>
              : <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8 }}>
                {report.findings.map((f, i) => {
                  const color = f.severity === "critical" ? "#ff453a" : f.severity === "warning" ? "#ff9f0a" : "#64d2ff";
                  return <div key={`${f.id}-${i}`} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 11px", borderRadius: 8, border: `1px solid ${color}30`, background: `${color}0a` }}>
                    {f.severity === "critical" ? <XCircle size={14} color={color} style={{ marginTop: 1 }} /> : f.severity === "warning" ? <AlertTriangle size={14} color={color} style={{ marginTop: 1 }} /> : <Info size={14} color={color} style={{ marginTop: 1 }} />}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ fontSize: 12 }}>{t((ISSUE_KEYS[f.id] ?? f.id) as any)}</b>
                      {f.evidence && <small style={{ display: "block", color: "var(--color-text-secondary)", marginTop: 2, overflowWrap: "anywhere" }}>{f.evidence}</small>}
                    </span>
                  </div>;
                })}
              </div>}
          </div>

          <div className="crawler-cards">
            <Card icon={<Layers size={15} />} title={t("crawlerPlatform" as any)} rows={[
              [t("crawlerCms" as any), report.platform.cms ?? "—"],
              [t("crawlerFramework" as any), report.platform.framework ?? "—"],
              ["Generator", report.platform.generator ?? "—"],
              ["Server", report.platform.server ?? "—"],
              [t("crawlerStack" as any), report.platform.hints.join(", ") || "—"],
              ...(report.platform.wordpress ? [
                [t("crawlerWpTheme" as any), report.platform.wordpress.themes.join(", ") || "—"],
                [t("crawlerWpPlugins" as any), `${report.platform.wordpress.plugins.length}: ${report.platform.wordpress.plugins.slice(0, 8).join(", ")}`],
                [t("crawlerWpUsers" as any), report.platform.wordpress.restUsers.join(", ") || "—"],
              ] as [string, string][] : []),
            ]} />
            <Card icon={<Server size={15} />} title={t("crawlerInfra" as any)} rows={[
              ["IP", report.infra.ips.join(", ") || "—"],
              ["NS", report.infra.nameservers.join(", ") || "—"],
              ["MX", report.infra.mx.join(", ") || "—"],
              ["CDN", report.infra.cdn ?? "—"],
            ]} />
            <Card icon={<Globe2 size={15} />} title={t("crawlerScale" as any)} rows={[
              [t("crawlerSitemapUrls" as any), report.scale.sitemapUrls == null ? "—" : String(report.scale.sitemapUrls)],
              ["Sitemap", report.scale.sitemaps[0] ?? "—"],
              [t("crawlerLanguages" as any), report.scale.languages.join(", ") || "—"],
              ["robots.txt", report.ai.robotsTxt ? "✓" : "—"],
              ["llms.txt", report.ai.llmsTxt ? "✓" : "—"],
              [t("crawlerBlockedBots" as any), report.ai.blockedBots.join(", ") || "—"],
            ]} />
            <Card icon={<Info size={15} />} title={t("crawlerPage" as any)} rows={[
              ["Title", `${report.facts.title || "—"} (${report.facts.titleLength})`],
              ["Description", report.facts.metaDescription || "—"],
              ["H1", String(report.facts.h1Count)],
              [t("crawlerWords" as any), String(report.facts.wordCount)],
              ["Canonical", report.facts.canonical ?? "—"],
              ["JSON-LD", String(report.facts.schemaBlocks)],
              [t("crawlerIndexable" as any), report.facts.indexable == null ? "—" : report.facts.indexable ? "✓" : "noindex"],
            ]} />
          </div>
        </>}
      </div>
    </div>
  </div>;
}

function Card({ icon, title, rows }: { icon: React.ReactNode; title: string; rows: [string, string][] }) {
  return <div className="panel" style={{ minWidth: 0 }}>
    <h3 style={sectionTitle}>{icon} {title}</h3>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 6 }}>
      <tbody>
        {rows.map(([label, value]) => <tr key={label}>
          <td style={{ padding: "6px 8px 6px 0", color: "var(--color-text-tertiary)", whiteSpace: "nowrap", verticalAlign: "top", borderBottom: "1px solid var(--color-border)" }}>{label}</td>
          <td className="privacy-sensitive" style={{ padding: "6px 0", overflowWrap: "anywhere", borderBottom: "1px solid var(--color-border)" }}>{value}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

const ISSUE_KEYS: Record<string, string> = {
  https_unavailable: "publicCheckHttpsUnavailable", robots_txt_missing: "crawlerIssueRobotsMissing",
  sitemap_missing: "crawlerIssueSitemapMissing", wp_users_exposed: "crawlerIssueWpUsers",
  wp_xmlrpc_open: "crawlerIssueXmlrpc", wp_readme_public: "crawlerIssueReadme",
  http_error: "auditIssueHttpError", redirect: "auditIssueRedirect", redirect_chain: "auditIssueRedirectChain",
  title_missing: "auditIssueTitleMissing", title_too_long: "auditIssueTitleTooLong",
  description_missing: "auditIssueDescriptionMissing", description_too_long: "auditIssueDescriptionTooLong",
  h1_missing: "auditIssueH1Missing", h1_multiple: "auditIssueH1Multiple", noindex: "auditIssueNoindex",
  robots_conflict: "auditIssueRobotsConflict", canonical_missing: "auditIssueCanonicalMissing",
  canonical_invalid: "auditIssueCanonicalInvalid", canonical_mismatch: "auditIssueCanonicalMismatch",
  thin_content: "auditIssueThinContent", images_no_alt: "auditIssueImagesNoAlt",
  slow_response: "auditIssueSlowResponse", viewport_missing: "auditIssueViewportMissing",
  lang_missing: "auditIssueLangMissing", jsonld_invalid: "auditIssueJsonLdInvalid",
  organization_schema_incomplete: "auditIssueOrganizationSchemaIncomplete",
  open_graph_incomplete: "auditIssueOpenGraphIncomplete", twitter_card_incomplete: "auditIssueTwitterCardIncomplete",
  mixed_content: "auditIssueMixedContent", security_headers_missing: "auditIssueSecurityHeadersMissing",
};

function scoreColor(score: number) { return score >= 85 ? "#34c759" : score >= 65 ? "#ff9f0a" : "#ff453a"; }
const hint: React.CSSProperties = { fontSize: 12, lineHeight: 1.55, color: "var(--color-text-secondary)", margin: 0 };
const sectionTitle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, margin: "0 0 4px", color: "var(--color-text-primary)" };
const primary: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 15px", borderRadius: 9, border: 0, background: "var(--color-accent-blue)", color: "#fff", fontSize: 13, fontWeight: 650, cursor: "pointer" };
const ghost: React.CSSProperties = { padding: "5px 9px", borderRadius: 7, border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: 11, cursor: "pointer" };
