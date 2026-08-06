"use client";

// SERP-based keyword clustering: paste keywords → one TOP-10 per keyword → URL-overlap
// clusters = the page plan. Runs as a background job (survives tab close, lands in History).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Boxes, Loader2, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getSerpCreds, getKeywordSource } from "@/lib/seo/keys";
import { COUNTRIES, LANGUAGES } from "@/lib/seo/regions";
import { startJob, importJob } from "@/lib/seo/jobs";
import SeoJobProgress from "@/components/SeoJobProgress";

const card = "panel";
const inputStyle = "tool-input";
const btnPurple: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 16px", borderRadius: "9px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };

export default function ClusterPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const serpCreds = mounted ? getSerpCreds() : { provider: "", apiKey: "" };
  const kwSrc = mounted ? getKeywordSource() : { source: "off" as const, apiKey: "", baseUrl: undefined };

  const [raw, setRaw] = useState("");
  const [country, setCountry] = useState("us");
  const [language, setLanguage] = useState("en");
  const [threshold, setThreshold] = useState(3);
  const [useVolumes, setUseVolumes] = useState(true);
  const [err, setErr] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobKeyword, setJobKeyword] = useState("");

  const keywords = [...new Set(raw.split(/\n+/).map(s => s.trim().toLowerCase()).filter(Boolean))];

  async function run() {
    setErr("");
    if (keywords.length < 2) { setErr(t("seoClusterNeedKws")); return; }
    if (!serpCreds.apiKey) { setErr(t("seoErrNoSerpKey")); return; }
    const kw = `${keywords[0]} +${keywords.length - 1}`;
    const { jobId: jid, error } = await startJob("cluster", {
      keywords, gl: country, hl: language, threshold,
      serpProvider: serpCreds.provider, serpKey: serpCreds.apiKey,
      // Volumes now come from whichever source is configured, not from DataForSEO alone.
      ...(useVolumes && kwSrc.apiKey
        ? { kwSource: kwSrc.source, kwKey: kwSrc.apiKey, kwBaseUrl: kwSrc.baseUrl }
        : {}),
    }, {}, );
    if (error || !jid) { setErr(error || t("seoErrGen")); return; }
    setJobKeyword(kw); setJobId(jid);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}>
          <Boxes size={20} color="var(--color-accent-purple)" /> {t("seoClusterTitle")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("seoClusterSub")}</p>
      </div>

      {mounted && !serpCreds.apiKey && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("seoErrNoSerpKey")} <Link href="/seo-tools/settings" style={{ color: "var(--color-accent-blue)" }}>{t("seoSettingsShort")}</Link>
        </div>
      )}
      {err && <div className={card} style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "13px" }}>{err}</div>}

      {jobId ? (
        <SeoJobProgress
          jobId={jobId}
          keyword={jobKeyword}
          onDone={async (job) => { const rec = await importJob(job); setJobId(null); if (rec) router.push(`/seo-tools/history/${rec.id}`); }}
          onError={(m) => { setErr(m); setJobId(null); }}
          onCancel={() => setJobId(null)}
        />
      ) : (
        <div className={card}>
          <span className="tool-field-label">{t("seoClusterKwsLabel")} ({keywords.length})</span>
          <textarea className={inputStyle} style={{ minHeight: "220px", resize: "vertical", fontFamily: "monospace", fontSize: "12px" }} value={raw} onChange={e => setRaw(e.target.value)} placeholder={t("seoClusterKwsPh")} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginTop: "12px" }}>
            <div>
              <span className="tool-field-label">{t("seoCountry")}</span>
              <select className={inputStyle} value={country} onChange={e => setCountry(e.target.value)}>
                {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <span className="tool-field-label">{t("seoLanguage")}</span>
              <select className={inputStyle} value={language} onChange={e => setLanguage(e.target.value)}>
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <span className="tool-field-label">{t("seoClusterThreshold")}</span>
              <select className={inputStyle} value={threshold} onChange={e => setThreshold(Number(e.target.value))}>
                <option value={2}>2 — {t("seoClusterThLoose")}</option>
                <option value={3}>3 — {t("seoClusterThNormal")}</option>
                <option value={4}>4 — {t("seoClusterThStrict")}</option>
                <option value={5}>5 — {t("seoClusterThMax")}</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: "10px", padding: "10px 13px", borderRadius: "9px", background: "var(--color-bg)", border: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
            💡 {t("seoClusterThHint")}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer", marginTop: "12px" }}>
            <input type="checkbox" checked={useVolumes} onChange={e => setUseVolumes(e.target.checked)} disabled={!kwSrc.apiKey} />
            {t("seoClusterVolumes")} {!kwSrc.apiKey && <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>({t("seoClusterNeedKwSource")})</span>}
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "14px" }}>
            <button onClick={run} disabled={keywords.length < 2} style={{ ...btnPurple, opacity: keywords.length < 2 ? 0.6 : 1 }}>
              <Boxes size={15} /> {t("seoClusterStart")}
            </button>
            <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("seoClusterCostHint").replace("{n}", String(keywords.length))}</span>
          </div>
        </div>
      )}
    </div>
  );
}
