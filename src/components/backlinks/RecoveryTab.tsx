"use client";

// The «Восстановление» tab (N2): lost links ranked by what the link was actually worth, each
// with the action to take — "the page is up, the link is gone" is a webmaster email, "the page
// is gone" is a restore-or-redirect request, and the score decides which hour is spent first.
// «В Outreach» posts to /api/outreach — the same server service (createOutreachProspect) the
// MCP save_outreach_prospect tool uses, so a recovered link and a mention land in one pipeline.

import { useCallback, useEffect, useState } from "react";
import { Heart, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { RecoveryAction, RecoveryRow } from "@/lib/backlinks/recovery";
import { shareTokenFromPath } from "@/lib/shareParam";

const PAGE_ROWS = 50;

const ACTION_ICON: Record<RecoveryAction, string> = {
  page_alive_link_removed: "✉️",
  page_dead: "🪦",
  nofollowed: "🔒",
  retargeted: "↪️",
  unknown: "❔",
};

export default function RecoveryTab({ siteDbId, guest }: { siteDbId: string; guest: boolean }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<RecoveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);

  // First setState only after the await — the mount effect must not write state synchronously.
  const load = useCallback(async () => {
    try {
      const token = shareTokenFromPath();
      const res = await fetch(
        `/api/backlinks/recovery?siteId=${encodeURIComponent(siteDbId)}${token ? `&shareToken=${encodeURIComponent(token)}` : ""}`,
        { cache: "no-store" },
      );
      const d = await res.json().catch(() => ({}));
      if (d.notMigrated) {
        setRows([]);
        setNotice(String(t("blNotMigrated" as never)));
      } else if (res.ok) {
        setRows(Array.isArray(d.rows) ? (d.rows as RecoveryRow[]) : []);
        setNotice("");
      } else {
        setNotice(String(d.error ?? "error"));
      }
    } catch {
      setNotice("network_error");
    }
    setLoading(false);
  }, [siteDbId, t]);

  // Deferred one tick so the mount effect never calls setState synchronously (IndexAutoPanel
  // pattern); the cleanup keeps a fast unmount from setting state on a dead component.
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const toOutreach = useCallback(async (row: RecoveryRow) => {
    setBusyId(row.id);
    setNotice("");
    try {
      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: row.domainFrom,
          sourceUrl: row.urlFrom,
          sourceAnchor: row.apiAnchor,
          sourceDr: row.apiDr ?? 0,
          targetAsset: row.urlTo,
          pitchAngle: `Lost backlink (${t(`blRecAction_${row.action}` as never)}), value ${row.score}`,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(d.error ?? "error"));
      setNotice(`${t("blToOutreachDone" as never)}: ${row.domainFrom}`);
    } catch (e) {
      setNotice(String((e as Error).message));
    }
    setBusyId("");
  }, [t]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const pageNo = Math.min(page, pages);
  const pageRows = rows.slice((pageNo - 1) * PAGE_ROWS, pageNo * PAGE_ROWS);

  const cell: React.CSSProperties = { padding: "8px 10px", fontSize: "12.5px" };
  const th: React.CSSProperties = { ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" };
  const thC = { ...th, textAlign: "center" as const };

  return (
    <div>
      {notice && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{notice}</div>}
      {loading && <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", padding: "20px 0" }}><Loader2 size={13} className="spin" style={{ verticalAlign: "-2px", marginRight: "6px" }} />{t("loading")}</div>}

      {!loading && rows.length === 0 && (
        <div style={{ padding: "24px", textAlign: "center", border: "1px dashed var(--color-border)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          {t("blpNoLost")}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
          <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                <th style={thC}>{t("blRecScore")}</th>
                <th style={th}>{t("blpDomain")}</th>
                <th style={th}>{t("blRecAction" as never)}</th>
                <th style={thC}>DR</th>
                <th style={th}>{t("blchkAnchor" as never)}</th>
                <th style={thC}>{t("blpLostAt")}</th>
                {!guest && <th style={thC}></th>}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: "var(--color-text-primary)" }} title={t("blRecScore")}>{r.score.toFixed(2)}</td>
                  <td style={cell}>
                    <a href={r.urlFrom} target="_blank" rel="noreferrer noopener nofollow" style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>
                      {r.domainFrom}
                    </a>
                    {r.favorite && (
                      <Heart size={11} fill="currentColor" color="var(--color-danger, #ef4444)" style={{ verticalAlign: "-1px", marginLeft: "5px" }} aria-label="favorite" />
                    )}
                    <div style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.urlTo}>
                      → {r.urlTo}
                    </div>
                  </td>
                  <td style={{ ...cell, fontSize: "11.5px", color: "var(--color-text-secondary)" }} title={t(`blRecAction_${r.action}` as never)}>
                    {ACTION_ICON[r.action]} {t(`blRecAction_${r.action}` as never)}
                  </td>
                  <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{r.apiDr ?? "—"}</td>
                  <td style={{ ...cell, color: "var(--color-text-secondary)", fontSize: "11.5px", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.apiAnchor}>{r.apiAnchor || "—"}</td>
                  <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)", fontSize: "11.5px" }}>
                    {r.lostAt ? new Date(r.lostAt).toLocaleDateString() : "—"}
                  </td>
                  {!guest && (
                    <td style={{ ...cell, textAlign: "center" }}>
                      <button className="pill" style={{ cursor: busyId === r.id ? "wait" : "pointer" }} disabled={busyId === r.id}
                        onClick={() => { void toOutreach(r); }}>
                        {busyId === r.id ? "…" : t("blToOutreach")}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", paddingTop: "10px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <button className="pill" disabled={pageNo <= 1} onClick={() => setPage(pageNo - 1)} style={{ cursor: pageNo <= 1 ? "default" : "pointer", opacity: pageNo <= 1 ? 0.5 : 1 }}>‹</button>
          <span>{pageNo} / {pages}</span>
          <button className="pill" disabled={pageNo >= pages} onClick={() => setPage(pageNo + 1)} style={{ cursor: pageNo >= pages ? "default" : "pointer", opacity: pageNo >= pages ? 0.5 : 1 }}>›</button>
        </div>
      )}
    </div>
  );
}
