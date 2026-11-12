"use client";

// Index Check — the mass URL index-verification surface (/index-check).
//
// One user action → a queued run: N URLs checked sequentially in the background against a paid
// provider (the SERP provider's site: query, or XML River's direct indexed? endpoint). Two-click
// money contract everywhere (CONTRACT §0.5): the first click collects and prices, the second
// spends. The run page is the loop's hub — progress, stop, the not-found list copied or
// downloaded, and the one-click push of that list back into the indexers (the part the
// competitor leaves as copy-paste).
//
// Zones (audits-page convention — a knob without a visible control reads as not shipped):
//   • Create — provider, source (my sites / pasted list / purchased donors), breaker, estimate.
//   • Runs — live counters, actions (pause/resume/cancel), per-site breakdown, paged items,
//     not-found export + indexer push. Polled every 10s while anything is active.

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, ChevronDown, ChevronRight, Copy, Download, Loader2, Pause, Play, RefreshCw, SearchCheck, Send, Square } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { copyText } from "@/components/UrlCell";
import { formatUsd } from "@/lib/seo/metricsClient";

interface SiteRow { id: string; url: string }
interface RunRow {
  run: {
    id: string; name: string; provider: string; source: string; status: string; statusReason: string;
    consecutiveErrors: number; pauseAfterErrors: number; estCostUsd: number | null;
    createdAt: string; finishedAt: string | null;
  };
  counts: Record<string, number>;
  verdicts: Record<string, number>;
  bySite: { siteId: string | null; siteDomain: string; total: number; notIndexed: number }[];
  active: boolean;
}
interface ItemRow {
  url: string; status: string; verdict: string | null; matchedUrl: string | null; detail: string | null; checkedAt: string | null;
}
interface RunDetail extends RunRow { items: ItemRow[]; itemsTotal: number; nextOffset: number | null }
interface Estimate { provider: string; queries: number; costUsd: number | null; free: boolean; unknownPrice: boolean }

const RUN_COLORS: Record<string, string> = {
  active: "#30d158", paused: "#ff9f0a", done: "#8e8e93", cancelled: "#8e8e93",
};
const VERDICT_COLORS: Record<string, string> = {
  indexed: "#4ADE80", not_indexed: "#F87171", error: "#FBBF24",
};

const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 12px",
  fontSize: "13px", fontWeight: 500, borderRadius: "8px", cursor: "pointer",
  border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-primary)",
  ...extra,
});
const card: React.CSSProperties = {
  border: "1px solid var(--color-border)", borderRadius: "12px", padding: "16px",
  background: "var(--color-bg-secondary)", marginBottom: "16px",
};
const input: React.CSSProperties = {
  padding: "8px 10px", fontSize: "13px", borderRadius: "8px",
  border: "1px solid var(--color-border)", background: "var(--color-bg-primary)", color: "var(--color-text-primary)",
  width: "100%", boxSizing: "border-box",
};
const label: React.CSSProperties = {
  display: "block", fontSize: "12px", fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: "4px",
};
const muted: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)" };
const chip = (color: string): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600,
  color, background: "transparent", border: `1px solid ${color}44`, borderRadius: "999px", padding: "2px 8px",
});

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export default function IndexCheckPage() {
  return (
    <div className="main-content">
      <Suspense fallback={<div style={muted}>…</div>}>
        <IndexCheckInner />
      </Suspense>
    </div>
  );
}

