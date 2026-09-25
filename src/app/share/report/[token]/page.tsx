"use client";

// N8 — the client-facing report page (CONTRACT §0.7): a token opens exactly one report's
// frozen snapshots — never the site dashboard, never other reports, and there is not a
// single control here that changes anything. The branding shown is the workspace's
// white-label identity; OpenGSC is named only if the operator opted in.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Download, FileText, Globe } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

interface ShareRun {
  id: string;
  createdAt: string;
  periodFrom: string;
  periodTo: string;
  hasPdf: boolean;
}

interface ShareData {
  report: { title: string; siteDomain: string };
  branding: { companyName: string; logoDataUrl: string; accentColor: string; footer: string; website: string };
  runs: ShareRun[];
}

export default function ClientReportSharePage() {
  const { t } = useLanguage();
  const params = useParams();
  const token = String(params?.token ?? "");
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    // No synchronous setState here: `loading` starts true and only the awaited fetch's
    // result flips it, so the effect cannot cascade renders (token is stable per mount).
    fetch(`/api/reports/share/${encodeURIComponent(token)}`)
      .then(r => {
        if (!r.ok) throw new Error(r.status === 503 ? String(t("autoSyncNotMigrated") || "not migrated") : "not_found");
        return r.json();
      })
      .then((d: ShareData) => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(String(e?.message ?? "not_found")); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, t]);

  const box: React.CSSProperties = {
    minHeight: "100vh", background: "var(--color-bg)", display: "flex",
    alignItems: "flex-start", justifyContent: "center", padding: "32px 16px",
    color: "var(--color-text-primary)", fontFamily: "Inter, sans-serif",
  };

  if (loading) {
    return (
      <div style={box}>
        <div style={{ textAlign: "center", color: "var(--color-text-secondary)" }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", border: "3px solid var(--color-border)", borderTopColor: "var(--color-accent, #3B82F6)", animation: "spin 0.8s linear infinite", margin: "0 auto 14px" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          {t("shareLoading") || "Loading..."}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={box}>
        <div className="card" style={{ maxWidth: 440, textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
          <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 8px" }}>{t("shareAccessDenied") || "Access denied"}</h2>
          <p style={{ fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.5, margin: 0 }}>
            {t("repShareInvalid" as never) || "This report link is invalid or has been revoked."}
          </p>
        </div>
      </div>
    );
  }

  const accent = data.branding.accentColor || "#2563eb";
  const base = `/api/reports/share/${encodeURIComponent(token)}`;

  return (
    <div style={box}>
      <div style={{ width: "100%", maxWidth: 640 }}>
        <div className="card" style={{ padding: 22, display: "flex", alignItems: "flex-start", gap: 14, borderTop: `3px solid ${accent}` }}>
          {data.branding.logoDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a client-supplied data-URL, not a Next image
            <img src={data.branding.logoDataUrl} alt={data.branding.companyName || "logo"} style={{ maxHeight: 44, maxWidth: 170, objectFit: "contain" }} />
          )}
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>{data.report.title}</h1>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 4, display: "flex", alignItems: "center", gap: 5 }}>
              <Globe size={13} /> {data.report.siteDomain}
            </div>
            {data.branding.companyName && (
              <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                {data.branding.companyName}
                {data.branding.website ? ` · ${data.branding.website.replace(/^https?:\/\//, "")}` : ""}
              </div>
            )}
          </div>
        </div>

        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", margin: "18px 2px 8px", fontWeight: 600 }}>
          {t("repRuns") || "Sent reports"}
        </div>

        {data.runs.length === 0 ? (
          <div className="card" style={{ padding: 18, color: "var(--color-text-secondary)", fontSize: 13 }}>
            {t("repNoData") || "No data for this period"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.runs.map(run => (
              <div key={run.id} className="card" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <FileText size={16} style={{ color: accent, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{run.periodFrom} — {run.periodTo}</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{new Date(run.createdAt).toLocaleString()}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <a
                    className="btn" role="button" href={`${base}?run=${encodeURIComponent(run.id)}&format=html`}
                    target="_blank" rel="noreferrer"
                    aria-label={`${t("repDownloadHtml") || "Download HTML"} ${run.periodFrom}`}
                    style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                  >
                    <FileText size={13} /> {t("repDownloadHtml") || "HTML"}
                  </a>
                  {run.hasPdf ? (
                    <a
                      className="btn" role="button" href={`${base}?run=${encodeURIComponent(run.id)}&format=pdf`}
                      aria-label={`${t("repDownloadPdf") || "Download PDF"} ${run.periodFrom}`}
                      style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid transparent", background: accent, color: "#fff", fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                    >
                      <Download size={13} /> PDF
                    </a>
                  ) : (
                    <span
                      className="pill" title={t("repPdfUnavailable") || "PDF unavailable"}
                      style={{ padding: "7px 12px", fontSize: 11, border: "1px dashed var(--color-border)", color: "var(--color-text-secondary)", borderRadius: 8 }}
                    >
                      {t("repPdfUnavailable") || "PDF unavailable"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {data.branding.footer && (
          <div style={{ marginTop: 22, fontSize: 12, color: "var(--color-text-tertiary)", textAlign: "center" }}>
            {data.branding.footer}
          </div>
        )}
      </div>
    </div>
  );
}
