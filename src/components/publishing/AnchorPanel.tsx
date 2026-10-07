"use client";

// The anchor-distribution panel on /publishing: anchor → how many of this site's own
// published posts link the money site with that exact anchor → which target URLs. The
// repeated-exact-anchor flag is the network footprint the plan asked to see BEFORE it
// accumulates: the same commercial anchor on several satellites is a template Google can
// link without understanding a word of the content.
//
// Reads GET /api/publishing/anchors (stored rows only, local + free). Deliberately narrow:
// per-site, over published posts, capped server-side — the pre-publish version of the same
// aggregation lives in the Publish dialog's review step.

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

interface AnchorRow { anchor: string; posts: number; urls: string[]; repeated: boolean }

export default function AnchorPanel({ siteId }: { siteId: string }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<AnchorRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/publishing/anchors?siteId=${encodeURIComponent(siteId)}`, { cache: "no-store" }).then(r => r.json());
      if (d?.error) { setError(String(d.error)); setRows([]); return; }
      setRows((d?.rows ?? []) as AnchorRow[]);
    } catch { setRows([]); }
  }, [siteId]);

  useEffect(() => {
    let alive = true;
    setRows(null); setError("");
    const id = setTimeout(async () => { if (alive) await load(); }, 0);
    return () => { alive = false; clearTimeout(id); };
  }, [load]);

  return (
    <div className="panel">
      <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 6px" }}>{t("pubAnchorSummary")}</h3>
      {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", margin: "6px 0" }}>{error}</div>}
      {rows === null && <div style={{ padding: "16px 0", color: "var(--color-text-tertiary)" }}><Loader2 size={16} className="spin" /></div>}
      {rows !== null && rows.length === 0 && (
        <div style={{ padding: "10px 0 14px", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("publishNoPosts")}</div>
      )}
      {rows !== null && rows.length > 0 && (
        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          {rows.map(r => (
            <div key={r.anchor || "(empty)"} style={{ display: "flex", alignItems: "baseline", gap: "12px", padding: "9px 2px", borderBottom: "1px solid var(--color-border)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: "13px", fontWeight: r.repeated ? 700 : 500, color: r.repeated ? "#F59E0B" : "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.anchor ? `“${r.anchor}”` : "(no anchor)"} × {r.posts}
                  {r.repeated && <span style={{ fontSize: "10.5px", fontWeight: 600, marginLeft: "8px", color: "#F59E0B" }}>{t("pubAnchorRepeated")}</span>}
                </span>
                <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.urls.join(", ")}>
                  → {r.urls.join(" · ")}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
