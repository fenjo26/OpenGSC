"use client";

// Import of Ahrefs/Semrush export files into the shared metric cache.
//
// This is not a "tool" — it is the second way to fill exactly the same cache an API key fills,
// which is why it lives next to the key in Settings → SEO Metrics rather than in the tools menu.
// It stays prop-free and self-contained so it can also be dropped onto a site page.

import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, FileUp, CheckCircle2, AlertTriangle, Loader2, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { COUNTRIES } from "@/lib/seo/regions";

type Result =
  | { ok: true; kind: string; parsed: number; written: number }
  | { ok: false; error: string; headers?: string[]; kind?: string };

interface SiteOption { id: string; url: string }

export default function MetricsImport({
  defaultCountry = "us",
  siteId: fixedSiteId,
}: {
  defaultCountry?: string;
  /** When rendered on a site page the target is already known — no picker is shown. */
  siteId?: string;
}) {
  const { t } = useLanguage();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [country, setCountry] = useState(defaultCountry);
  const [provider, setProvider] = useState<"ahrefs" | "semrush">("ahrefs");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);

  // A referring-domains export lists links pointing at something the file never names, so that
  // one report needs a target.
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState(fixedSiteId ?? "");
  const [siteQuery, setSiteQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (fixedSiteId) return; // target is fixed by the host page
    fetch("/api/gsc/sites")
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const list: SiteOption[] = (d?.sites ?? []).map((x: any) => ({ id: x.id, url: x.url }));
        setSites(list);
        if (list.length) setSiteId(prev => prev || list[0].id);
      })
      .catch(() => {});
  }, [fixedSiteId]);

  const label = (u: string) => u.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/$/, "");

  // A plain <select> is unusable past a few dozen entries, and portfolios here run to hundreds.
  const filtered = useMemo(() => {
    const q = siteQuery.trim().toLowerCase();
    const list = q ? sites.filter(s => label(s.url).toLowerCase().includes(q)) : sites;
    return list.slice(0, 60);
  }, [sites, siteQuery]);

  const selected = sites.find(s => s.id === siteId);

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
      if (!res.ok) setResult({ ok: false, error: String(data.error || "importFailed"), headers: data.headers, kind: data.kind });
      else setResult({ ok: true, kind: data.kind, parsed: data.parsed, written: data.written });
    } catch {
      setResult({ ok: false, error: "importFailed" });
    }
    setBusy(false);
  }

  const errorText = (code: string) => {
    if (code === "empty_file") return t("importEmpty");
    if (code === "no_data_rows") return t("importNoRows");
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

      {/* Source — first, because it decides how the numbers are stored */}
      <span className="tool-section-label">{t("importProvider")}</span>
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", alignItems: "center", flexWrap: "wrap" }}>
        {(["ahrefs", "semrush"] as const).map(p => (
          <button key={p} className={provider === p ? "pill active" : "pill"}
            onClick={() => setProvider(p)} style={{ cursor: "pointer" }}>
            {p === "ahrefs" ? "Ahrefs" : "Semrush"}
          </button>
        ))}
        <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
          {t("importProviderHint")}
        </span>
      </div>

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
          background: dragging ? "color-mix(in srgb, var(--color-accent-blue) 8%, transparent)" : "var(--color-bg)",
          transition: "all 0.15s",
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
        {!fixedSiteId && sites.length > 0 && (
          <div style={{ position: "relative", minWidth: "240px" }}>
            <span className="tool-field-label">{t("importSite")}</span>
            <div style={{ position: "relative" }}>
              <Search size={13} style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "var(--color-text-secondary)", pointerEvents: "none" }} />
              <input className="tool-input" style={{ paddingLeft: "30px" }}
                value={pickerOpen ? siteQuery : (selected ? label(selected.url) : "")}
                placeholder={t("importSiteSearch")}
                onFocus={() => { setPickerOpen(true); setSiteQuery(""); }}
                onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
                onChange={e => setSiteQuery(e.target.value)} />
            </div>
            {pickerOpen && (
              <div style={{
                position: "absolute", zIndex: 20, top: "100%", left: 0, right: 0, marginTop: "4px",
                maxHeight: "260px", overflowY: "auto", background: "var(--color-card)",
                border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              }}>
                {filtered.map(s => (
                  <button key={s.id} onMouseDown={() => { setSiteId(s.id); setPickerOpen(false); }}
                    style={{
                      display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
                      background: s.id === siteId ? "var(--color-border-soft)" : "transparent",
                      border: "none", cursor: "pointer", fontSize: "13px", color: "var(--color-text-primary)",
                    }}>
                    {label(s.url)}
                  </button>
                ))}
                {!filtered.length && (
                  <div style={{ padding: "10px 12px", fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("importSiteNone")}</div>
                )}
                {/* Capped list: rendering a thousand rows to a dropdown is slow and unreadable,
                    and the search box is the way through it. */}
                {sites.length > filtered.length && (
                  <div style={{ padding: "7px 12px", fontSize: "11px", color: "var(--color-text-tertiary)", borderTop: "1px solid var(--color-border)" }}>
                    {t("importSiteMore")}
                  </div>
                )}
              </div>
            )}
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
          {/* When the report WAS recognised but held no rows, say so — otherwise "no data" reads
              as "wrong format" and sends people looking for a parser bug that isn't there. */}
          {result.error === "no_data_rows" && result.kind && (
            <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
              {t("importRecognisedAs")}: {result.kind === "keywords" ? t("importKindKeywords") : result.kind === "refdomains" ? t("importKindRefDomains") : t("importKindDomains")}
            </div>
          )}
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
