"use client";

// Generation batch queue — the mass-production surface. One call orders
// thousands of pages; the server scheduler drains them under the workspace's
// concurrency setting, so the AI provider never sees a burst.
//
// Three zones, mirroring the audits-page convention that a knob without a
// visible control reads as not shipped:
//   • Create — name, pipeline, keyword list (+ shared knobs). Per-item
//     overrides and site bindings are the agent path (create_generation_batch
//     over MCP); the form orders the simple shared-defaults batch.
//   • Queue settings — concurrency (PAGES in flight), provider gate (LLM
//     calls per key, process-wide — labelled honestly, it is NOT the same
//     knob), retry policy, global pause.
//   • Batches — live counters, ETA, circuit-breaker state, actions
//     (pause/resume/cancel/retry/delete) and a paged item list.

import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2, Pause, Play, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

interface BatchCounts { queued?: number; running?: number; completed?: number; error?: number; skipped?: number }
interface BatchRow {
  id: string; name: string; pipeline: string; status: string; statusReason: string;
  pauseAfterErrors: number; consecutiveErrors: number;
  createdAt: string; finishedAt: string | null;
  counts: BatchCounts; total: number; etaMinutes: number | null;
}
interface ItemRow {
  id: string; phase: string; keyword: string; siteId: string | null; status: string;
  error: string | null; attempt: number; jobId: string | null; priority: number;
}
interface QueueSettings {
  concurrency: number; providerConcurrency: number; retryAttempts: number; retryDelayMin: number; paused: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  active: "#30d158", paused: "#ff9f0a", done: "#8e8e93", cancelled: "#8e8e93",
  queued: "#64d2ff", running: "#0a84ff", completed: "#30d158", error: "#ff453a", skipped: "#8e8e93",
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

export default function BatchPage() {
  const { t } = useLanguage();
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [settings, setSettings] = useState<QueueSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // create form
  const [name, setName] = useState("");
  const [pipeline, setPipeline] = useState<"outline" | "outline_text">("outline_text");
  const [keywords, setKeywords] = useState("");
  const [country, setCountry] = useState("");
  const [language, setLanguage] = useState("");
  const [tone, setTone] = useState("");
  const [wordCount, setWordCount] = useState("");
  const [pauseAfterErrors, setPauseAfterErrors] = useState("5");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<Record<string, unknown> | null>(null);

  // detail view
  const [openId, setOpenId] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [itemStatus, setItemStatus] = useState("");
  const [itemsLoading, setItemsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/seo/batch", { cache: "no-store" });
      const d = await res.json();
      if (res.ok) { setBatches(d.batches ?? []); setSettings(d.settings ?? null); setError(""); }
      else setError(d.error || "failed");
    } catch { setError("failed"); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Refresh while anything is in flight — the queue keeps moving after the tab
  // is open; a finished batch stops the clock.
  const hasActive = batches.some(b => (b.counts.queued ?? 0) + (b.counts.running ?? 0) > 0 && b.status !== "paused" && b.status !== "cancelled");
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(id);
  }, [hasActive, load]);

  const loadItems = useCallback(async (batchId: string, status = itemStatus) => {
    setItemsLoading(true);
    try {
      const q = new URLSearchParams({ limit: "100", ...(status ? { status } : {}) });
      const res = await fetch(`/api/seo/batch/${batchId}?${q}`, { cache: "no-store" });
      const d = await res.json();
      if (res.ok) setItems(d.items ?? []);
    } catch { /* next poll recovers */ } finally { setItemsLoading(false); }
  }, [itemStatus]);

  useEffect(() => {
    if (openId) void loadItems(openId);
    else setItems([]);
  }, [openId, loadItems]);

