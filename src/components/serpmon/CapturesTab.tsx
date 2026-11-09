"use client";

// SERP Monitor → "Browser captures" tab (wave-ext E5): SERP pages saved from the extension's
// overlay. A capture is personalised (the user's own IP) — it never enters diffs or storms; the
// only comparison offered is view-only, against the nearest automated snapshot of the same
// keyword. Table → click a capture → the rows drawer with the compare toggle.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Camera, Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getJson, sendJson, thStyle, tdStyle, tdNum, thNum, trOf, type Tr } from "./shared";
import { ChangeChips } from "./ChangeChip";
import type { CaptureListItem, CaptureView } from "@/lib/ext/serpCapture";

type Ctx = { projectId: string };

export default function CapturesTab({ projectId }: { projectId: string }) {
  const { t } = useLanguage();
  const tr = trOf(t);

  const [items, setItems] = useState<CaptureListItem[] | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<CaptureView | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [compare, setCompare] = useState(false);

  const load = useCallback(async () => {
    try {
      const { status, body } = await getJson(`/api/serp-monitor/captures?projectId=${encodeURIComponent(projectId)}&limit=50`);
      if (body.notMigrated) { setNotMigrated(true); setItems([]); return; }
      if (status >= 400) { setItems([]); return; }
      setItems(Array.isArray(body.captures) ? body.captures as CaptureListItem[] : []);
    } catch {
      setItems([]);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const openCapture = useCallback(async (id: string, withCompare: boolean) => {
    setOpenId(id);
    setView(null);
    setViewLoading(true);
    try {
      const q = withCompare ? "?compare=nearest" : "";
      const { status, body } = await getJson(`/api/serp-monitor/captures/${id}${q}`);
      if (status < 400 && body.capture) setView(body.capture as CaptureView);
    } catch { /* the drawer shows the loading error state */ }
    setViewLoading(false);
  }, []);

  const removeCapture = useCallback(async (id: string) => {
    if (!window.confirm(tr("serpmonCaptureDeleteConfirm"))) return;
    await sendJson(`/api/serp-monitor/captures/${id}`, "DELETE").catch(() => null);
    setOpenId(null);
    void load();
  }, [load, tr]);

  const fmtWhen = (iso: string): string => {
    try { return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch { return iso; }
  };

  const region = (c: CaptureListItem): string => {
    const out = `${c.country.toUpperCase()}${c.lang ? "/" + c.lang.toUpperCase() : ""}`.trim();
    return out || tr("serpmonRegionUnknown");
  };

  if (notMigrated) {
    return (
      <div className="panel" style={{ color: "var(--color-accent-orange)", fontSize: 13, padding: "14px 16px" }}>
        <AlertTriangle size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{tr("serpmonNotMigrated")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="panel" style={{ fontSize: 12.5, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 8, padding: "10px 14px" }}>
        <Camera size={14} style={{ flexShrink: 0 }} />
        {tr("serpmonCaptureNote")}
      </div>

      {items === null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-secondary)" }}>
          <Loader2 size={14} className="spin" /> …
        </div>
      ) : items.length === 0 ? (
        <div className="panel" style={{ fontSize: 13, color: "var(--color-text-secondary)", padding: "14px 16px" }}>
          {tr("serpmonCaptureEmpty")}
        </div>
      ) : (
        <div className="panel" style={{ overflowX: "auto", padding: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={thStyle}>{tr("serpmonCaptureQuery")}</th>
                <th style={thStyle}>{tr("serpmonCaptureEngine")}</th>
                <th style={thStyle}>{tr("serpmonCaptureRegion")}</th>
                <th style={thNum}>{tr("serpmonCapturePage")}</th>
                <th style={thNum}>{tr("serpmonCaptureRows")}</th>
                <th style={thStyle}>{tr("serpmonCaptureWhen")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(c => (
                <tr key={c.id} onClick={() => { setCompare(false); void openCapture(c.id, false); }}
                  style={{ cursor: "pointer" }} title={c.features.join(", ") || undefined}>
                  <td style={tdStyle}>
                    {c.keyword}
                    {!c.projectId && <span className="pill" style={{ marginLeft: 6 }}>{tr("serpmonCaptureLoose")}</span>}
                  </td>
                  <td style={tdStyle} className="privacy-blur">{c.engineHost}</td>
                  <td style={tdStyle}>{region(c)}</td>
                  <td style={tdNum}>{c.page}</td>
                  <td style={tdNum}>{c.got}</td>
                  <td style={tdStyle}>{fmtWhen(c.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && (
        <CaptureDrawer
          tr={tr}
          loading={viewLoading}
          view={view}
          compare={compare}
          onToggleCompare={() => { const next = !compare; setCompare(next); void openCapture(openId, next); }}
          onClose={() => setOpenId(null)}
          onDelete={() => void removeCapture(openId)}
        />
      )}
    </div>
  );
}

function CaptureDrawer({ tr, loading, view, compare, onToggleCompare, onClose, onDelete }: {
  tr: Tr; loading: boolean; view: CaptureView | null; compare: boolean;
  onToggleCompare: () => void; onClose: () => void; onDelete: () => void;
}) {
  return (
    <div className="panel" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 13.5 }}>{view ? view.keyword : "…"}</b>
        {view && (
          <span style={{ fontSize: 11.5, color: "var(--color-text-secondary)" }}>
            {view.engineHost} · {view.country.toUpperCase()}{view.lang ? "/" + view.lang.toUpperCase() : ""} · {tr("serpmonCapturePage")} {view.page}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
          <input type="checkbox" checked={compare} onChange={onToggleCompare} />
          {tr("serpmonCaptureCompare")}
        </label>
        <button className="btn-ghost" onClick={onDelete}
          style={{ fontSize: 12, color: "var(--color-danger)", border: "1px solid var(--color-border)", borderRadius: 7, padding: "3px 9px", background: "transparent", cursor: "pointer" }}>
          {tr("serpmonCaptureDelete")}
        </button>
        <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--color-text-secondary)", display: "inline-flex" }}>
          <X size={15} />
        </button>
      </div>

      {compare && view && !view.compare && !loading && (
        <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>{tr("serpmonCaptureNoSnapshot")}</div>
      )}
      {compare && view?.compare && (
        <div>
          <ChangeChips changes={view.compare.changes} showPlatforms onHostClick={undefined} />
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-secondary)" }}>
          <Loader2 size={14} className="spin" /> …
        </div>
      ) : view ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 420, overflowY: "auto" }}>
          {view.rows.map(r => (
            <div key={r.position} style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "4px 0", borderBottom: "1px solid var(--color-border-soft, var(--color-border))" }}>
              <span style={{ width: 24, textAlign: "right", color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{r.position}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.title || r.url}
                </div>
                <div className="privacy-blur" style={{ fontSize: 11.5, color: "var(--color-text-secondary)" }}>{r.host}</div>
                {r.snippet && (
                  <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {r.snippet}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>—</div>
      )}
    </div>
  );
}
