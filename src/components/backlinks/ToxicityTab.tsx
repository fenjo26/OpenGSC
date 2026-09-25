"use client";

// The «Токсичность» tab of the backlink profile (N2): the site's niche (the §0.1 contract —
// marker groups that are NOT toxic for THIS site), the donor distribution, the donor table
// with signals and disavow marks, and the profile-level over-optimisation banner.
//
// Everything here reads stored data for free. The two buttons that do work are explicit:
// «Пересчитать» is local math; «Глубокая проверка» fetches up to 50 suspicious donors' home
// pages (free network, no provider). Marking for disavow is the operator's decision — the
// checkbox only writes the flag; the file itself is the Disavow tab.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert, Wand2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { MARKER_GROUPS, type ToxLevel } from "@/lib/backlinks/toxicity";
import { shareTokenFromPath } from "@/lib/shareParam";

export interface DonorRow {
  domainFrom: string;
  links: number;
  level: ToxLevel;
  score: number;
  signals: string[];
  dr: number | null;
  disavowMarked: number;
}

export interface ToxicityOverviewData {
  niche: string[];
  suggested: string[];
  levels: Record<ToxLevel, number>;
  donors: number;
  overOpt: { checked: number; exact: number; pct: number; over: boolean };
  donorRows: DonorRow[];
  lastRun: string | null;
  notMigrated?: true;
}

const PAGE_ROWS = 50;

const LEVEL_COLOR: Record<ToxLevel, string> = {
  toxic: "var(--color-danger, #ef4444)",
  suspicious: "var(--color-warning, #f59e0b)",
  unknown: "var(--color-text-tertiary, #94a3b8)",
  clean: "var(--color-success, #22c55e)",
};

/** Marker/anchor/script codes share the drops classifier's vocabulary, so their translations
 *  already exist (dropsToxSignal_*); only the structural codes are new here (blToxSignal_*). */
export function signalLabel(t: (k: never) => string, code: string): string {
  const drops = t(`dropsToxSignal_${code}` as never);
  if (drops !== `dropsToxSignal_${code}`) return drops;
  return t(`blToxSignal_${code}` as never);
}

