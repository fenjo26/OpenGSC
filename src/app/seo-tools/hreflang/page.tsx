"use client";

// Hreflang generator (N1) — the constructive side of October's hreflang audit. The portfolio
// runs `/` in French and `/en/` in English; this page turns that layout into ready markup:
// rows of URL · language (typed by hand or derived from prefix rules), grouped by common path
// tail, validated with the audit's own predicates, and emitted in the three forms annotations
// can take — <head> tags, a sitemap block, an HTTP `Link:` header — plus a live check of what
// the pages carry today.

import { useMemo, useState } from "react";
import { Loader2, Languages, Copy, Download, Check, Globe, AlertTriangle, Wand2, ListTree } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  applyPrefixRules, groupHreflang, pageSet, renderHreflang,
  type HreflangInput, type PrefixRule,
} from "@/lib/hreflang";

interface VerifyRow {
  url: string;
  httpStatus: number;
  reachable: boolean;
  matches: boolean;
  missing: { lang: string; href: string }[];
  extra: { lang: string; href: string }[];
  error?: string;
}

const pill: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 9px",
  borderRadius: "999px", fontSize: "11px", fontWeight: 600,
  border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)",
};
const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "9px",
  border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "12px",
  fontWeight: 600, cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "9px",
  border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)",
  fontSize: "12px", fontWeight: 600, cursor: "pointer",
};

/** "https://site.fr/en/demo/  en" or "https://site.fr/en/demo/ | en" → row. */
function parseRows(text: string): HreflangInput[] {
  const rows: HreflangInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^(\S+)\s*[|,;]?\s+([a-zA-Z-]{2,10})$/) || s.match(/^(\S+)\s*[|,;\t]\s*([a-zA-Z-]{2,10})$/);
    if (m) rows.push({ url: m[1], lang: m[2] });
  }
  return rows;
}

