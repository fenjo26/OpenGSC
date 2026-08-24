"use client";

import { useMemo, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { decodeExport } from "@/lib/seo/metricsCsv";
import { parseBacklinkImport } from "@/lib/seo/backlinkImport";

// One window, two entrances (paste a list / upload or paste CSV-TSV), one parser: the preview
// below runs the exact functions POST /api/backlinks applies server-side, so "recognized 137
// rows" is the number that will be written, and both entrances produce identical rows for
// identical data by construction.
//
// The origin recorded on the rows follows the entrance the user chose, not the detected
// format: "Paste a list" writes manual, "Upload CSV / TSV" writes csv.

type Mode = "paste" | "csv";

export default function BacklinkImportDialog({
  siteDbId, onClose, onImported,
}: {
  siteDbId: string;
  onClose: () => void;
  onImported: (result: { added: number; updated: number }) => void;
}) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // {rows}/{cols}/{n} are substituted by hand — t() returns the raw string.
  const fmt = (key: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key as Parameters<typeof t>[0]));

  const preview = useMemo(() => parseBacklinkImport(text), [text]);

  const handleFile = async (file: File) => {
    // Ahrefs exports arrive as UTF-16 — decodeExport sniffs the BOM so the header row is
    // readable and column recognition doesn't die on mojibake.
    const decoded = decodeExport(await file.arrayBuffer());
    setText(decoded);
    setError("");
  };

  const submit = async () => {
    if (preview.rows.length === 0 || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/backlinks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteDbId, text, origin: mode === "csv" ? "csv" : "manual" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "import failed");
      onImported({ added: d.added ?? 0, updated: d.updated ?? 0 });
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
    setSubmitting(false);
  };

  const inputStyle = {
    width: "100%", fontSize: "12px", padding: "8px 10px", borderRadius: "8px",
    border: "1px solid var(--color-border)", background: "var(--color-bg)",
    color: "var(--color-text-primary)", resize: "vertical" as const, fontFamily: "monospace",
    boxSizing: "border-box" as const,
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "20px", width: "90%", maxWidth: "620px", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", position: "relative", display: "flex", flexDirection: "column", gap: "12px" }}
        onClick={e => e.stopPropagation()}
      >
        <button onClick={onClose} style={{ position: "absolute", top: "14px", right: "14px", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)" }}><X size={18} /></button>

        <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("bluiImport")}</h3>

        {/* Entrance switch */}
        <div style={{ display: "flex", gap: "6px" }}>
          {([["paste", "bluiImportPaste"], ["csv", "bluiImportCsv"]] as const).map(([m, key]) => (
            <button key={m} onClick={() => setMode(m)}
              style={{ padding: "5px 12px", borderRadius: "8px", border: `1px solid ${mode === m ? "#3B82F6" : "var(--color-border)"}`, background: mode === m ? "rgba(59,130,246,0.12)" : "transparent", color: mode === m ? "#60a5fa" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              {t(key)}
            </button>
          ))}
        </div>

        {/* Format is told in the window itself, not in docs the user will never open. */}
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          <div>{t("bluiImportFormat")}</div>
          <div style={{ marginTop: "4px" }}>
            {t("bluiImportExample")}:{" "}
            <code style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--color-text-primary)", background: "var(--color-bg)", padding: "2px 6px", borderRadius: "4px", wordBreak: "break-all" }}>
              https://donor.ru/blog/statya, купить окна, https://mysite.ru/okna, dofollow
            </code>
          </div>
        </div>

        {mode === "csv" && (
          <div>
            <input
              ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }}
            />
            <button onClick={() => fileRef.current?.click()}
              style={{ display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "8px", border: "1px dashed var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: "12px", cursor: "pointer" }}>
              <Upload size={13} /> {t("bluiImportCsv")}
            </button>
          </div>
        )}

        <textarea
          value={text}
          onChange={e => { setText(e.target.value); setError(""); }}
          placeholder={mode === "paste" ? "https://donor.ru/blog/statya\n# комментарий" : "url,anchor,target_url,rel,dr,price,note\nhttps://donor.ru/blog/statya, купить окна, https://mysite.ru/okna, dofollow"}
          rows={mode === "csv" ? 8 : 6}
          style={inputStyle}
        />

        {/* Preview before submit: what the server will write, not a promise about it. */}
        {text.trim() !== "" && (
          <div style={{ fontSize: "12px", lineHeight: 1.7, color: "var(--color-text-secondary)", background: "var(--color-bg)", borderRadius: "8px", padding: "8px 12px", border: "1px solid var(--color-border)" }}>
            <div style={{ fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "2px" }}>{t("bluiImportPreview")}</div>
            <div>{fmt("bluiImportRecognized", { rows: preview.rows.length, cols: preview.columns.join(", ") })}</div>
            {preview.ignoredColumns.length > 0 && (
              <div style={{ color: "#FBBF24" }}>{fmt("bluiImportSkippedCols", { cols: preview.ignoredColumns.join(", ") })}</div>
            )}
            {preview.skippedRows > 0 && (
              <div style={{ color: "#F87171" }}>{fmt("bluiImportSkippedRows", { n: preview.skippedRows })}</div>
            )}
          </div>
        )}

        {error && <div style={{ fontSize: "12px", color: "#F87171", fontWeight: 600 }}>✗ {error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button onClick={submit} disabled={submitting || preview.rows.length === 0}
            style={{ padding: "8px 20px", borderRadius: "8px", border: "none", background: "#3B82F6", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer", opacity: preview.rows.length === 0 ? 0.5 : 1 }}>
            {t("bluiImportSubmit")}
          </button>
        </div>
      </div>
    </div>
  );
}