  const create = async () => {
    const kw = keywords.split("\n").map(s => s.trim()).filter(Boolean);
    if (!kw.length) return;
    setCreating(true); setCreateResult(null);
    try {
      const defaults: Record<string, unknown> = {};
      if (country.trim()) defaults.country = country.trim();
      if (language.trim()) defaults.language = language.trim();
      if (tone.trim()) defaults.tone = tone.trim();
      if (wordCount.trim()) defaults.targetWordCount = Number(wordCount) || undefined;
      const res = await fetch("/api/seo/batch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          pipeline,
          keywords: kw,
          ...(Object.keys(defaults).length ? { defaults } : {}),
          pauseAfterErrors: Number(pauseAfterErrors) || 0,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || "failed"); return; }
      setCreateResult(d);
      setKeywords(""); setName("");
      await load();
    } finally { setCreating(false); }
  };

  const act = async (batchId: string, action: string) => {
    if (action === "delete" && !confirm(t("gbConfirmDelete"))) return;
    try {
      if (action === "delete") await fetch(`/api/seo/batch/${batchId}`, { method: "DELETE" });
      else await fetch(`/api/seo/batch/${batchId}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      if (openId === batchId && (action === "delete" || action === "cancel")) setOpenId("");
      await load();
      if (openId === batchId) await loadItems(batchId);
    } catch { /* surfaced by the next load */ }
  };

  const patchSettings = async (patch: Partial<QueueSettings>) => {
    const next = { ...settings, ...patch } as QueueSettings;
    setSettings(next);
    try {
      const res = await fetch("/api/seo/batch", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (res.ok) { const d = await res.json(); if (d.settings) setSettings(d.settings); await load(); }
    } catch { /* next load recovers */ }
  };

  const statusChip = (s: string, reason = "") => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 600, color: STATUS_COLORS[s] ?? "var(--color-text-secondary)" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLORS[s] ?? "#8e8e93", display: "inline-block" }} />
      {t(`gbSt${s.charAt(0).toUpperCase()}${s.slice(1)}` as never)}
      {reason === "auto_paused_errors" ? ` — ${t("gbAutoPaused")}` : ""}
    </span>
  );

  const progressOf = (b: BatchRow) => {
    const done = (b.counts.completed ?? 0) + (b.counts.error ?? 0) + (b.counts.skipped ?? 0);
    return { done, pct: b.total ? Math.round((done / b.total) * 100) : 0 };
  };

  return (
    <div>
      {/* ── create ─────────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <Layers size={16} color="var(--color-accent-purple)" />
          <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>{t("gbNew")}</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px", marginBottom: "10px" }}>
          <div>
            <span style={label}>{t("gbName")}</span>
            <input style={input} value={name} onChange={e => setName(e.target.value)} placeholder={t("gbNamePh")} />
          </div>
          <div>
            <span style={label}>{t("gbPipeline")}</span>
            <select style={input} value={pipeline} onChange={e => setPipeline(e.target.value as "outline" | "outline_text")}>
              <option value="outline_text">{t("gbPipelineOutlineText")}</option>
              <option value="outline">{t("gbPipelineOutline")}</option>
            </select>
          </div>
          <div>
            <span style={label}>{t("gbCountry")}</span>
            <input style={input} value={country} onChange={e => setCountry(e.target.value)} placeholder="us" />
          </div>
          <div>
            <span style={label}>{t("gbLanguage")}</span>
            <input style={input} value={language} onChange={e => setLanguage(e.target.value)} placeholder="en" />
          </div>
          <div>
            <span style={label}>{t("gbTone")}</span>
            <input style={input} value={tone} onChange={e => setTone(e.target.value)} placeholder={t("gbTonePh")} />
          </div>
          <div>
            <span style={label}>{t("gbWords")}</span>
            <input style={input} value={wordCount} onChange={e => setWordCount(e.target.value)} placeholder="2000" />
          </div>
          <div>
            <span style={label}>{t("gbPauseAfter")}</span>
            <input style={input} value={pauseAfterErrors} onChange={e => setPauseAfterErrors(e.target.value)} placeholder="5" />
          </div>
        </div>
        <span style={label}>{t("gbKeywords")}</span>
        <textarea
          style={{ ...input, minHeight: 110, fontFamily: "inherit", resize: "vertical" }}
          value={keywords} onChange={e => setKeywords(e.target.value)}
          placeholder={t("gbKeywordsPh")}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "10px", flexWrap: "wrap" }}>
          <button style={btn({ background: "var(--color-accent-purple)", border: "none", color: "#fff", fontWeight: 600 })} onClick={() => void create()} disabled={creating}>
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {t("gbCreate")}
          </button>
          <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("gbKeywordsHint")}</span>
        </div>
        {createResult && (
          <div style={{ marginTop: "10px", padding: "10px 12px", borderRadius: "8px", fontSize: "13px", background: "rgba(48,209,88,0.08)", border: "1px solid rgba(48,209,88,0.25)" }}>
            <div style={{ fontWeight: 600 }}>{t("gbCreated")}: {String(createResult.outlineItems)} + {String(createResult.textItems)} text · ≈{String(createResult.estimatedCalls)} {t("gbCalls")}</div>
            {Array.isArray(createResult.skippedDuplicates) && createResult.skippedDuplicates.length > 0 && (
              <div style={{ marginTop: 4, color: "var(--color-text-secondary)" }}>{t("gbDupSkipped")}: {String(createResult.skippedDuplicates.length)}</div>
            )}
            {Array.isArray(createResult.alreadyGenerated) && createResult.alreadyGenerated.length > 0 && (
              <div style={{ marginTop: 4, color: "#ff9f0a" }}>{t("gbAlreadyGen")}: {String(createResult.alreadyGenerated.length)}</div>
            )}
          </div>
        )}
      </div>

      {/* ── queue settings ────────────────────────────────────────────────── */}
      {settings && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>{t("gbQueueSettings")}</h2>
            <button style={btn(settings.paused
              ? { borderColor: "#30d158", color: "#30d158" }
              : { borderColor: "#ff453a", color: "#ff453a" })}
              onClick={() => void patchSettings({ paused: !settings.paused })}>
              {settings.paused ? <Play size={14} /> : <Pause size={14} />}
              {settings.paused ? t("gbResumeAll") : t("gbPauseAll")}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
            <div>
              <span style={label}>{t("gbConcurrency")} — {settings.concurrency}</span>
              <input type="range" min={1} max={16} value={settings.concurrency} style={{ width: "100%" }}
                onChange={e => setSettings({ ...settings, concurrency: Number(e.target.value) })}
                onMouseUp={() => void patchSettings({ concurrency: settings.concurrency })}
                onTouchEnd={() => void patchSettings({ concurrency: settings.concurrency })} />
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("gbConcurrencyHint")}</div>
            </div>
            <div>
              <span style={label}>{t("gbProviderConcurrency")} — {settings.providerConcurrency > 0 ? settings.providerConcurrency : "∞"}</span>
              <input type="range" min={0} max={32} value={settings.providerConcurrency} style={{ width: "100%" }}
                onChange={e => setSettings({ ...settings, providerConcurrency: Number(e.target.value) })}
                onMouseUp={() => void patchSettings({ providerConcurrency: settings.providerConcurrency })}
                onTouchEnd={() => void patchSettings({ providerConcurrency: settings.providerConcurrency })} />
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("gbProviderConcurrencyHint")}</div>
            </div>
            <div>
              <span style={label}>{t("gbRetries")}</span>
              <input type="number" min={0} max={5} style={input} value={settings.retryAttempts}
                onChange={e => void patchSettings({ retryAttempts: Number(e.target.value) })} />
            </div>
            <div>
              <span style={label}>{t("gbRetryDelay")}</span>
              <input type="number" min={1} max={1440} style={input} value={settings.retryDelayMin}
                onChange={e => void patchSettings({ retryDelayMin: Number(e.target.value) })} />
            </div>
          </div>
        </div>
      )}

      {/* ── batches ───────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>{t("gbBatches")}</h2>
          <button style={btn()} onClick={() => void load()}><RefreshCw size={13} /></button>
        </div>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "30px" }}><Loader2 size={20} className="animate-spin" /></div>
        ) : error && error !== "not_migrated" ? (
          <div style={{ fontSize: "13px", color: "#ff453a" }}>{error}</div>
        ) : !batches.length ? (
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "20px 0" }}>{t("gbEmpty")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {batches.map(b => {
              const { done, pct } = progressOf(b);
              const isActive = (b.counts.queued ?? 0) + (b.counts.running ?? 0) > 0;
              return (
                <div key={b.id} style={{ border: "1px solid var(--color-border)", borderRadius: "10px", padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontWeight: 600, fontSize: "14px" }}>{b.name}</span>
                        {statusChip(b.status, b.statusReason)}
                        <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{b.pipeline === "outline" ? "outline" : "outline + text"}</span>
                      </div>
                      <div style={{ display: "flex", gap: "10px", fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "4px", flexWrap: "wrap" }}>
                        <span>{done}/{b.total}</span>
                        <span style={{ color: STATUS_COLORS.completed }}>✓ {b.counts.completed ?? 0}</span>
                        <span style={{ color: STATUS_COLORS.running }}>▶ {b.counts.running ?? 0}</span>
                        <span style={{ color: STATUS_COLORS.queued }}>· {b.counts.queued ?? 0}</span>
                        {!!b.counts.error && <span style={{ color: STATUS_COLORS.error }}>✗ {b.counts.error}</span>}
                        {!!b.counts.skipped && <span style={{ color: STATUS_COLORS.skipped }}>— {b.counts.skipped}</span>}
                        {b.etaMinutes != null && isActive && <span>~{b.etaMinutes} {t("gbMinutes")}</span>}
                        {b.consecutiveErrors > 0 && <span style={{ color: "#ff9f0a" }}>{t("gbStreak")}: {b.consecutiveErrors}/{b.pauseAfterErrors}</span>}
                      </div>
                      <div style={{ height: 3, borderRadius: 2, background: "var(--color-border)", marginTop: "8px", overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: "var(--color-accent-purple)", transition: "width .3s" }} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {b.status === "active" && <button style={btn()} onClick={() => void act(b.id, "pause")}><Pause size={13} />{t("gbPause")}</button>}
                      {b.status === "paused" && <button style={btn({ borderColor: "#30d158", color: "#30d158" })} onClick={() => void act(b.id, "resume")}><Play size={13} />{t("gbResume")}</button>}
                      {(b.counts.error ?? 0) + (b.counts.skipped ?? 0) > 0 && b.status !== "cancelled" && (
                        <button style={btn()} onClick={() => void act(b.id, "retry")}><RotateCcw size={13} />{t("gbRetry")}</button>
                      )}
                      {b.status !== "cancelled" && b.status !== "done" && (
                        <button style={btn()} onClick={() => void act(b.id, "cancel")}><X size={13} />{t("gbCancel")}</button>
                      )}
                      <button style={btn({ color: "#ff453a", borderColor: "rgba(255,69,58,0.4)" })} onClick={() => void act(b.id, "delete")}><Trash2 size={13} /></button>
                      <button style={btn()} onClick={() => setOpenId(openId === b.id ? "" : b.id)}>{openId === b.id ? t("gbHide") : t("gbDetail")}</button>
                    </div>
                  </div>

                  {openId === b.id && (
                    <div style={{ marginTop: "12px", borderTop: "1px solid var(--color-border)", paddingTop: "10px" }}>
                      <div style={{ display: "flex", gap: "6px", marginBottom: "8px", flexWrap: "wrap" }}>
                        {["", "queued", "running", "completed", "error", "skipped"].map(s => (
                          <button key={s || "all"} style={btn({
                            padding: "4px 10px", fontSize: "12px",
                            ...(itemStatus === s ? { borderColor: "var(--color-accent-purple)", color: "var(--color-accent-purple)" } : {}),
                          })} onClick={() => { setItemStatus(s); void loadItems(b.id, s); }}>
                            {s ? t(`gbSt${s.charAt(0).toUpperCase()}${s.slice(1)}` as never) : t("gbAll")}
                          </button>
                        ))}
                      </div>
                      {itemsLoading ? (
                        <div style={{ display: "flex", justifyContent: "center", padding: "16px" }}><Loader2 size={16} className="animate-spin" /></div>
                      ) : (
                        <div style={{ maxHeight: 320, overflowY: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                            <thead>
                              <tr style={{ textAlign: "left", color: "var(--color-text-secondary)" }}>
                                <th style={{ padding: "4px 8px" }}>{t("gbPhase")}</th>
                                <th style={{ padding: "4px 8px" }}>{t("gbKeyword")}</th>
                                <th style={{ padding: "4px 8px" }}>{t("gbStatusCol")}</th>
                                <th style={{ padding: "4px 8px" }}>{t("gbAttempt")}</th>
                                <th style={{ padding: "4px 8px" }}>{t("gbErrorCol")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(it => (
                                <tr key={it.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                                  <td style={{ padding: "4px 8px", color: "var(--color-text-secondary)" }}>{it.phase === "outline" ? t("gbPhaseOutline") : t("gbPhaseText")}</td>
                                  <td style={{ padding: "4px 8px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.keyword}</td>
                                  <td style={{ padding: "4px 8px", color: STATUS_COLORS[it.status] }}>{t(`gbSt${it.status.charAt(0).toUpperCase()}${it.status.slice(1)}` as never)}</td>
                                  <td style={{ padding: "4px 8px" }}>{it.attempt}</td>
                                  <td style={{ padding: "4px 8px", color: "#ff453a", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.error ?? ""}>{it.error ?? ""}</td>
                                </tr>
                              ))}
                              {!items.length && (
                                <tr><td colSpan={5} style={{ padding: "10px 8px", color: "var(--color-text-secondary)" }}>{t("gbNoItems")}</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