function IndexCheckInner() {
  const { t } = useLanguage();
  const sp = useSearchParams();

  // ── create form ──
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [provider, setProvider] = useState<"serp" | "xmlriver">("serp");
  const [sourceKind, setSourceKind] = useState<"sites" | "urls" | "donors">("sites");
  const [picked, setPicked] = useState<Set<string>>(() => {
    const pre = sp.get("site");
    return pre ? new Set([pre]) : new Set<string>();
  });
  const [sitesFilter, setSitesFilter] = useState<"pending" | "all" | "google_not_indexed">("pending");
  const [urlsText, setUrlsText] = useState("");
  const [runName, setRunName] = useState("");
  const [pauseAfter, setPauseAfter] = useState("10");
  const [estimate, setEstimate] = useState<{ collected: number; estimate: Estimate } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // ── runs ──
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [verdictFilter, setVerdictFilter] = useState("all");
  const [itemOffset, setItemOffset] = useState(0);
  const [actionBusy, setActionBusy] = useState("");
  const [copied, setCopied] = useState("");
  const [sending, setSending] = useState("");
  const [sendMsg, setSendMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/index-check", { cache: "no-store" });
      const d = await res.json();
      if (res.ok) setRuns(d.runs ?? []);
    } catch { /* transient */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const res = fetch("/api/gsc/sites", { cache: "no-store" }).then(r => r.json()).catch(() => null);
    void res.then(d => { if (d?.sites) setSites(d.sites.map((s: { id: string; url: string }) => ({ id: s.id, url: String(s.url) }))); });
  }, []);

  // Poll while anything is in flight — the queue keeps moving with the tab open.
  const hasActive = runs.some(r => r.active || (r.counts.queued ?? 0) + (r.counts.running ?? 0) > 0);
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(id);
  }, [hasActive, load]);

  const loadDetail = useCallback(async (id: string, verdict = "all", offset = 0) => {
    const res = await fetch(`/api/index-check/${id}?verdict=${encodeURIComponent(verdict)}&limit=100&offset=${offset}`, { cache: "no-store" });
    const d = await res.json();
    if (res.ok) { setDetail(d as RunDetail); return true; }
    return false;
  }, []);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    void loadDetail(openId, verdictFilter, itemOffset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, verdictFilter, itemOffset, loadDetail]);

  // Follow an open run's live progress too (its counters live in the detail payload).
  useEffect(() => {
    if (!openId || !detail?.active) return;
    const id = setInterval(() => { void loadDetail(openId, verdictFilter, itemOffset); }, 10_000);
    return () => clearInterval(id);
  }, [openId, detail?.active, verdictFilter, itemOffset, loadDetail]);

  const sourceBody = useMemo(() => {
    if (sourceKind === "urls") return { kind: "urls", urls: urlsText.split(/\n+/).map(s => s.trim()).filter(Boolean) };
    if (sourceKind === "donors") return { kind: "donors" };
    return { kind: "sites", siteIds: [...picked], filter: sitesFilter };
  }, [sourceKind, urlsText, picked, sitesFilter]);

  const doEstimate = async () => {
    if (estimating) return;
    setEstimating(true); setMsg(null); setEstimate(null);
    try {
      const res = await fetch("/api/index-check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, source: sourceBody }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: d.error === "no_urls" ? t("icErrNoUrls") : d.error === "no_serp_key" ? t("seoErrNoSerpKey") : d.error === "no_xr_key" ? t("icErrNoXrKey") : d.error === "notMigrated" || d.notMigrated ? t("autoSyncNotMigrated") : String(d.error) });
        return;
      }
      setEstimate({ collected: d.collected, estimate: d.estimate });
    } catch { setMsg({ kind: "err", text: "network" }); } finally { setEstimating(false); }
  };

  const doLaunch = async () => {
    if (launching || !estimate) return;
    setLaunching(true); setMsg(null);
    try {
      const res = await fetch("/api/index-check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider, source: sourceBody, confirm: true,
          name: runName, pauseAfterErrors: Number(pauseAfter) || 0,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: d.error === "cap_exceeded" ? t("dmCapExceeded") : d.error === "run_active" ? t("icErrActive") : String(d.error) });
        return;
      }
      setEstimate(null); setUrlsText(""); setRunName("");
      setMsg({ kind: "ok", text: `${t("icRunsTitle")}: ${d.runId}` });
      await load();
      setOpenId(d.runId); setVerdictFilter("all"); setItemOffset(0);
    } catch { setMsg({ kind: "err", text: "network" }); } finally { setLaunching(false); }
  };

  const act = async (id: string, action: "pause" | "resume" | "cancel") => {
    setActionBusy(id + action);
    try {
      const res = await fetch(`/api/index-check/${id}/action`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await res.json();
      if (!res.ok && d.error === "run_active") setMsg({ kind: "err", text: t("icErrActive") });
      await load();
      if (openId === id) await loadDetail(id, verdictFilter, itemOffset);
    } finally { setActionBusy(""); }
  };

  const copyNotFound = async (runId: string, siteId?: string) => {
    const key = runId + (siteId ?? "");
    const res = await fetch(`/api/index-check/${runId}/not-found${siteId ? `?siteId=${encodeURIComponent(siteId)}` : ""}`);
    const d = await res.json();
    if (!res.ok) return;
    const ok = await copyText((d.urls as string[]).join("\n"));
    if (ok) { setCopied(key); setTimeout(() => setCopied(""), 1500); }
  };

  const sendNotFound = async (runId: string, target: "neural" | "2index" | "farm") => {
    if (sending) return;
    setSending(target); setSendMsg("");
    try {
      const res = await fetch(`/api/index-check/${runId}/not-found`);
      const d = await res.json();
      if (!res.ok) { setSendMsg(d.error ?? "failed"); return; }
      const urls = d.urls as string[];
      if (!urls.length) { setSendMsg("0"); return; }
      let sent = 0;
      if (target === "neural") {
        const r = await fetch("/api/indexing/neural", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ urls, label: `index-check ${runId.slice(0, 8)}` }),
        });
        const dd = await r.json();
        if (!r.ok) { setSendMsg(dd.error ?? "neural failed"); return; }
        sent = urls.length;
      } else if (target === "farm") {
        const r = await fetch("/api/indexer/queue", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ domainId: "all", urls }),
        });
        const dd = await r.json();
        if (!r.ok) { setSendMsg(dd.error ?? "farm failed"); return; }
        sent = dd.queued ?? urls.length;
      } else {
        // 2index: the route takes 50 per call — batch, keep the label honest by summing real
        // per-batch results.
        for (let i = 0; i < urls.length; i += 50) {
          const r = await fetch("/api/indexing/submit", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ urls: urls.slice(i, i + 50) }),
          });
          const dd = await r.json().catch(() => ({}));
          if (!r.ok) { setSendMsg(dd.error ?? "2index failed"); return; }
          sent += Number(dd.submitted ?? 0) || 0;
        }
      }
      setSendMsg(t("icSentOk").replace("{n}", String(sent)));
    } catch { setSendMsg("network"); } finally { setSending(""); }
  };

  const estLine = (e: Estimate): string => {
    const cost = e.free ? t("aparserNoCost") : e.costUsd != null ? formatUsd(e.costUsd) : t("icUnknownPrice");
    return t("icEstimateRow").replace("{n}", String(e.queries)).replace("{provider}", e.provider).replace("{cost}", cost);
  };

  const toggleSite = (id: string) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setEstimate(null);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <SearchCheck size={18} />
        <h1 style={{ fontSize: "18px", fontWeight: 700, margin: 0 }}>{t("icTitle")}</h1>
      </div>
      <p style={{ ...muted, marginTop: 0, marginBottom: "16px" }}>{t("icHint")}</p>

      {/* ── Create ── */}
      <div style={card}>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* provider */}
          <div>
            <span style={label}>{t("icProvider")}</span>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {([["serp", t("icProviderSerp"), t("icProviderSerpHint")], ["xmlriver", t("icProviderXr"), t("icProviderXrHint")]] as const).map(([id, name, hint]) => (
                <button key={id} onClick={() => { setProvider(id as "serp" | "xmlriver"); setEstimate(null); }}
                  style={{ ...btn, flex: 1, minWidth: "220px", flexDirection: "column", alignItems: "flex-start", gap: "2px", padding: "10px 12px", borderColor: provider === id ? "var(--color-accent, #3b82f6)" : "var(--color-border)" }}>
                  <span style={{ fontWeight: 600 }}>{name}</span>
                  <span style={{ ...muted, fontSize: "11px", textAlign: "left" }}>{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {/* source */}
          <div>
            <span style={label}>{t("icSource")}</span>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
              {([["sites", t("icSourceSites")], ["urls", t("icSourceUrls")], ["donors", t("icSourceDonors")]] as const).map(([id, name]) => (
                <button key={id} onClick={() => { setSourceKind(id as typeof sourceKind); setEstimate(null); }}
                  style={{ ...btn, borderColor: sourceKind === id ? "var(--color-accent, #3b82f6)" : "var(--color-border)", background: sourceKind === id ? "var(--color-bg-primary)" : "transparent" }}>
                  {name}
                </button>
              ))}
            </div>

            {sourceKind === "sites" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <select value={sitesFilter} onChange={e => { setSitesFilter(e.target.value as typeof sitesFilter); setEstimate(null); }} style={{ ...input, width: "auto" }}>
                    <option value="pending">{t("icFilterPending")}</option>
                    <option value="google_not_indexed">{t("icFilterGoogleNot")}</option>
                    <option value="all">{t("icFilterAll")}</option>
                  </select>
                  <span style={muted}>{t("icSitesPicked").replace("{n}", String(picked.size))}</span>
                  <button style={{ ...btn, padding: "4px 10px" }} onClick={() => { setPicked(new Set(sites.map(s => s.id))); setEstimate(null); }}>{t("icSelectAll")}</button>
                  <button style={{ ...btn, padding: "4px 10px" }} onClick={() => { setPicked(new Set()); setEstimate(null); }}>{t("icSelectNone")}</button>
                </div>
                <div style={{ maxHeight: "180px", overflowY: "auto", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "6px" }}>
                  {sites.map(s => (
                    <label key={s.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px 6px", fontSize: "13px", cursor: "pointer" }}>
                      <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggleSite(s.id)} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hostOf(s.url)}</span>
                    </label>
                  ))}
                  {!sites.length && <div style={muted}>…</div>}
                </div>
              </div>
            )}

            {sourceKind === "urls" && (
              <textarea value={urlsText} onChange={e => { setUrlsText(e.target.value); setEstimate(null); }}
                placeholder={t("icUrlsPlaceholder")} rows={6}
                style={{ ...input, fontFamily: "var(--font-mono, monospace)", resize: "vertical" }} />
            )}

            {sourceKind === "donors" && <div style={muted}>{t("icDonorsHint")}</div>}
          </div>

          {/* knobs + estimate */}
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: 2, minWidth: "200px" }}>
              <span style={label}>{t("icRunName")}</span>
              <input value={runName} onChange={e => setRunName(e.target.value)} style={input} />
            </div>
            <div style={{ flex: 1, minWidth: "140px" }}>
              <span style={label}>{t("icBreakerAfter")}</span>
              <input value={pauseAfter} onChange={e => setPauseAfter(e.target.value)} inputMode="numeric" style={input} />
            </div>
            <button onClick={doEstimate} disabled={estimating} style={btn}>
              {estimating ? <Loader2 size={14} className="spin" /> : <SearchCheck size={14} />} {t("icEstimateBtn")}
            </button>
          </div>

          {estimate && (
            <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "8px", background: "var(--color-bg-primary)" }}>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>{estLine(estimate.estimate)}</span>
              <button onClick={doLaunch} disabled={launching} style={{ ...btn, borderColor: "var(--color-accent, #3b82f6)", color: "var(--color-accent, #3b82f6)" }}>
                {launching ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {t("icLaunchBtn")}
              </button>
            </div>
          )}

          {msg && (
            <div style={{ fontSize: "13px", color: msg.kind === "ok" ? "#4ADE80" : "#F87171" }}>{msg.text}</div>
          )}
        </div>
      </div>

      {/* ── Runs ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>{t("icRunsTitle")}</h2>
        <button onClick={() => { void load(); if (openId) void loadDetail(openId, verdictFilter, itemOffset); }} style={{ ...btn, padding: "4px 10px" }}>
          <RefreshCw size={13} />
        </button>
      </div>

      {loading && <div style={muted}>…</div>}
      {!loading && !runs.length && <div style={muted}>{t("icNoRuns")}</div>}

      {runs.map(r => {
        const total = Object.values(r.counts).reduce((a, b) => a + b, 0) || 1;
        const settled = (r.counts.completed ?? 0) + (r.counts.error ?? 0) + (r.counts.skipped ?? 0);
        const notFound = r.verdicts.not_indexed ?? 0;
        const open = openId === r.run.id;
        return (
          <div key={r.run.id} style={{ ...card, marginBottom: "10px" }}>
            {/* header row */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "8px" }}>
              <button onClick={() => { setOpenId(open ? "" : r.run.id); setVerdictFilter("all"); setItemOffset(0); }} style={{ ...btn, border: "none", padding: "2px 4px" }}>
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>
                {r.run.name || r.run.id.slice(0, 8)}
              </span>
              <span style={chip(RUN_COLORS[r.run.status] ?? "#8e8e93")}>
                {t(`icRun_${r.run.status}`)}{r.run.statusReason === "auto_paused_errors" ? ` · ${t("icAutoPaused")}` : ""}
              </span>
              <span style={muted}>{r.run.provider} · {r.run.createdAt.slice(0, 16).replace("T", " ")}</span>
              <span style={{ ...muted, marginLeft: "auto", display: "flex", gap: "10px" }}>
                <span style={{ color: VERDICT_COLORS.indexed }}>{r.verdicts.indexed ?? 0} {t("idxSerp_indexed")}</span>
                <span style={{ color: VERDICT_COLORS.not_indexed }}>{notFound} {t("idxSerp_not_indexed")}</span>
                {(r.counts.queued ?? 0) + (r.counts.running ?? 0) > 0 && (
                  <span>{(r.counts.queued ?? 0) + (r.counts.running ?? 0)} {t("icQueueShort")}</span>
                )}
              </span>
              {r.run.status === "active" && (
                <button onClick={() => act(r.run.id, "pause")} disabled={!!actionBusy} style={{ ...btn, padding: "4px 10px" }}>
                  <Pause size={13} /> {t("icPause")}
                </button>
              )}
              {r.run.status === "paused" && (
                <button onClick={() => act(r.run.id, "resume")} disabled={!!actionBusy} style={{ ...btn, padding: "4px 10px" }}>
                  <Play size={13} /> {t("icResume")}
                </button>
              )}
              {(r.run.status === "active" || r.run.status === "paused") && (
                <button onClick={() => act(r.run.id, "cancel")} disabled={!!actionBusy} style={{ ...btn, padding: "4px 10px", color: "#F87171", borderColor: "#F8717155" }}>
                  <Square size={13} /> {t("icCancel")}
                </button>
              )}
            </div>

            {/* progress bar */}
            <div style={{ height: "6px", borderRadius: "999px", background: "var(--color-border)", overflow: "hidden", marginBottom: "8px" }}>
              <div style={{ width: `${Math.round((settled / total) * 100)}%`, height: "100%", background: RUN_COLORS.active, transition: "width .4s" }} />
            </div>

            {/* detail */}
            {open && detail && detail.run.id === r.run.id && (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", borderTop: "1px solid var(--color-border)", paddingTop: "10px" }}>
                {/* by-site breakdown */}
                {!!detail.bySite.length && (
                  <div>
                    <div style={{ ...label, marginBottom: "6px" }}>{t("icBySite")}</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                      <tbody>
                        {detail.bySite.map(s => (
                          <tr key={s.siteId ?? "foreign"} style={{ borderBottom: "1px solid var(--color-border)" }}>
                            <td style={{ padding: "5px 6px", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {s.siteId ? s.siteDomain : t("icForeignBucket")}
                            </td>
                            <td style={{ padding: "5px 6px", color: "var(--color-text-secondary)" }}>{s.total}</td>
                            <td style={{ padding: "5px 6px", color: VERDICT_COLORS.not_indexed, fontWeight: 600 }}>{s.notIndexed} {t("idxSerp_not_indexed")}</td>
                            <td style={{ padding: "5px 6px", textAlign: "right" }}>
                              {s.notIndexed > 0 && (
                                <button onClick={() => copyNotFound(r.run.id, s.siteId ?? undefined)} style={{ ...btn, padding: "2px 8px", fontSize: "11px" }}>
                                  {copied === r.run.id + (s.siteId ?? "") ? <Check size={12} /> : <Copy size={12} />}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* export + indexer push */}
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => copyNotFound(r.run.id)} style={btn}>
                    {copied === r.run.id ? <Check size={14} /> : <Copy size={14} />} {t("icCopyNotFoundN").replace("{n}", String(notFound))}
                  </button>
                  <a href={`/api/index-check/${r.run.id}/not-found?format=txt`} style={{ ...btn, textDecoration: "none" }} download>
                    <Download size={14} /> {t("icDownloadTxt")}
                  </a>
                  <span style={{ ...muted, display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "6px" }}>
                    <Send size={13} /> {t("icSendTo")}:
                  </span>
                  {(["neural", "2index", "farm"] as const).map(target => (
                    <button key={target} onClick={() => sendNotFound(r.run.id, target)} disabled={!!sending || notFound === 0}
                      title={target === "neural" ? "NeuralIndexer" : target === "2index" ? "2index.ninja" : t("icSendFarm")}
                      style={{ ...btn, padding: "5px 10px" }}>
                      {sending === target ? <Loader2 size={13} className="spin" /> : null}
                      {target === "neural" ? t("icSendNeural") : target === "2index" ? t("icSend2index") : t("icSendFarm")}
                    </button>
                  ))}
                  {sendMsg && <span style={{ ...muted, color: sendMsg.startsWith(t("icSentOk").slice(0, 4)) ? "#4ADE80" : "#F87171" }}>{sendMsg}</span>}
                </div>

                {/* items */}
                <div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
                    <span style={label}>{t("icItemsTitle")} · {detail.itemsTotal}</span>
                    {["all", "indexed", "not_indexed", "error"].map(v => (
                      <button key={v} onClick={() => { setVerdictFilter(v); setItemOffset(0); }}
                        style={{ ...btn, padding: "3px 9px", fontSize: "11px", borderColor: verdictFilter === v ? "var(--color-accent, #3b82f6)" : "var(--color-border)" }}>
                        {v === "all" ? t("icVerdictAll") : t(`idxSerp_${v}`)}
                      </button>
                    ))}
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <tbody>
                      {detail.items.map((it, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid var(--color-border)" }}>
                          <td style={{ padding: "5px 6px", maxWidth: "380px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.url}>{it.url}</td>
                          <td style={{ padding: "5px 6px", width: "110px" }}>
                            {it.verdict
                              ? <span style={{ color: VERDICT_COLORS[it.verdict] ?? "inherit", fontWeight: 600 }}>{t(`idxSerp_${it.verdict}`)}</span>
                              : <span style={{ color: "var(--color-text-secondary)" }}>{it.status}</span>}
                          </td>
                          <td style={{ padding: "5px 6px", color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "220px" }} title={it.detail ?? ""}>
                            {it.detail ?? ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                    {itemOffset > 0 && <button style={{ ...btn, padding: "3px 9px", fontSize: "11px" }} onClick={() => setItemOffset(Math.max(0, itemOffset - 100))}>{t("icItemsPrev")}</button>}
                    {detail.nextOffset != null && <button style={{ ...btn, padding: "3px 9px", fontSize: "11px" }} onClick={() => setItemOffset(detail.nextOffset!)}>{t("icItemsNext")}</button>}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} .spin{animation:spin 1s linear infinite}`}</style>
    </>
  );
}
