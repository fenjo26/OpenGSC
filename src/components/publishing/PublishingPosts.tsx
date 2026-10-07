"use client";

// The published-posts table: what went out, where it lives, and what it cost to get there.
// Statuses are rendered as they are stored (publishing rows exist while a send is in flight;
// failed rows carry the platform's own error text). Retry re-sends the stored post.

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RotateCcw } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { StatusChip } from "./PublishDialog";

interface PostRow {
  id: string; title: string; status: string; remoteUrl: string; respinUsed: boolean; error: string;
  connectionLabel: string; platform: string; publishedAt: string | null; createdAt: string;
}

export default function PublishingPosts({ siteId }: { siteId: string }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<PostRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pageSize = 25;

  const load = useCallback(async (p: number) => {
    try {
      const d = await fetch(`/api/publishing/posts?siteId=${encodeURIComponent(siteId)}&page=${p}&pageSize=${pageSize}`, { cache: "no-store" }).then(r => r.json());
      setRows((d?.rows ?? []) as PostRow[]);
      setTotal(Number(d?.total ?? 0));
    } catch { setRows([]); }
  }, [siteId]);

  useEffect(() => {
    let alive = true;
    setRows(null);
    const id = setTimeout(async () => { if (alive) await load(page); }, 0);
    return () => { alive = false; clearTimeout(id); };
  }, [load, page]);

  async function retry(id: string) {
    setBusy(id); setError("");
    try {
      const res = await fetch("/api/publishing/posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "retry" }),
      });
      const d = await res.json();
      if (!res.ok) setError(String(d?.error ?? "failed"));
      await load(page);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="panel">
      <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 6px" }}>{t("publishPosts")}</h3>
      {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", margin: "6px 0" }}>{error}</div>}

      {rows === null && <div style={{ padding: "16px 0", color: "var(--color-text-tertiary)" }}><Loader2 size={16} className="spin" /></div>}
      {rows !== null && rows.length === 0 && (
        <div style={{ padding: "12px 0", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("publishNoPosts")}</div>
      )}
      {rows !== null && rows.length > 0 && (
        <div style={{ borderTop: "1px solid var(--color-border)" }}>
          {rows.map(p => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "13px 4px", borderBottom: "1px solid var(--color-border)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: "14px", color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>
                  {p.connectionLabel || p.platform}
                  {p.respinUsed && (
                    <span style={{ fontSize: "10px", fontWeight: 700, marginLeft: "8px", padding: "1px 7px", borderRadius: "10px", background: "rgba(191,90,242,0.14)", color: "var(--color-accent-purple)" }}>{t("publishRespinUsed")}</span>
                  )}
                </span>
                {p.status === "failed" && p.error && (
                  <span style={{ display: "block", fontSize: "11px", color: "var(--color-accent-red)", marginTop: "3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.error}>{p.error}</span>
                )}
              </span>
              <StatusChip status={p.status} />
              {p.remoteUrl && (
                <a href={p.remoteUrl} target="_blank" rel="noopener noreferrer" title={t("publishOpenPost")} style={btnGhost}>
                  <ExternalLink size={13} />
                </a>
              )}
              {p.status === "failed" && (
                <button onClick={() => retry(p.id)} disabled={busy === p.id} title={t("publishRetry")} style={btnGhost}>
                  {busy === p.id ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}
                </button>
              )}
            </div>
          ))}
          {pages > 1 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px", padding: "10px 4px 2px", fontSize: "12px", color: "var(--color-text-tertiary)" }}>
              <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} style={{ ...btnGhost, opacity: page <= 1 ? 0.5 : 1 }}>‹</button>
              {page} / {pages}
              <button disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))} style={{ ...btnGhost, opacity: page >= pages ? 0.5 : 1 }}>›</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", padding: "7px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", flexShrink: 0, textDecoration: "none" };