export default function ToxicityTab({ siteDbId, guest }: { siteDbId: string; guest: boolean }) {
  const { t } = useLanguage();
  const [data, setData] = useState<ToxicityOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  /** null = showing the saved niche; an array = the operator is editing it (derived, not synced). */
  const [nicheEdit, setNicheEdit] = useState<string[] | null>(null);
  const [page, setPage] = useState(1);

  // No synchronous setState in the body: the effect below calls this on mount, and the first
  // state write happens only after the fetch resolves (initial `loading` is already true).
  const load = useCallback(async () => {
    try {
      const token = shareTokenFromPath();
      const res = await fetch(
        `/api/backlinks/toxicity?siteId=${encodeURIComponent(siteDbId)}${token ? `&shareToken=${encodeURIComponent(token)}` : ""}`,
        { cache: "no-store" },
      );
      const d = await res.json().catch(() => ({}));
      if (d.notMigrated) {
        setData(null);
        setNotice(String(t("blNotMigrated" as never)));
      } else if (res.ok) {
        setData(d as ToxicityOverviewData);
        setNotice("");
      } else {
        setNotice(String(d.error ?? "error"));
      }
    } catch {
      setNotice("network_error");
    }
    setLoading(false);
  }, [siteDbId, t]);

  // Initial load defers one tick: the react-hooks/set-state-in-effect rule this repo lints
  // with flags a fetch-then-setState helper called straight from the effect body. A timeout
  // callback is a genuine async boundary, and the cleanup keeps a fast unmount from setting
  // state on a dead component (same pattern as IndexAutoPanel).
  useEffect(() => {
    const id = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  const niche = nicheEdit ?? data?.niche ?? [];
  const dirty = nicheEdit !== null && JSON.stringify(nicheEdit) !== JSON.stringify(data?.niche ?? []);

  const patchDisavow = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setNotice("");
      try {
        const res = await fetch("/api/backlinks/disavow", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: siteDbId, ...body }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String(d.error ?? "error"));
        await load();
      } catch (e) {
        setNotice(String((e as Error).message));
      }
      setBusy(false);
    },
    [siteDbId, load],
  );

  const run = useCallback(
    async (deepLimit: number) => {
      setBusy(true);
      setNotice("");
      try {
        const res = await fetch("/api/backlinks/toxicity/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: siteDbId, limit: deepLimit }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String(d.error ?? "error"));
        await load();
      } catch (e) {
        setNotice(String((e as Error).message));
      }
      setBusy(false);
    },
    [siteDbId, load],
  );

  const saveNiche = useCallback(
    async (next: string[]) => {
      setBusy(true);
      setNotice("");
      try {
        const res = await fetch("/api/backlinks/toxicity/niche", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId: siteDbId, niche: next }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String(d.error ?? "error"));
        setNicheEdit(null);
        await load();
      } catch (e) {
        setNotice(String((e as Error).message));
      }
      setBusy(false);
    },
    [siteDbId, load],
  );

  const donors = data?.donorRows ?? [];
  const pages = Math.max(1, Math.ceil(donors.length / PAGE_ROWS));
  const pageNo = Math.min(page, pages);
  const pageRows = donors.slice((pageNo - 1) * PAGE_ROWS, pageNo * PAGE_ROWS);

  const levels = data?.levels ?? { clean: 0, suspicious: 0, toxic: 0, unknown: 0 };
  const chip = (level: ToxLevel) => (
    <div key={level} title={t(`blTox_${level}` as never)} style={{ padding: "8px 12px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)", minWidth: "92px" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t(`blTox_${level}` as never)}</div>
      <div style={{ fontSize: "17px", fontWeight: 700, color: LEVEL_COLOR[level] }}>{levels[level] ?? 0}</div>
    </div>
  );

  const cell: React.CSSProperties = { padding: "8px 10px", fontSize: "12.5px" };
  const th: React.CSSProperties = { ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" };
  const thC = { ...th, textAlign: "center" as const };

  return (
    <div>
      {/* niche editor — the contract's escape hatch (§0.1) */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)" }}>{t("blNiche")}</span>
        {!guest && (
          <span style={{ display: "inline-flex", gap: "8px", flexWrap: "wrap" }}>
            <button className="pill" style={{ cursor: (data?.suggested?.length ?? 0) > 0 ? "pointer" : "default", opacity: (data?.suggested?.length ?? 0) > 0 ? 1 : 0.5 }}
              disabled={!(data?.suggested?.length) || busy}
              title={data?.suggested?.join(", ") || undefined}
              onClick={() => setNicheEdit(data?.suggested ?? [])}>
              <Wand2 size={12} style={{ verticalAlign: "-2px", marginRight: "4px" }} />{t("blNicheSuggest")}
            </button>
            {dirty && (
              <button className="pill active" style={{ cursor: "pointer" }} disabled={busy}
                onClick={() => { void saveNiche(nicheEdit ?? []); }}>
                {t("blNicheSave" as never)}
              </button>
            )}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "14px" }}>
        {MARKER_GROUPS.map((code) => {
          const on = niche.includes(code);
          return (
            <button key={code} className={on ? "pill active" : "pill"} disabled={guest}
              style={{ cursor: guest ? "default" : "pointer" }}
              aria-pressed={on}
              onClick={() => setNicheEdit(on ? niche.filter((x) => x !== code) : [...niche, code])}>
              {code}
            </button>
          );
        })}
        {niche.length === 0 && <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>—</span>}
      </div>

      {/* distribution + run controls */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px", alignItems: "center" }} className="privacy-blur-all">
        {chip("toxic")}{chip("suspicious")}{chip("clean")}{chip("unknown")}
        <div style={{ padding: "8px 12px", borderRadius: "var(--radius-md)", border: "1px dashed var(--color-border)", minWidth: "80px" }}>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("blToxDonors" as never)}</div>
          <div style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)" }}>{data?.donors ?? "—"}</div>
        </div>
        {!guest && (
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: "8px", flexWrap: "wrap" }}>
            <button className="metric-action" onClick={() => { void run(0); }} disabled={busy || loading}
              title={data?.lastRun ? new Date(data.lastRun).toLocaleString() : String(t("blToxNotRun" as never))}>
              {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {t("blToxRun")}
            </button>
            <button className="metric-action" onClick={() => { void run(50); }} disabled={busy || loading} title="free · ≤ 50 domains">
              {t("blToxDeep")}
            </button>
            <button className="metric-action" onClick={() => { void patchDisavow({ allToxic: true, disavow: true }); }} disabled={busy || loading || !(levels.toxic > 0)}>
              {t("blDisavowMarkToxic")}
            </button>
          </span>
        )}
      </div>

      {/* over-optimisation — a profile signal, never a donor level */}
      {data?.overOpt?.over && (
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "10px 12px", marginBottom: "12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-warning, #f59e0b)", fontSize: "12.5px", color: "var(--color-text-primary)" }} role="status">
          <ShieldAlert size={15} color="var(--color-warning, #f59e0b)" style={{ flexShrink: 0, marginTop: "1px" }} />
          <span>{String(t("blOverOptimized" as never)).replace("{pct}", String(data.overOpt.pct))}</span>
        </div>
      )}

      {notice && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>{notice}</div>}
      {loading && !data && <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", padding: "20px 0" }}>{t("loading")}</div>}

      {data && (
        <div style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
          <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}>
                {!guest && <th style={thC} aria-label={t("blDisavowMark")}>☣</th>}
                <th style={th}>{t("blpDomain")}</th>
                <th style={thC}>{t("blToxSignals")}</th>
                <th style={thC}>{t("blToxScore" as never)}</th>
                <th style={thC}>DR</th>
                <th style={thC}>{t("blpLinks")}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((d) => {
                const marked = d.disavowMarked > 0;
                const fullyMarked = d.disavowMarked >= d.links;
                return (
                  <tr key={d.domainFrom} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    {!guest && (
                      <td style={{ ...cell, textAlign: "center" }}>
                        <input type="checkbox" aria-label={t(marked ? "blDisavowUnmark" : "blDisavowMark")} disabled={busy}
                          checked={marked} title={`${d.disavowMarked}/${d.links}`}
                          onChange={(e) => { void patchDisavow({ domains: [d.domainFrom], disavow: e.target.checked }); }} />
                      </td>
                    )}
                    <td style={cell}>
                      <a href={`https://${d.domainFrom}`} target="_blank" rel="noreferrer noopener nofollow" style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>{d.domainFrom}</a>
                      {marked && <span className="metric-chip" style={{ marginLeft: "6px", fontWeight: 500 }} title={t("blDisavowMark")}>disavow{fullyMarked ? "" : ` ${d.disavowMarked}/${d.links}`}</span>}
                    </td>
                    <td style={{ ...cell, textAlign: "center" }}>
                      <span className="pill" style={{ cursor: "default", color: LEVEL_COLOR[d.level], borderColor: LEVEL_COLOR[d.level] }} title={t(`blTox_${d.level}` as never)}>
                        {t(`blTox_${d.level}` as never)}
                      </span>
                    </td>
                    <td style={{ ...cell, textAlign: "center", fontWeight: 700, color: d.level === "unknown" ? "var(--color-text-secondary)" : "var(--color-text-primary)" }}>
                      {d.level === "unknown" ? "—" : d.score}
                    </td>
                    <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>{d.dr ?? "—"}</td>
                    <td style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)" }}>
                      {d.links}
                      <div style={{ fontSize: "10.5px", color: "var(--color-text-tertiary)", marginTop: "2px", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.signals.map((s) => signalLabel(t, s)).join(" · ")}>
                        {d.signals.map((s) => signalLabel(t, s)).join(" · ") || "—"}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {donors.length === 0 && (
                <tr><td colSpan={guest ? 5 : 6} style={{ ...cell, textAlign: "center", color: "var(--color-text-secondary)", padding: "24px" }}>{t("blpEmpty")}</td></tr>
              )}
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
