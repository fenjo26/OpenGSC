"use client";

// The «Disavow» tab (N2): the Google disavow file for everything the operator marked.
//
// The warning is not decoration and is always visible (brief §3): disavow is a destructive,
// hard-to-review action, and Google's own guidance is to use it only for manual actions or
// clearly paid/spam links. Marking happens in the Toxicity tab — this tab only renders and
// downloads the result, so the decision and the artifact stay two separate steps.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function DisavowTab({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<"domain" | "urls">("domain");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");

  // First setState only after the await — the mount effect must not write state synchronously.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/backlinks/disavow?siteId=${encodeURIComponent(siteDbId)}&mode=${mode}`, { cache: "no-store" });
      if (res.ok) {
        setFileName(res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "");
        setText(await res.text());
        setNotice("");
      } else {
        const d = await res.json().catch(() => ({}));
        setNotice(String(d.notMigrated ? t("blNotMigrated" as never) : (d.error ?? "error")));
      }
    } catch {
      setNotice("network_error");
    }
    setLoading(false);
  }, [siteDbId, mode, t]);

  // Deferred one tick so the mount/reload effect never calls setState synchronously (same
  // pattern as IndexAutoPanel); also re-runs when the mode toggle changes the URL.
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const download = useCallback(() => {
    const blob = new Blob([text], { type: "text/plain; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "disavow.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [text, fileName]);

  // "domain:x" kills EVERY link from x, so the file is domain-level only for donors whose
  // marked rows are all of their rows; the toggle forces per-URL lines everywhere.
  const domainLines = (text.match(/^domain:/gm) ?? []).length;
  const urlLines = Math.max(0, (text.match(/^https?:\/\//gm) ?? []).length);

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", marginBottom: "12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-warning, #f59e0b)", fontSize: "12.5px", color: "var(--color-text-primary)" }} role="alert">
        <AlertTriangle size={15} color="var(--color-warning, #f59e0b)" style={{ flexShrink: 0, marginTop: "1px" }} />
        <span>{t("blDisavowWarning")}</span>
      </div>

      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "12px" }}>
        <button className={mode === "domain" ? "pill active" : "pill"} style={{ cursor: "pointer" }} aria-pressed={mode === "domain"}
          onClick={() => setMode("domain")}>domain:</button>
        <button className={mode === "urls" ? "pill active" : "pill"} style={{ cursor: "pointer" }} aria-pressed={mode === "urls"}
          title={t("blDisavowUrls")} onClick={() => setMode("urls")}>{t("blDisavowUrls")}</button>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "11.5px", color: "var(--color-text-secondary)" }}>{domainLines} domain: · {urlLines} URL</span>
          <button className="metric-action" onClick={download} disabled={loading || !text.trim()}>
            <Download size={13} /> {t("blDisavowDownload")}
          </button>
        </span>
      </div>

      {notice && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{notice}</div>}
      {loading && <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", padding: "12px 0" }}><Loader2 size={13} className="spin" style={{ verticalAlign: "-2px", marginRight: "6px" }} />{t("loading")}</div>}

      {!loading && (domainLines + urlLines === 0 ? (
        <div style={{ padding: "24px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("blDisavowEmpty" as never)}
        </div>
      ) : (
        <>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "6px" }}>{t("blDisavowPreview" as never)} · {fileName}</div>
          <pre className="privacy-sensitive" style={{ margin: 0, padding: "12px", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "11.5px", lineHeight: 1.55, overflowX: "auto", maxHeight: "420px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {text}
          </pre>
        </>
      ))}
    </div>
  );
}
