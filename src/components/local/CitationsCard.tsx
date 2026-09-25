"use client";

// Local → Directories (N4, brief §3). The operator's listing URLs, each re-checked against the
// profile; the weekly scheduler keeps them fresh. The suggestion list is REGISTRATION links
// only — OpenGSC never posts to a directory on anyone's behalf. A 403/captcha directory is
// "unreachable" (it blocks bots), which is not an NAP problem and must not read as one.

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { CitationStatus } from "@/lib/local/types";
import { btnGhost, btnDanger, btnPrimary, btnDisabled, fieldLabel, inputStyle, statusPill, tdStyle, thStyle, sendJson } from "./shared";

interface CitationRow {
  id: string; url: string; directory: string; status: CitationStatus;
  diffs: { field: string; expected: string; found: string; status: string }[];
  checkedAt: string | null;
}

interface Suggestion { name: string; url: string }

const STATUS_TONE: Record<CitationStatus, "good" | "warn" | "bad" | "mute"> = {
  consistent: "good",
  mismatch: "warn",
  missing: "warn",
  unreachable: "mute",
  unchecked: "mute",
};

export default function CitationsCard({ siteId, hasProfile }: { siteId: string; hasProfile: boolean }) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<CitationRow[] | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [notMigrated, setNotMigrated] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"" | "run">("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/local/citations?siteId=${encodeURIComponent(siteId)}`);
      const data = await res.json();
      if (data.notMigrated) { setNotMigrated(true); return; }
      setRows(data.citations ?? []);
      setSuggestions(data.suggestions ?? []);
    } catch { setRows([]); }
  }, [siteId]);

  useEffect(() => {
    const id = setTimeout(() => { setRows(null); void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  async function add() {
    const clean = url.trim();
    if (!clean) return;
    setBusy("run");
    await sendJson("/api/local/citations", "POST", { siteId, url: clean });
    setBusy("");
    setUrl("");
    await load();
  }

  async function remove(id: string) {
    await sendJson(`/api/local/citations?id=${encodeURIComponent(id)}`, "DELETE");
    await load();
  }

  async function recheck() {
    setBusy("run");
    await sendJson("/api/local/citations/run", "POST", { siteId });
    setBusy("");
    await load();
  }

  if (notMigrated) {
    return <div className="panel" style={{ padding: 18, fontSize: 13, color: "var(--color-text-secondary)" }}>⚠ {t("locNotMigrated" as never)}</div>;
  }

  return (
    <div className="panel" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input style={{ ...inputStyle, width: "min(360px, 100%)" }} value={url}
          placeholder={t("locCitAdd")} onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void add(); }} />
        <button type="button" onClick={add} disabled={!url.trim() || busy !== ""}
          style={{ ...btnPrimary, ...btnDisabled(!url.trim() || busy !== "") }}>
          {busy === "run" && url ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} {t("locCitAddBtn" as never)}
        </button>
        {rows && rows.length > 0 && (
          <button type="button" onClick={recheck} disabled={!hasProfile || busy !== ""}
            style={{ ...btnGhost, ...btnDisabled(!hasProfile || busy !== "") }}
            title={hasProfile ? undefined : t("locNapNeedsProfile" as never)}>
            {busy === "run" && !url ? <Loader2 size={14} className="spin" /> : <RefreshCw size={13} />} {t("refresh")}
          </button>
        )}
        <span className="metric-cost">{t("locFreeNet" as never)}</span>
      </div>

      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead>
              <tr>
                <th style={thStyle}>{t("locCitDirectory" as never)}</th>
                <th style={thStyle}>{t("locCitStatus" as never)}</th>
                <th style={thStyle}>{t("locCitDiffs" as never)}</th>
                <th style={{ ...thStyle, textAlign: "right" }}>—</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={tdStyle}>
                    <a href={r.url} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)", textDecoration: "none" }}>
                      {r.directory || new URL(r.url).hostname}
                    </a>
                    {r.checkedAt && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "var(--color-text-tertiary)" }}>
                        {new Date(r.checkedAt).toLocaleDateString()}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={statusPill(t(`locCit_${r.status}`), STATUS_TONE[r.status])} title={r.status === "unreachable" ? t("locCit_unreachable") : undefined}>
                      {t(`locCit_${r.status}`)}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }} title={r.diffs.map(d => `${d.field}: ${d.found || "—"} (${d.status})`).join("\n")}>
                    {r.status === "unchecked" ? "—" : r.diffs.filter(d => d.status !== "match").map(d => d.field).join(", ") || t("locNap_match")}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <button type="button" onClick={() => remove(r.id)} title={t("remove")} style={{ ...btnDanger, padding: "4px 8px" }}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <span style={fieldLabel}>{t("locCitSuggest")}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {suggestions.map(s => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="pill" style={{ textDecoration: "none", fontSize: 12 }}>
              {s.name} <ExternalLink size={10} style={{ verticalAlign: "-1px", marginLeft: 3 }} />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
