"use client";

// Import of Ahrefs/Semrush export files into the shared metric cache.
//
// Deliberately self-contained and prop-free so it can be dropped anywhere later — a standalone
// page, a panel inside Striking Distance, a modal on a site page — without being rewritten.
// Where it eventually belongs is not settled; what is settled is that it must not have to move
// its logic when that is decided.

import { useEffect, useRef, useState } from "react";
import { Upload, FileUp, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES } from "@/lib/seo/regions";

type Result =
  | { ok: true; kind: string; parsed: number; written: number }
  | { ok: false; error: string; headers?: string[] };

interface SiteOption { id: string; url: string }

export default function MetricsImport({ defaultCountry = "us" }: { defaultCountry?: string }) {
  const { t } = useLanguage();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [country, setCountry] = useState(defaultCountry);
  const [provider, setProvider] = useState<"ahrefs" | "semrush">("ahrefs");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  // A referring-domains export lists links pointing at something the file never names, so that
  // one report needs a target. Loaded unconditionally rather than on demand: the alternative is
  // discovering the requirement only after the upload fails.
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState("");

  useEffect(() => {
    fetch("/api/gsc/sites")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const list: SiteOption[] = (d?.sites ?? []).map((x: any) => ({ id: x.id, url: x.url }));
        setSites(list);
        if (list.length) setSiteId(prev => prev || list[0].id);
      })
      .catch(() => {});
  }, []);

  async function run() {
    if (!file || busy) return;
    setBusy(true); setResult(null);

    const form = new FormData();
    form.append("file", file);
    form.append("country", country);
    form.append("provider", provider);
    if (siteId) form.append("siteId", siteId);
    // An export describes the day it was generated, not the day it was uploaded. Sending the
    // file's own timestamp is what stops a stale download from overwriting fresher data that
    // was fetched in the meantime.
    if (file.lastModified) form.append("observedAt", new Date(file.lastModified).toISOString());

    try {
      const res = await fetch("/api/metrics/import", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) setResult({ ok: false, error: String(data.error || "importFailed"), headers: data.headers });
      else setResult({ ok: true, kind: data.kind, parsed: data.parsed, written: data.written });
    } catch {
      setResult({ ok: false, error: "importFailed" });
    }
    setBusy(false);
  }

  const errorText = (code: string) => {
    if (code === "empty_file") return t("importEmpty");
    if (code === "too_large") return t("importTooLarge");
    if (code === "unknown_report") return t("importUnknown");
    if (code === "need_site") return t("importNeedSite");
    return t("importFailed");
  };

  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <FileUp size={17} color="var(--color-accent-blue)" />
        <h2 style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("importTitle")}</h2>
      </div>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 16px" }}>{t("importSub")}</p>

      {/* Drop zone */}
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault(); setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) { setFile(f); setResult(null); }
        }}
        style={{
          border: `1px dashed ${dragging ? "var(--color-accent-blue)" : "var(--color-border)"}`,
          borderRadius: "var(--radius-md)", padding: "28px 20px", textAlign: "center", cursor: "pointer",
          background: dragging ? "color-mix(in srgb, var(--color-accent-blue) 8%, transparent)" : "var(--color-bg)", transition: "all 0.15s",
        }}
      >
        <Upload size={20} style={{ color: "var(--color-text-secondary)", marginBottom: "8px" }} />
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)" }}>
          {file ? file.name : t("importDrop")}
        </div>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "4px" }}>{t("importFormats")}</div>
      </div>
      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" style={{ display: "none" }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); setResult(null); } }} />

      {/* Options + run */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: "10px", marginTop: "14px", flexWrap: "wrap" }}>
        <div>
          <span className="tool-field-label">{t("importProvider")}</span>
          <select className="tool-input inline" value={provider} onChange={e => setProvider(e.target.value as "ahrefs" | "semrush")}>
            <option value="ahrefs">Ahrefs</option>
            <option value="semrush">Semrush</option>
          </select>
        </div>
        {sites.length > 0 && (
          <div>
            <span className="tool-field-label">{t("importSite")}</span>
            <select className="tool-input inline" value={siteId} onChange={e => setSiteId(e.target.value)}>
              {sites.map(s2 => <option key={s2.id} value={s2.id}>{s2.url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "")}</option>)}
            </select>
          </div>
        )}
        <div>
          {/* Exports do not reliably state which market the figures are for, and a US volume
              filed under the wrong country is worse than no volume at all. */}
          <span className="tool-field-label">{t("importCountry")}</span>
          <select className="tool-input inline" value={country} onChange={e => setCountry(e.target.value)}>
            {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select>
        </div>
        {/* Import is free, so it deliberately does NOT use .metric-action — that style is
            reserved for the buttons that spend credits, and blurring the two would make the
            warning meaningless. */}
        <button onClick={run} disabled={!file || busy}
          style={{
            display: "flex", alignItems: "center", gap: "6px", padding: "9px 16px",
            borderRadius: "var(--radius-sm)", border: "none",
            background: !file || busy ? "var(--color-border-soft)" : "var(--color-text-primary)",
            color: !file || busy ? "var(--color-text-tertiary)" : "var(--color-bg)",
            fontSize: "13px", fontWeight: 700, cursor: !file || busy ? "not-allowed" : "pointer",
          }}>
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          {busy ? t("importRunning") : t("importRun")}
        </button>
      </div>

      {/* Outcome */}
      {result?.ok && (
        <div style={{ marginTop: "14px", padding: "11px 14px", borderRadius: "var(--radius-sm)", background: "color-mix(in srgb, var(--color-success) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--color-success) 25%, transparent)", fontSize: "13px", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
          <CheckCircle2 size={15} color="var(--color-success)" />
          <span>
            {result.kind === "keywords" ? t("importKindKeywords")
              : result.kind === "refdomains" ? t("importKindRefDomains")
              : t("importKindDomains")} · {result.parsed} {t("importRows")} · {result.written} {t("importWritten")}
          </span>
        </div>
      )}
      {result && !result.ok && (
        <div style={{ marginTop: "14px", padding: "11px 14px", borderRadius: "var(--radius-sm)", background: "color-mix(in srgb, var(--color-danger) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--color-danger) 25%, transparent)", fontSize: "13px", color: "var(--color-danger)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <AlertTriangle size={15} />
            <span>{errorText(result.error)}</span>
          </div>
          {/* Showing the columns we actually saw turns "unrecognised" from a dead end into
              something the user (or an issue report) can act on. */}
          {result.headers?.length ? (
            <div style={{ marginTop: "6px", fontSize: "11px", fontFamily: "monospace", color: "var(--color-text-secondary)", wordBreak: "break-all" }}>
              {result.headers.join(" · ")}
            </div>
          ) : null}
        </div>
      )}

      <div style={{ marginTop: "16px", padding: "11px 14px", borderRadius: "var(--radius-sm)", background: "color-mix(in srgb, var(--color-accent-blue) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--color-accent-blue) 20%, transparent)", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--color-text-primary)" }}>{t("importWhy")}.</strong> {t("importWhyText")}
      </div>
    </div>
  );
}