export default function HreflangPage() {
  const { t } = useLanguage();
  // Dynamic i18n keys (the tab labels come from an array, so the dictionary key type cannot
  // follow) — one typed alias instead of `any` at each call site.
  const tt = (key: string) => t(key as never);
  // input mode A: explicit rows; mode B: URL list + prefix rules
  const [mode, setMode] = useState<"rows" | "prefix">("rows");
  const [rowsText, setRowsText] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [prefixText, setPrefixText] = useState("/en/\ten\n/\tfr");
  const [xDefault, setXDefault] = useState("");
  const [tab, setTab] = useState<"head" | "sitemap" | "header">("head");
  const [copied, setCopied] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyRows, setVerifyRows] = useState<VerifyRow[] | null>(null);
  const [verifyErr, setVerifyErr] = useState("");

  const rows: HreflangInput[] = useMemo(() => {
    if (mode === "rows") return parseRows(rowsText);
    const urls = urlsText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const rules: PrefixRule[] = [];
    for (const line of prefixText.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const m = s.match(/^(\S*|\/)\s*[|,;\t]\s*(\S+)$/);
      if (m) rules.push({ prefix: m[1] === "/" ? "/" : m[1], lang: m[2] });
    }
    return urls.length ? applyPrefixRules(urls, rules).rows : [];
  }, [mode, rowsText, urlsText, prefixText]);

  const grouped = useMemo(() => groupHreflang(rows), [rows]);
  const rendered = useMemo(() => renderHreflang(grouped.clusters, xDefault || null), [grouped, xDefault]);
  const allUrls = useMemo(() => grouped.clusters.flatMap(c => c.entries.map(e => e.href)), [grouped]);

  const output = tab === "head" ? rendered.head : tab === "sitemap" ? rendered.sitemap : rendered.header;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1500);
    } catch { /* clipboard unavailable — the textarea stays selectable */ }
  }

  function downloadXml() {
    const blob = new Blob([rendered.sitemapXml], { type: "application/xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hreflang-sitemap.xml";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function verify() {
    if (!grouped.clusters.length) return;
    setVerifying(true); setVerifyErr(""); setVerifyRows(null);
    try {
      const pages = grouped.clusters.slice(0, 50).map(c => ({
        url: c.entries[0].href,
        expected: pageSet(c, xDefault || null),
      }));
      const r = await fetch("/seo-tools/hreflang/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages }),
      });
      const d = await r.json();
      if (!r.ok) setVerifyErr(d.error || "error");
      else setVerifyRows(d.results ?? []);
    } catch (e) {
      setVerifyErr(String((e as Error)?.message ?? e));
    }
    setVerifying(false);
  }

  const tabBtn = (id: "head" | "sitemap" | "header", key: string) => (
    <button key={id} onClick={() => setTab(id)}
      style={{ padding: "6px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === id ? "var(--color-accent-purple)" : "var(--color-bg)", color: tab === id ? "#fff" : "var(--color-text-secondary)" }}>
      {tt(key)}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}>
          <Languages size={20} color="var(--color-accent-purple)" /> {t("hlTitle")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("hlHint")}</p>
      </div>

      {/* Input */}
      <div className="panel">
        <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
          <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
            <button onClick={() => setMode("rows")} style={{ padding: "6px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: mode === "rows" ? "var(--color-text-primary)" : "var(--color-bg)", color: mode === "rows" ? "var(--color-bg)" : "var(--color-text-secondary)", display: "inline-flex", gap: "6px", alignItems: "center" }}><ListTree size={13} /> URL · lang</button>
            <button onClick={() => setMode("prefix")} style={{ padding: "6px 12px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: mode === "prefix" ? "var(--color-text-primary)" : "var(--color-bg)", color: mode === "prefix" ? "var(--color-bg)" : "var(--color-text-secondary)", display: "inline-flex", gap: "6px", alignItems: "center" }}><Wand2 size={13} /> {t("hlPrefixRule")}</button>
          </div>
        </div>
        {mode === "rows" ? (
          <textarea className="tool-input" style={{ width: "100%", minHeight: "130px", resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: "12px" }}
            value={rowsText} onChange={e => setRowsText(e.target.value)}
            placeholder={"https://site.fr/demo/  fr\nhttps://site.fr/en/demo/  en"} />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px" }}>
            <div>
              <div className="tool-section-label" style={{ marginBottom: "5px" }}>URLs</div>
              <textarea className="tool-input" style={{ width: "100%", minHeight: "110px", resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: "12px" }}
                value={urlsText} onChange={e => setUrlsText(e.target.value)}
                placeholder={"https://site.fr/demo/\nhttps://site.fr/en/demo/\nhttps://site.fr/guide/"} />
            </div>
            <div>
              <div className="tool-section-label" style={{ marginBottom: "5px" }}>{t("hlPrefixRule")}</div>
              <textarea className="tool-input" style={{ width: "100%", minHeight: "110px", resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: "12px" }}
                value={prefixText} onChange={e => setPrefixText(e.target.value)}
                placeholder={"/en/\ten\n/\tfr"} />
              <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "6px", lineHeight: 1.5 }}>
                <code>prefix TAB lang</code> · «/» = {t("hlPrefixRule")} (fallback)
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Grouping result */}
      {rows.length > 0 && (
        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
            <span className="tool-section-label" style={{ margin: 0 }}>{t("hlGroup")}: {grouped.clusters.length}</span>
            <span style={pill}>{rows.length} URL</span>
            {grouped.singles.length > 0 && <span style={{ ...pill, borderColor: "rgba(255,159,10,0.45)", color: "var(--color-accent-orange)" }}>{grouped.singles.length} × 1 lang</span>}
          </div>
          {grouped.invalid.map((msg, i) => (
            <div key={i} style={{ fontSize: "12px", color: "var(--color-accent-red)", display: "flex", gap: "6px", alignItems: "center" }}><AlertTriangle size={13} /> {msg}</div>
          ))}
          <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "200px", overflow: "auto", marginTop: "6px" }}>
            {grouped.clusters.map(c => (
              <div key={c.tail} style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
                <b style={{ color: "var(--color-text-primary)" }}>{c.tail}</b>{" "}
                {c.entries.map(e => (
                  <span key={e.lang} style={{ padding: "1px 7px", margin: "0 2px", borderRadius: "5px", background: "var(--color-bg)", border: "1px solid var(--color-border)", fontSize: "11px" }}>{e.lang}: {e.href}</span>
                ))}
              </div>
            ))}
          </div>
          {/* x-default */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
            <span className="tool-section-label" style={{ margin: 0 }}>{t("hlXDefault")}:</span>
            <select className="tool-input" style={{ padding: "6px 10px", fontSize: "12px", maxWidth: "380px" }} value={xDefault} onChange={e => setXDefault(e.target.value)}>
              <option value="">—</option>
              {allUrls.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Output */}
      {grouped.clusters.length > 0 && (
        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
            <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
              {tabBtn("head", "hlOutHead")}
              {tabBtn("sitemap", "hlOutSitemap")}
              {tabBtn("header", "hlOutHeader")}
            </div>
            <button onClick={() => void copy(output, tab)} style={btnGhost}>
              {copied === tab ? <Check size={13} /> : <Copy size={13} />} {t("hlCopy")}
            </button>
            {tab === "sitemap" && (
              <button onClick={downloadXml} style={btnGhost}><Download size={13} /> {t("hlDownload")}</button>
            )}
          </div>
          {rendered.invalid.map((msg, i) => (
            <div key={i} style={{ fontSize: "12px", color: "var(--color-accent-red)", marginBottom: "6px", display: "flex", gap: "6px", alignItems: "center" }}><AlertTriangle size={13} /> {msg}</div>
          ))}
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "11px", lineHeight: 1.6, fontFamily: "ui-monospace, monospace", color: "var(--color-text-primary)", maxHeight: "420px", overflow: "auto", margin: 0, padding: "12px", background: "var(--color-bg)", borderRadius: "8px", border: "1px solid var(--color-border)" }}>{output || "—"}</pre>
        </div>
      )}

      {/* Live verification */}
      {grouped.clusters.length > 0 && (
        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
            <button onClick={() => void verify()} disabled={verifying} style={{ ...btn, opacity: verifying ? 0.6 : 1 }}>
              {verifying ? <Loader2 size={14} className="spin" /> : <Globe size={14} />} {t("hlVerify")}
            </button>
            <span style={{ ...pill, fontSize: "10px" }}>net</span>
          </div>
          {verifyErr && <div style={{ fontSize: "12px", color: "var(--color-accent-red)" }}>{verifyErr}</div>}
          {verifyRows && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "300px", overflow: "auto" }}>
              {verifyRows.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: "8px", alignItems: "flex-start", flexWrap: "wrap", fontSize: "12px", padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
                  <span style={{ wordBreak: "break-all", color: "var(--color-text-primary)", fontWeight: 600, minWidth: "200px" }}>{r.url}</span>
                  {!r.reachable ? (
                    <span style={{ color: "var(--color-text-tertiary)" }}>HTTP {r.httpStatus} · {r.error}</span>
                  ) : r.matches ? (
                    <span style={{ color: "var(--color-accent-green)", fontWeight: 600 }}>✓ {t("hlVerifyOk")}</span>
                  ) : (
                    <span style={{ color: "var(--color-accent-orange)", fontWeight: 600 }}>≠ {t("hlVerifyDiff")}</span>
                  )}
                  {r.reachable && !r.matches && (
                    <span style={{ color: "var(--color-text-secondary)", display: "flex", flexDirection: "column", gap: "2px" }}>
                      {r.missing.map((m, j) => <span key={"m" + j}>− {m.lang} → {m.href}</span>)}
                      {r.extra.map((m, j) => <span key={"e" + j}>+ {m.lang} → {m.href}</span>)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
