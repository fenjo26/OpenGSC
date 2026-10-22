"use client";

// /pbn — восстановление дропов из Вебархива и пакетная простановка ссылок на мани-сайт.
// Сделано наоборот тому, что ломается у WayForge (см. docs/tasks/pbn/CONTRACT.md): честная
// оценка снимков, восстановление с отчётом, ссылки в контенте без футпринта.

import { useState } from "react";
import { Loader2, Globe, Link2, Download, Eye } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { AnchorKind } from "@/lib/pbn/anchors";

type Verdict = "recommended" | "thin" | "brand_mismatch" | "parked_or_doorway" | "no_snapshot";
interface SnapOption { verdict: Verdict; score: number; reason: string; timestamp: string; date: string }
interface ScanRow { domain: string; snapshots?: SnapOption[]; best?: { verdict: Verdict; score: number; timestamp?: string }; error?: string;
  chosen?: string; siteId?: string; status?: string; pagesRestored?: number; failed?: number; selected?: boolean; busy?: boolean }

const KINDS: AnchorKind[] = ["exact", "brand", "url", "generic"];
const verdictColor = (v: Verdict) => v === "recommended" ? "var(--color-accent-green)" : v === "no_snapshot" || v === "parked_or_doorway" ? "var(--color-accent-red)" : "var(--color-accent-orange)";

