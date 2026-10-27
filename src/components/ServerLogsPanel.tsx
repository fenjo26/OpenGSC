"use client";

// Server logs — which bots actually crawl the site (lib/logs). Upload an nginx/Apache access log
// (plain or .gz) or pick a file the operator allow-listed on the server; crawler IPs are verified
// by reverse DNS so fake Googlebots drop out. Owner-only: a guest view renders nothing.
//
// Uploads go in 8 MB chunks: the request proxy buffers at most 10 MB of a body, so one large POST
// would silently arrive truncated.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Upload, Trash2, Server } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { isGuestView } from "@/lib/shareParam";
import type { LogSummary } from "@/lib/logs/aggregate";

const CHUNK = 8 * 1024 * 1024;

interface ImportRow { id: string; createdAt: string; source: string; lines: number; periodFrom: string | null; periodTo: string | null; googleHits: number }
interface ServerFile { path: string; size: number; mtime: string }
type Summary = Omit<LogSummary, "google"> & { google: Omit<LogSummary["google"], "paths"> };

const fmt = (n: number) => n.toLocaleString();
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const cell: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--color-border)", fontSize: "12px", textAlign: "left", verticalAlign: "top" };
const head: React.CSSProperties = { ...cell, color: "var(--color-text-secondary)", fontWeight: 600 };
const subTitle: React.CSSProperties = { fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", margin: "4px 0" };

export default function ServerLogsPanel({ siteDbId }: { siteDbId: string }) {
  const { t: tRaw } = useLanguage();
  const t = tRaw as (k: string) => string;
  const guest = isGuestView();
  const [imports, setImports] = useState<ImportRow[] | null>(null);
  const [serverFiles, setServerFiles] = useState<ServerFile[]>([]);
  const [serverPick, setServerPick] = useState("");
  const [current, setCurrent] = useState<{ id: string; source: string; summary: Summary } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const open = useCallback(async (id: string) => {
    const d = await fetch(`/api/logs/${id}`).then(r => r.json()).catch(() => null);
    if (d?.import?.summary) setCurrent({ id, source: d.import.source, summary: d.import.summary });
  }, []);

  const load = useCallback(async (openId?: string) => {
    const res = await fetch(`/api/logs?siteId=${siteDbId}`).catch(() => null);
    if (!res?.ok) { setImports(null); return; }
    const d = await res.json();
    setImports(d.imports ?? []);
    setServerFiles(d.serverFiles ?? []);
    const first = openId ?? d.imports?.[0]?.id;
    if (first) await open(first);
  }, [siteDbId, open]);

  useEffect(() => {
    if (guest) return;
    (async () => { await load(); })();
  }, [guest, load]);

  const upload = async (file: File) => {
    setErr("");
    const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const chunks = Math.max(1, Math.ceil(file.size / CHUNK));
    try {
      for (let i = 0; i < chunks; i++) {
        const final = i === chunks - 1;
        setBusy(final ? t("logsAnalyzing") : t("logsUploading").replace("{p}", String(Math.round((i / chunks) * 100))));
        const q = new URLSearchParams({ siteId: siteDbId, uploadId, index: String(i), final: final ? "1" : "0", name: file.name });
        const res = await fetch(`/api/logs/upload?${q}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(i * CHUNK, (i + 1) * CHUNK),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.message || d.error || `HTTP ${res.status}`);
        if (final) await load(d.id);
      }
    } catch (e) {
      setErr(t("logsError").replace("{e}", String((e as Error)?.message ?? e)));
    }
    setBusy("");
  };

  const importServer = async () => {
    if (!serverPick) return;
    setErr(""); setBusy(t("logsAnalyzing"));
    const res = await fetch("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: siteDbId, path: serverPick }) }).catch(() => null);
    const d = await res?.json().catch(() => ({}));
    if (!res?.ok) setErr(t("logsError").replace("{e}", String(d?.message || d?.error || "error")));
    else await load(d.id);
    setBusy("");
  };

  const remove = async (id: string) => {
    await fetch(`/api/logs/${id}`, { method: "DELETE" }).catch(() => {});
    if (current?.id === id) setCurrent(null);
    load();
  };

  // Guests and failed loads (no access) render nothing: logs are the owner's business.
  if (guest || imports === null) return null;
  const s = current?.summary;
  const maxDay = s ? Math.max(1, ...s.google.byDay.map(d => d.hits)) : 1;
  const kindLabel: Record<string, string> = { search: t("logsKindSearch"), ai: t("logsKindAi"), seo: t("logsKindSeo"), other: t("logsKindOther") };

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px" }}>
      <div>
        <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}><Server size={16} /> {t("logsTitle")}</div>
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px", lineHeight: 1.5 }}>{t("logsSub")}</div>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "4px", lineHeight: 1.5 }}>{t("logsAuditHint")}</div>
      </div>

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "9px 14px", borderRadius: "9px", background: busy ? "rgba(255,255,255,0.08)" : "var(--color-accent-blue)", color: busy ? "var(--color-text-secondary)" : "#fff", fontSize: "13px", fontWeight: 600, cursor: busy ? "default" : "pointer" }}>
          {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} {busy || t("logsUpload")}
          <input type="file" accept=".log,.gz,.txt,text/plain,application/gzip" disabled={!!busy} style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
        </label>
        {serverFiles.length > 0 && (
          <>
            <select value={serverPick} onChange={e => setServerPick(e.target.value)} disabled={!!busy}
              style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", maxWidth: "100%" }}>
              <option value="">{t("logsServerFile")}</option>
              {serverFiles.map(f => <option key={f.path} value={f.path}>{f.path} · {mb(f.size)}</option>)}
            </select>
            <button onClick={importServer} disabled={!serverPick || !!busy}
              style={{ padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: serverPick && !busy ? "pointer" : "default" }}>
              {t("logsImport")}
            </button>
          </>
        )}
      </div>
      {err && <div style={{ fontSize: "12px", color: "#f87171" }}>{err}</div>}

      {imports.length === 0 ? (
        <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("logsEmpty")}</div>
      ) : (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {imports.map(row => (
            <span key={row.id} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 8px", borderRadius: "8px", border: `1px solid ${current?.id === row.id ? "var(--color-accent-blue)" : "var(--color-border)"}`, fontSize: "11px" }}>
              <button onClick={() => open(row.id)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--color-text-primary)", fontSize: "11px" }}>
                {(row.periodFrom ?? "").slice(0, 10)} – {(row.periodTo ?? "").slice(0, 10)} · {row.source.split("/").pop()} · Googlebot {fmt(row.googleHits)}
              </button>
              <button onClick={() => remove(row.id)} title={t("logsDelete")} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--color-text-tertiary)" }}><Trash2 size={12} /></button>
            </span>
          ))}
        </div>
      )}

      {s && (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
            {t("logsPeriod").replace("{from}", (s.from ?? "").slice(0, 10)).replace("{to}", (s.to ?? "").slice(0, 10)).replace("{d}", String(s.days))}
            {" · "}{t("logsLines").replace("{n}", fmt(s.lines)).replace("{s}", fmt(s.skipped))}
            {" · "}{t("logsHumans")}: {fmt(s.humanHits)}
          </div>

          {s.dnsAvailable === false && <div style={{ fontSize: "12px", color: "#ff9f0a", lineHeight: 1.5 }}>{t("logsDnsUnavailable")}</div>}

          <div>
            <div style={subTitle}>{t("logsGooglebot")} — {t("logsGoogleHits").replace("{n}", fmt(s.google.hits))}</div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", margin: "6px 0" }}>
              {(["2xx", "3xx", "4xx", "5xx"] as const).map(k => (
                <span key={k} style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "var(--radius-pill)", background: "var(--color-border-soft)", color: k === "4xx" || k === "5xx" ? (s.google.statuses[k] ? "#ff375f" : "var(--color-text-secondary)") : "var(--color-text-secondary)", fontWeight: 600 }}>
                  {k}: {fmt(s.google.statuses[k] ?? 0)}
                </span>
              ))}
            </div>
            {s.google.byDay.length > 1 && (
              <div title={t("logsPerDay")} style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "48px" }}>
                {s.google.byDay.map(d => (
                  <div key={d.date} title={`${d.date}: ${d.hits}`} style={{ flex: "1 1 0", minWidth: "2px", height: `${Math.max(4, (d.hits / maxDay) * 100)}%`, background: "var(--color-accent-blue)", borderRadius: "2px 2px 0 0", opacity: 0.8 }} />
                ))}
              </div>
            )}
          </div>

          <div style={{ overflowX: "auto" }}>
            <div style={subTitle}>{t("logsBots")}</div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={head}>{t("logsColBot")}</th><th style={head}></th><th style={head}>{t("logsColHits")}</th>
                <th style={head}>{t("logsColVerified")}</th><th style={head}>{t("logsColFake")}</th>
              </tr></thead>
              <tbody>
                {s.families.map(f => (
                  <tr key={f.id}>
                    <td style={cell}>{f.label}</td>
                    <td style={{ ...cell, color: "var(--color-text-tertiary)" }}>{kindLabel[f.kind] ?? f.kind}</td>
                    <td style={cell}>{fmt(f.hits)}</td>
                    <td style={cell}>{f.verified != null ? fmt(f.verified) : "—"}</td>
                    <td style={{ ...cell, color: f.fake ? "#ff375f" : undefined }}>{f.fake != null ? fmt(f.fake) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {[["logsTopPaths", s.google.topPaths], ["logsErrorPaths", s.google.errorPaths]].map(([key, rows]) => (
            (rows as { path: string; hits: number; status: number }[]).length > 0 && (
              <div key={key as string} style={{ overflowX: "auto" }}>
                <div style={subTitle}>{t(key as string)}</div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {(rows as { path: string; hits: number; status: number }[]).slice(0, 20).map(r => (
                      <tr key={r.path}>
                        <td style={{ ...cell, overflowWrap: "anywhere" }}>{r.path}</td>
                        <td style={{ ...cell, color: r.status >= 400 ? "#ff375f" : r.status >= 300 ? "#ff9f0a" : "var(--color-text-secondary)", width: "60px" }}>{r.status}</td>
                        <td style={{ ...cell, width: "80px" }}>{fmt(r.hits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ))}

          {s.fakeIps.length > 0 && (
            <div>
              <div style={subTitle}>{t("logsFake")}</div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.7 }}>
                {s.fakeIps.map(f => <div key={f.ip}>{f.ip} · {f.family} · {fmt(f.hits)}</div>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
