"use client";

// Local → Schema (N4, brief §4). The generated LocalBusiness JSON-LD with Google's requirements
// checked (required = red, recommended = amber), a compare pass against the site's own markup,
// and copy/download. The image hint (og:image / JSON-LD image) only resolves on the compare
// pass — that is the one call which has the homepage HTML in hand.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Diff, Download, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { btnGhost, btnDisabled, fieldLabel, statusPill, tdStyle, thStyle } from "./shared";

interface FieldDiff { field: string; generated: string; site: string; same: boolean }
interface Compare { fetchError: string | null; diffs: FieldDiff[]; siteNode: Record<string, unknown> | null }

export default function SchemaCard({ siteId, hasProfile }: { siteId: string; hasProfile: boolean }) {
  const { t } = useLanguage();
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [validation, setValidation] = useState<{ required: string[]; warnings: string[] } | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [comparing, setComparing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notMigrated, setNotMigrated] = useState(false);

  const load = useCallback(async (withCompare: boolean) => {
    try {
      const res = await fetch(`/api/local/schema?siteId=${encodeURIComponent(siteId)}${withCompare ? "&compare=1" : ""}`);
      const data = await res.json();
      if (data.notMigrated) { setNotMigrated(true); return; }
      if (data.schema) {
        setSchema(data.schema);
        setValidation(data.validation ?? null);
      }
      if (withCompare) setCompare(data.compare ?? null);
    } catch { /* a failed load keeps the previous render; the button can be pressed again */ }
  }, [siteId]);

  useEffect(() => {
    const id = setTimeout(() => { setSchema(null); setCompare(null); setCopied(false); void load(false); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  if (notMigrated) {
    return <div className="panel" style={{ padding: 18, fontSize: 13, color: "var(--color-text-secondary)" }}>⚠ {t("locNotMigrated" as never)}</div>;
  }
  if (!hasProfile) {
    return <div className="panel" style={{ padding: 18, fontSize: 13, color: "var(--color-text-secondary)" }}>{t("locNapNeedsProfile" as never)}</div>;
  }

  const json = schema ? JSON.stringify(schema, null, 2) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* no gesture/permission — the text is selectable in the viewer */ }
  };

  const download = () => {
    const blob = new Blob([json], { type: "application/ld+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "localbusiness.jsonld";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      {validation && (validation.required.length > 0 || validation.warnings.length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {validation.required.map(f => (
            <span key={f} style={{ ...statusPill("", "bad"), color: "var(--color-danger)" }}>
              <AlertTriangle size={12} /> {t("locSchemaRequired").replace("{field}", f)}
            </span>
          ))}
          {validation.warnings.length > 0 && (
            <span style={{ ...statusPill("", "warn"), color: "var(--color-text-secondary)" }}>
              <AlertTriangle size={12} /> {t("locSchemaWarn" as never)}: {validation.warnings.join(", ")}
            </span>
          )}
        </div>
      )}
      {validation && validation.required.length === 0 && validation.warnings.length === 0 && (
        <span style={{ ...statusPill("", "good") }}><Check size={12} /> {t("locSchemaOk" as never)}</span>
      )}

      <pre style={{
        margin: 0, padding: 14, borderRadius: 10, border: "1px solid var(--color-border)",
        background: "var(--color-card)", overflowX: "auto", fontSize: 12, lineHeight: 1.5,
        color: "var(--color-text-primary)",
      }}>{json || "…"}</pre>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={copy} disabled={!json} style={{ ...btnGhost, ...btnDisabled(!json) }}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {t("setCopy")}
        </button>
        <button type="button" onClick={download} disabled={!json} style={{ ...btnGhost, ...btnDisabled(!json) }}>
          <Download size={13} /> {t("seoDownloadJson")}
        </button>
        <button type="button" onClick={() => { setComparing(true); void load(true).finally(() => setComparing(false)); }}
          disabled={comparing || !json} style={{ ...btnGhost, ...btnDisabled(comparing || !json) }}>
          {comparing ? <Loader2 size={13} className="spin" /> : <Diff size={13} />} {t("locSchemaCompare")}
        </button>
        <span className="metric-cost">{t("locFreeNet" as never)}</span>
      </div>

      {compare && (
        <div>
          <span style={fieldLabel}>{t("locSchemaDiffTitle" as never)}</span>
          {compare.fetchError ? (
            <div style={{ fontSize: 12.5, color: "var(--color-danger)" }}>⚠ {t("locNapUnreachable" as never)} ({compare.fetchError})</div>
          ) : compare.siteNode == null ? (
            <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>{t("locSchemaNoSiteNode" as never)}</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>—</th>
                    <th style={thStyle}>{t("locSchemaDiffGenerated" as never)}</th>
                    <th style={thStyle}>{t("locSchemaDiffSite" as never)}</th>
                  </tr>
                </thead>
                <tbody>
                  {compare.diffs.map(d => (
                    <tr key={d.field} style={d.same ? undefined : { background: "color-mix(in srgb, var(--color-accent-blue) 5%, transparent)" }}>
                      <td style={tdStyle}>{d.field}</td>
                      <td style={{ ...tdStyle, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={d.generated}>{d.generated || "—"}</td>
                      <td style={{ ...tdStyle, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={d.site}>{d.site || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