export default function PbnPage() {
  const { t } = useLanguage();
  const tt = (k: string) => t(k as never);
  const [domains, setDomains] = useState("");
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState("");

  const [target, setTarget] = useState("");
  const [scope, setScope] = useState("homepage_only");
  const [anchorsText, setAnchorsText] = useState("");
  const [shares, setShares] = useState<Record<AnchorKind, number>>({ exact: 10, brand: 30, url: 30, generic: 30 });
  const [rel, setRel] = useState({ dofollow: 80, nofollow: 15, sponsored: 5 });
  const [useAi, setUseAi] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ placed: number; skipped: { siteId: string; reason?: string }[] } | null>(null);

  const patch = (domain: string, p: Partial<ScanRow>) => setRows(rs => rs.map(r => r.domain === domain ? { ...r, ...p } : r));

  async function scan() {
    const list = domains.split(/\r?\n/).map(d => d.trim().toLowerCase()).filter(Boolean).slice(0, 25);
    if (!list.length) return;
    setScanning(true); setErr("");
    try {
      const d = await fetch("/api/pbn/prescan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domains: list }) }).then(r => r.json());
      if (d.error) { setErr(d.error === "pbn_not_migrated" ? tt("pbnNotMigrated") : d.error); setScanning(false); return; }
      setRows((d.results as ScanRow[]).map(r => ({ ...r, chosen: r.best?.timestamp || r.snapshots?.[0]?.timestamp, selected: r.best?.verdict === "recommended" })));
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setScanning(false);
  }

  async function restore(row: ScanRow) {
    if (!row.chosen) return;
    patch(row.domain, { busy: true, status: tt("pbnRestoring") });
    try {
      let done = false, guard = 0;
      while (!done && guard++ < 20) {
        const d = await fetch("/api/pbn/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: row.domain, snapshotTimestamp: row.chosen }) }).then(r => r.json());
        if (d.error) { patch(row.domain, { busy: false, status: d.error }); return; }
        done = d.done;
        patch(row.domain, { siteId: d.siteId, pagesRestored: d.pagesRestored, failed: (d.pagesFailed || []).length, status: done ? "ready" : `${d.pagesRestored}…` });
      }
      patch(row.domain, { busy: false });
    } catch (e) { patch(row.domain, { busy: false, status: String((e as Error)?.message ?? e) }); }
  }

  async function apply() {
    const siteIds = rows.filter(r => r.selected && r.siteId).map(r => r.siteId!) as string[];
    if (!target.trim() || !siteIds.length) return;
    const anchors = anchorsText.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
      const [text, kind] = line.split("::").map(s => s.trim());
      return { text, kind: (KINDS.includes(kind as AnchorKind) ? kind : "generic") as AnchorKind };
    });
    setApplying(true); setApplyResult(null);
    try {
      const d = await fetch("/api/pbn/campaign", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUrl: target.trim(), anchors, shares, relShares: rel, siteIds, scope, confirm: useAi }) }).then(r => r.json());
      if (d.error) setErr(d.error); else setApplyResult({ placed: d.placed, skipped: d.skipped || [] });
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setApplying(false);
  }

  const restoredCount = rows.filter(r => r.siteId && r.status === "ready").length;
  const inp: React.CSSProperties = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: 13 };

  return (
    <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 20, paddingBottom: 40 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 9, margin: "0 0 4px" }}>
          <Globe size={20} color="var(--color-accent-purple)" /> {tt("pbnTitle")}
        </h1>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 13, margin: 0, maxWidth: 680 }}>{tt("pbnHint")}</p>
      </div>
      {err && <div className="panel" style={{ borderColor: "rgba(255,69,58,0.35)", color: "var(--color-accent-red)", fontSize: 12 }}>{err}</div>}

      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--color-text-secondary)" }}>{tt("pbnStep1")}</label>
        <textarea value={domains} onChange={e => setDomains(e.target.value)} rows={5} placeholder={tt("pbnDomainsPh")}
          style={{ ...inp, fontFamily: "monospace", resize: "vertical" }} />
        <button onClick={() => void scan()} disabled={scanning} style={{ ...inp, alignSelf: "flex-start", background: "var(--color-accent-purple)", color: "#fff", fontWeight: 600, cursor: "pointer", display: "inline-flex", gap: 8, alignItems: "center" }}>
          {scanning ? <Loader2 size={14} className="spin" /> : null}{scanning ? tt("pbnScanning") : tt("pbnScan")}
        </button>
      </div>

      {rows.length === 0 && !scanning && <div className="panel" style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{tt("pbnEmpty")}</div>}
      {rows.map(row => (
        <div key={row.domain} className="panel" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input type="checkbox" checked={!!row.selected} onChange={e => patch(row.domain, { selected: e.target.checked })} disabled={!row.siteId} title={tt("pbnSelect")} />
            <strong style={{ fontSize: 14 }}>{row.domain}</strong>
            {row.error && <span style={{ color: "var(--color-accent-red)", fontSize: 12 }}>{row.error}</span>}
            {row.best && <span style={{ fontSize: 12, color: verdictColor(row.best.verdict) }}>{row.best.verdict} · {row.best.score}</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {row.siteId ? <>
                <a href={`/api/pbn/site/${row.siteId}/preview?path=/`} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center", color: "var(--color-text-secondary)" }}><Eye size={13} /> {tt("pbnPreview")}</a>
                <a href={`/api/pbn/site/${row.siteId}/zip`} style={{ fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center", color: "var(--color-text-secondary)" }}><Download size={13} /> {tt("pbnZip")}</a>
              </> : null}
            </span>
          </div>
          {row.snapshots && row.snapshots.length > 0 ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select value={row.chosen} onChange={e => patch(row.domain, { chosen: e.target.value })} style={{ ...inp, fontSize: 12 }}>
                {row.snapshots.map(s => <option key={s.timestamp} value={s.timestamp}>{s.date} · {s.verdict} {s.score} — {s.reason.slice(0, 40)}</option>)}
              </select>
              <button onClick={() => void restore(row)} disabled={row.busy || !row.chosen} style={{ ...inp, fontSize: 12, cursor: "pointer", display: "inline-flex", gap: 6, alignItems: "center" }}>
                {row.busy ? <Loader2 size={13} className="spin" /> : null}{row.busy ? tt("pbnRestoring") : tt("pbnRestore")}
              </button>
              {row.status ? <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{tt("pbnStatus")}: {row.status}{typeof row.pagesRestored === "number" ? ` · ${row.pagesRestored} ${tt("pbnPagesRestored")}${row.failed ? `, ${row.failed} ${tt("pbnFailed")}` : ""}` : ""}</span> : null}
            </div>
          ) : null}
          {row.best?.verdict === "no_snapshot" ? <span style={{ fontSize: 12, color: "var(--color-accent-red)" }}>{tt("pbnNoSnapshot")}</span> : null}
        </div>
      ))}

      {restoredCount > 0 ? (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12, borderColor: "var(--color-accent-purple)" }}>
          <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--color-accent-purple)", display: "inline-flex", gap: 6, alignItems: "center" }}><Link2 size={14} /> {tt("pbnStep2Campaign")}</label>
          <input value={target} onChange={e => setTarget(e.target.value)} placeholder={tt("pbnTargetPh")} style={inp} />
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{tt("pbnScope")}:{" "}
            <select value={scope} onChange={e => setScope(e.target.value)} style={{ ...inp, fontSize: 12 }}>
              <option value="homepage_only">{tt("pbnScopeHome")}</option>
              <option value="sitewide_footer" disabled>{tt("pbnScopeSitewide")} — soon</option>
              <option value="combo_both" disabled>{tt("pbnScopeCombo")} — soon</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{tt("pbnAnchors")} ({tt("pbnAnchorKind")}: text :: exact|brand|url|generic)</label>
          <textarea value={anchorsText} onChange={e => setAnchorsText(e.target.value)} rows={4} placeholder={tt("pbnAnchorsPh")} style={{ ...inp, fontFamily: "monospace", resize: "vertical" }} />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{tt("pbnShares")}</div>
              <div style={{ display: "flex", gap: 6 }}>{KINDS.map(k => (
                <label key={k} style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>{tt("pbnKind" + k.charAt(0).toUpperCase() + k.slice(1))}
                  <input type="number" min={0} value={shares[k]} onChange={e => setShares(s => ({ ...s, [k]: Number(e.target.value) }))} style={{ ...inp, width: 56, padding: "4px 6px" }} />
                </label>))}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4 }}>{tt("pbnRel")}</div>
              <div style={{ display: "flex", gap: 6 }}>{(["dofollow", "nofollow", "sponsored"] as const).map(k => (
                <label key={k} style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>{k}
                  <input type="number" min={0} value={rel[k]} onChange={e => setRel(r => ({ ...r, [k]: Number(e.target.value) }))} style={{ ...inp, width: 56, padding: "4px 6px" }} />
                </label>))}</div>
            </div>
          </div>
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", color: "var(--color-text-secondary)" }}>
            <input type="checkbox" checked={useAi} onChange={e => setUseAi(e.target.checked)} /> {tt("pbnConfirmAi")}
          </label>
          <button onClick={() => void apply()} disabled={applying || !target.trim()} style={{ ...inp, alignSelf: "flex-start", background: "var(--color-accent-purple)", color: "#fff", fontWeight: 600, cursor: "pointer", display: "inline-flex", gap: 8, alignItems: "center" }}>
            {applying ? <Loader2 size={14} className="spin" /> : null}{applying ? tt("pbnApplying") : tt("pbnApply")}
          </button>
          {applyResult ? (
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              <span style={{ color: "var(--color-accent-green)" }}>{applyResult.placed} {tt("pbnPlaced")}</span>
              {applyResult.skipped.length > 0 ? <span> · {applyResult.skipped.length} {tt("pbnSkipped")} ({applyResult.skipped.map(s => s.reason).filter(Boolean).join(", ")})</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
