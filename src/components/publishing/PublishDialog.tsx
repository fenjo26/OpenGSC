"use client";

// The Publish dialog — shared by the History list rows and the history detail page. Picks a
// site (connections belong to one), multi-selects its connections, optionally turns on the
// AI respin, and POSTs once. The respin toggle names the model that will spend (resolved from
// the "respin" task slot, the same chain the badge on /publishing uses) because a switch that
// bills silently is how per-task settings end up ignored.
//
// R+ hardening, all mirrored from the SERVER rules (the store enforces; this only shows):
//   - respin is offered only when a selected connection is external_platform (the store
//     refuses it for everything else, per connection, with a stated error);
//   - when every selected connection is an own_satellite, the dialog switches to
//     per-connection sources — each satellite carries its own post (pubPerConnectionSource);
//   - a spread window (hours/days) defers the batch as "scheduled" with a random offset —
//     respin and the uniqueness gate run at SEND time, so the review quotes what WILL happen;
//   - the review step (preview API) shows the anchor distribution, the footprint warnings
//     and the honest gate note (pubGateNote) before anything is committed.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Send, Loader2, CheckCircle2, AlertTriangle, ExternalLink, Clock } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { AI_PROVIDER_NAMES, resolveTaskCreds } from "@/lib/seo/keys";
import { UNIQUENESS_BLOCK_THRESHOLD, UNIQUENESS_WARN_THRESHOLD } from "@/lib/publish/gate";

export const PUBLISHING_SITE_KEY = "publishingSiteId";

interface SiteLite { id: string; url: string }
interface ConnectionLite {
  id: string; platform: string; connectionType: string; label: string; siteIdentifier: string; status: string;
}
/** Thin history row from /api/seo/history?index=1 — the per-connection source picker. */
interface HistLite { id: string; type: string; keyword: string; createdAt: number }
interface PostResult {
  id: string; title: string; status: string; remoteUrl: string; respinUsed: boolean; error: string;
  connectionLabel: string; scheduledAt: string | null; uniquenessScore: number | null;
}
interface AnchorRowT { anchor: string; posts: number; urls: string[]; repeated: boolean }
interface WarningsT {
  skeletons: { skeleton: string; titles: string[] }[];
  repeatedAnchors: AnchorRowT[];
  clusters: { hour: string; titles: string[] }[];
}
interface ReviewT {
  planned: { connectionId: string; label: string; connectionType: string; title: string }[];
  anchorSummary: { rows: AnchorRowT[]; postsWithLinks: number };
  warnings: WarningsT;
  respinRefusedFor: string[];
  thresholds?: { block: number; warn: number };
}
interface ResultT {
  posts: PostResult[];
  failures: { label: string; error: string }[];
  anchorSummary: { rows: AnchorRowT[] };
  warnings: WarningsT;
}

/** One per-connection source in the own-satellite mode: a history entry, or pasted text. */
interface PerSource { historyId: string; paste: boolean; title: string; markdown: string }

export interface PublishDialogProps {
  /** SeoHistory id to publish (falls back to the passed title/markdown if not synced yet). */
  historyId?: string;
  fallbackTitle?: string;
  fallbackMarkdown?: string;
  onClose: () => void;
}

const emptyPerSource = (): PerSource => ({ historyId: "", paste: false, title: "", markdown: "" });

export default function PublishDialog({ historyId, fallbackTitle, fallbackMarkdown, onClose }: PublishDialogProps) {
  const { t } = useLanguage();
  const router = useRouter();
  const [sites, setSites] = useState<SiteLite[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [connections, setConnections] = useState<ConnectionLite[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [respin, setRespin] = useState(false);
  const [spread, setSpread] = useState("");
  const [spreadUnit, setSpreadUnit] = useState<"hours" | "days">("hours");
  const [phase, setPhase] = useState<"form" | "review" | "result">("form");
  const [review, setReview] = useState<ReviewT | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ResultT | null>(null);
  // Own-satellite mode: per-connection sources + the lazily loaded thin history list.
  const [history, setHistory] = useState<HistLite[] | null>(null);
  const [perSource, setPerSource] = useState<Record<string, PerSource>>({});

  // The respin slot's resolved model, read once after mount (localStorage is client-only) —
  // same resolution order the AiModelBadge shows on tool pages.
  const [respinCreds, setRespinCreds] = useState<{ label: string; hasKey: boolean } | null>(null);
  useEffect(() => { setRespinCreds(respinCredsLabel()); }, []);

  // Site list first; the remembered choice (or the only site) preselects.
  const loadSites = useCallback(async () => {
    try {
      const d = await fetch("/api/publishing/connections").then(r => r.json());
      const list = (d?.sites ?? []) as SiteLite[];
      setSites(list);
      const saved = localStorage.getItem(PUBLISHING_SITE_KEY);
      if (saved && list.some(s => s.id === saved)) setSiteId(saved);
      else if (list.length === 1) setSiteId(list[0].id);
    } catch { setSites([]); }
  }, []);
  useEffect(() => {
    const id = setTimeout(() => { void loadSites(); }, 0);
    return () => clearTimeout(id);
  }, [loadSites]);

  const loadConnections = useCallback(async (id: string) => {
    setConnections(null);
    setPerSource({});
    try {
      const d = await fetch(`/api/publishing/connections?siteId=${encodeURIComponent(id)}`).then(r => r.json());
      setConnections((d?.connections ?? []) as ConnectionLite[]);
      setSelected(new Set());
    } catch { setConnections([]); }
  }, []);
  useEffect(() => {
    if (!siteId) return;
    localStorage.setItem(PUBLISHING_SITE_KEY, siteId);
    const id = setTimeout(() => { void loadConnections(siteId); }, 0);
    return () => clearTimeout(id);
  }, [siteId, loadConnections]);

  const selectedConns = useMemo(
    () => (connections ?? []).filter(c => selected.has(c.id)),
    [connections, selected],
  );
  // All own satellites → per-connection sources (each satellite gets its own post). Any
  // external platform in the batch → the flat form (a shared source is fine to adapt).
  const perConnectionMode = selectedConns.length > 0 && selectedConns.every(c => c.connectionType === "own_satellite");
  const anyExternal = selectedConns.some(c => c.connectionType === "external_platform");

  // The thin history list loads once, only when per-connection mode is live.
  useEffect(() => {
    if (!perConnectionMode || history !== null) return;
    const id = setTimeout(async () => {
      try {
        const d = await fetch("/api/seo/history?index=1").then(r => r.json());
        setHistory(((d?.rows ?? []) as HistLite[]).filter(r => r.type === "text" || r.type === "landing"));
      } catch { setHistory([]); }
    }, 0);
    return () => clearTimeout(id);
  }, [perConnectionMode, history]);

  // Respin is impossible for a batch with no external platform — the toggle disappears
  // (cosmetics; the store refuses it per connection regardless).
  useEffect(() => { if (!anyExternal && respin) setRespin(false); }, [anyExternal, respin]);

  // Prefill: when the dialog opens from a history entry, the first selected own-satellite
  // connection starts on that entry; the rest stay empty on purpose — picking them IS the task.
  useEffect(() => {
    if (!perConnectionMode || !selectedConns.length) return;
    setPerSource(prev => {
      const next = { ...prev };
      for (const c of selectedConns) {
        if (next[c.id]) continue;
        next[c.id] = historyId && c === selectedConns[0] && !fallbackMarkdown
          ? { ...emptyPerSource(), historyId }
          : fallbackMarkdown && c === selectedConns[0]
            ? { ...emptyPerSource(), paste: true, title: fallbackTitle || "", markdown: fallbackMarkdown }
            : emptyPerSource();
      }
      return next;
    });
  }, [perConnectionMode, selectedConns, historyId, fallbackTitle, fallbackMarkdown]);

  const sourceComplete = (c: ConnectionLite): boolean => {
    const s = perSource[c.id];
    if (!s) return false;
    return s.paste ? s.markdown.trim().length > 0 : !!s.historyId;
  };

  const canPlan = !sending && !!siteId && selected.size > 0
    && (!respin || !!respinCreds?.hasKey)
    && (!perConnectionMode || selectedConns.every(sourceComplete));

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** The request body shared by preview and publish — one shape, no drift between steps. */
  function buildBody() {
    const body: Record<string, unknown> = { siteId, respin };
    if (spread && Number(spread) > 0) {
      body[spreadUnit === "hours" ? "windowHours" : "windowDays"] = Number(spread);
    }
    if (perConnectionMode) {
      body.items = selectedConns.map(c => {
        const s = perSource[c.id];
        return s.paste
          ? { connectionId: c.id, title: s.title, markdown: s.markdown }
          : { connectionId: c.id, historyId: s.historyId };
      });
    } else {
      body.connectionIds = [...selected];
      if (historyId) body.historyId = historyId;
      if (fallbackTitle) body.title = fallbackTitle;
      if (fallbackMarkdown) body.markdown = fallbackMarkdown;
    }
    return body;
  }

  async function startReview() {
    setSending(true); setError(""); setReview(null);
    try {
      const res = await fetch("/api/publishing/publish/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const d = await res.json();
      if (!res.ok) { setError(String(d?.error ?? "failed")); setSending(false); return; }
      setReview(d as ReviewT);
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSending(false);
  }

  async function send() {
    setSending(true); setError("");
    try {
      const res = await fetch("/api/publishing/publish", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const d = await res.json();
      if (!res.ok) { setError(String(d?.error ?? "failed")); setSending(false); return; }
      setResult({ posts: d?.posts ?? [], failures: d?.failures ?? [], anchorSummary: d?.anchorSummary ?? { rows: [] }, warnings: d?.warnings ?? { skeletons: [], repeatedAnchors: [], clusters: [] } });
      setPhase("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSending(false);
  }

  const siteLabel = useMemo(() => (url: string) =>
    url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/+$/, ""), []);
  const typeLabel = (v: string) =>
    v === "money_site" ? t("pubTypeMoneySite") : v === "external_platform" ? t("pubTypeExternal") : t("pubTypeOwnSatellite");

  const historyLabel = (h: HistLite) =>
    `${h.keyword || h.id.slice(0, 8)} · ${h.type} · ${new Date(h.createdAt).toLocaleDateString()}`;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: "24px" }} onClick={onClose}>
      <div className="panel" style={{ width: "560px", maxWidth: "95vw", maxHeight: "85vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
            <Send size={16} color="var(--color-accent-blue)" /> {t("publishPublish")}
          </div>
          <button onClick={onClose} style={{ ...btnGhost, padding: "6px" }}><X size={14} /></button>
        </div>
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>
          {fallbackTitle || historyId ? (fallbackTitle || historyId!.slice(0, 8)) : ""}
        </div>

        {phase === "form" && (<>
          {/* Site picker — connections are per site, so this comes first. */}
          <select className="tool-input" value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">{sites === null ? "…" : "—"}</option>
            {(sites ?? []).map(s => <option key={s.id} value={s.id}>{siteLabel(s.url)}</option>)}
          </select>

          <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", margin: "16px 0 8px" }}>{t("publishSelectConnections")}</div>
          {connections === null && <div style={{ fontSize: "13px", color: "var(--color-text-tertiary)", padding: "8px 0" }}><Loader2 size={14} className="spin" /></div>}
          {connections !== null && connections.length === 0 && (
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", padding: "8px 0" }}>{t("publishNoConnections")}</div>
          )}
          {connections?.map(c => (
            <label key={c.id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "9px 10px", border: "1px solid var(--color-border)", borderRadius: "8px", marginBottom: "6px", cursor: "pointer", background: selected.has(c.id) ? "rgba(41,151,255,0.06)" : "transparent" }}>
              <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.platform} · {c.siteIdentifier} · {typeLabel(c.connectionType)}
                </span>
              </span>
              <StatusChip status={c.status} />
            </label>
          ))}

          {/* Per-connection sources: every selected connection is an own satellite, so each
              one carries its own post — a history entry or a pasted draft per satellite. */}
          {perConnectionMode && selectedConns.length > 0 && (
            <div style={{ marginTop: "12px", padding: "12px", border: "1px dashed var(--color-border)", borderRadius: "10px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "8px" }}>{t("pubPerConnectionSource")}</div>
              {selectedConns.map(c => {
                const s = perSource[c.id] ?? emptyPerSource();
                return (
                  <div key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--color-border)" }}>
                    <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: "6px" }}>{c.label}</div>
                    {!s.paste ? (
                      <div style={{ display: "flex", gap: "8px" }}>
                        <select className="tool-input" value={s.historyId} onChange={e => setPerSource(prev => ({ ...prev, [c.id]: { ...(prev[c.id] ?? emptyPerSource()), historyId: e.target.value } }))}>
                          <option value="">{history === null ? "…" : "—"}</option>
                          {(history ?? []).map(h => <option key={h.id} value={h.id}>{historyLabel(h)}</option>)}
                        </select>
                        <button onClick={() => setPerSource(prev => ({ ...prev, [c.id]: { ...(prev[c.id] ?? emptyPerSource()), paste: true } }))} style={{ ...btnGhost, flexShrink: 0 }} title={t("contentOpsManualDraft")}>
                          {t("contentOpsManualDraft")}
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        <input className="tool-input" placeholder={t("publishLabel")} value={s.title} onChange={e => setPerSource(prev => ({ ...prev, [c.id]: { ...(prev[c.id] ?? emptyPerSource()), title: e.target.value } }))} />
                        <textarea className="tool-input" rows={4} value={s.markdown} onChange={e => setPerSource(prev => ({ ...prev, [c.id]: { ...(prev[c.id] ?? emptyPerSource()), markdown: e.target.value } }))} />
                        <button onClick={() => setPerSource(prev => ({ ...prev, [c.id]: { ...emptyPerSource() } }))} style={{ ...btnGhost, alignSelf: "flex-start" }}>
                          <X size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Respin: only offered when an external platform is in the batch — the store's
              whitelist made visible. Hidden, not merely disabled: a visible-but-dead switch
              reads as "broken", not as "not allowed for own satellites". */}
          {anyExternal && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer", marginTop: "14px", padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "8px" }}>
              <input type="checkbox" checked={respin} onChange={e => setRespin(e.target.checked)} style={{ marginTop: "2px" }} />
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 600 }}>{t("publishRespin")}</span>
                <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>{t("publishRespinHint")} · {t("pubTypeHint")}</span>
                {respinCreds && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600, marginTop: "6px", padding: "2px 8px", borderRadius: "20px", background: respinCreds.hasKey ? "rgba(52,199,89,0.12)" : "rgba(245,158,11,0.12)", color: respinCreds.hasKey ? "var(--color-accent-green)" : "#F59E0B" }}>
                    {respinCreds.label}
                  </span>
                )}
              </span>
            </label>
          )}

          {/* Spread: defer the batch with a random offset inside the window. The offset is
              fixed at creation; respin and the uniqueness gate run when the scheduler sends. */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "14px", padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "8px", fontSize: "13px", color: "var(--color-text-primary)" }}>
            <Clock size={14} color="var(--color-text-tertiary)" />
            <span style={{ fontWeight: 600 }}>{t("pubScheduleWindow")}</span>
            <input className="tool-input" style={{ width: "76px", padding: "5px 8px" }} type="number" min={0} value={spread} onChange={e => setSpread(e.target.value)} placeholder="—" />
            <select className="tool-input" style={{ width: "auto", padding: "5px 8px" }} value={spreadUnit} onChange={e => setSpreadUnit(e.target.value as "hours" | "days")}>
              <option value="hours">{t("pubHours")}</option>
              <option value="days">{t("pubDays")}</option>
            </select>
          </div>

          {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginTop: "10px" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <button onClick={onClose} style={btnGhost}>{t("seoCancelEdit")}</button>
            <button onClick={startReview} disabled={!canPlan} style={{ ...btnPrimary, opacity: canPlan ? 1 : 0.5 }}>
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {t("publishPublish")}
            </button>
          </div>
        </>)}

        {/* Review step: the honest pre-send picture. Warnings are visible, never blocking —
            blocking belongs to the gate, at send time, with a named reason. */}
        {phase === "review" && review && (<>
          <ReviewPanel review={review} />
          {/* The gate's terms, stated before the operator commits — including what it does
              NOT catch (paraphrases). */}
          <div style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)", marginTop: "10px", padding: "8px 10px", background: "var(--color-bg)", borderRadius: "8px" }}>
            {t("pubUniqueness")}: ≥ {(review.thresholds?.block ?? UNIQUENESS_BLOCK_THRESHOLD).toFixed(2)} → {t("pubBlockedStatus")}; ≥ {(review.thresholds?.warn ?? UNIQUENESS_WARN_THRESHOLD).toFixed(2)} → {t("pubSimilarTo")}. {t("pubGateNote")}
          </div>
          {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginTop: "10px" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <button onClick={() => setPhase("form")} style={btnGhost}>{t("seoCancelEdit")}</button>
            <button onClick={send} disabled={sending} style={{ ...btnPrimary, opacity: sending ? 0.5 : 1 }}>
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {t("publishPublish")}
            </button>
          </div>
        </>)}

        {phase === "result" && result && (
          <div>
            {result.posts.map(p => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--color-border)" }}>
                {p.status === "published" ? <CheckCircle2 size={16} color="var(--color-accent-green)" /> : <AlertTriangle size={16} color={p.status === "blocked" ? "#F59E0B" : "var(--color-accent-red)"} />}
                <span style={{ flex: 1, minWidth: 0, fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.title}
                  {p.respinUsed && <span style={{ fontSize: "10px", fontWeight: 700, marginLeft: "8px", padding: "2px 7px", borderRadius: "10px", background: "rgba(191,90,242,0.14)", color: "var(--color-accent-purple)" }}>{t("publishRespinUsed")}</span>}
                  {p.scheduledAt && <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>{t("pubStatusScheduled")}: {new Date(p.scheduledAt).toLocaleString()}</span>}
                  {(p.status === "blocked" || p.status === "failed") && p.error && <span style={{ display: "block", fontSize: "11px", color: "var(--color-accent-red)", marginTop: "2px", wordBreak: "break-word" }}>{p.error}</span>}
                  {p.uniquenessScore != null && p.status === "published" && (
                    <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>
                      {t("pubUniqueness")} {p.uniquenessScore.toFixed(2)}
                      {1 - p.uniquenessScore >= UNIQUENESS_WARN_THRESHOLD && 1 - p.uniquenessScore < UNIQUENESS_BLOCK_THRESHOLD ? ` · ${t("pubSimilarTo")}` : ""}
                    </span>
                  )}
                </span>
                <StatusChip status={p.status} />
                {p.remoteUrl && <a href={p.remoteUrl} target="_blank" rel="noopener noreferrer" style={btnGhost}><ExternalLink size={13} /> {t("publishOpenPost")}</a>}
              </div>
            ))}
            {result.failures.map((f, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--color-border)" }}>
                <AlertTriangle size={16} color="var(--color-accent-red)" style={{ marginTop: 1, flexShrink: 0 }} />
                <span style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>
                  <strong>{f.label}</strong>
                  <span style={{ display: "block", fontSize: "12px", color: "var(--color-accent-red)", marginTop: "2px", wordBreak: "break-word" }}>{f.error}</span>
                </span>
              </div>
            ))}
            {(result.warnings.skeletons.length > 0 || result.warnings.repeatedAnchors.length > 0 || result.warnings.clusters.length > 0) && (
              <WarningsBlock warnings={result.warnings} />
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
              <button onClick={onClose} style={btnGhost}>{t("seoCancelEdit")}</button>
              <button onClick={() => { onClose(); router.push("/publishing"); }} style={btnPrimary}>
                {t("publishTitle")} <ExternalLink size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The pre-publish review block, shared by the review step (and reusable as-is elsewhere). */
export function ReviewPanel({ review }: { review: ReviewT }) {
  const { t } = useLanguage();
  return (
    <div>
      {review.planned.map(p => (
        <div key={p.connectionId} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--color-border)", fontSize: "12.5px" }}>
          <span style={{ fontWeight: 600, color: "var(--color-text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
          <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{p.label}</span>
        </div>
      ))}
      <WarningsBlock warnings={review.warnings} />
      {review.anchorSummary.rows.length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-secondary)", marginBottom: "6px" }}>{t("pubAnchorSummary")}</div>
          {review.anchorSummary.rows.map(r => (
            <div key={r.anchor || "(empty)"} style={{ display: "flex", alignItems: "baseline", gap: "8px", padding: "3px 0", fontSize: "12px" }}>
              <span style={{ color: r.repeated ? "#F59E0B" : "var(--color-text-primary)", fontWeight: r.repeated ? 700 : 400, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.anchor ? `"${r.anchor}"` : "(no anchor)"} × {r.posts}
                {r.repeated ? ` · ${t("pubAnchorRepeated")}` : ""}
              </span>
              <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "45%" }} title={r.urls.join(", ")}>
                → {r.urls[0]}{r.urls.length > 1 ? ` +${r.urls.length - 1}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {review.respinRefusedFor.length > 0 && (
        <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginTop: "10px" }}>
          {t("pubTypeHint")} — {review.respinRefusedFor.join(", ")}
        </div>
      )}
    </div>
  );
}

/** Footprint warnings — visible, never blocking (the honest subset; see review.ts). */
export function WarningsBlock({ warnings }: { warnings: WarningsT }) {
  const { t } = useLanguage();
  if (!warnings.skeletons.length && !warnings.repeatedAnchors.length && !warnings.clusters.length) return null;
  return (
    <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
      {warnings.skeletons.length > 0 && (
        <div style={{ fontSize: "12px", color: "#F59E0B" }}>
          <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t("pubSkeletonWarn")}
          <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px", marginLeft: "16px", wordBreak: "break-word" }}>
            {warnings.skeletons.map(s => `${s.skeleton} (${s.titles.length})`).join(" · ")}
          </span>
        </div>
      )}
      {warnings.repeatedAnchors.length > 0 && (
        <div style={{ fontSize: "12px", color: "#F59E0B" }}>
          <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t("pubAnchorRepeated")}:
          <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px", marginLeft: "16px", wordBreak: "break-word" }}>
            {warnings.repeatedAnchors.map(a => `"${a.anchor}" × ${a.posts}`).join(" · ")}
          </span>
        </div>
      )}
      {warnings.clusters.length > 0 && (
        <div style={{ fontSize: "12px", color: "#F59E0B" }}>
          <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t("pubClusterWarn")}
          <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px", marginLeft: "16px" }}>
            {warnings.clusters.map(c => `${c.hour}:00 (${c.titles.length})`).join(" · ")}
          </span>
        </div>
      )}
    </div>
  );
}

function respinCredsLabel(): { label: string; hasKey: boolean } {
  try {
    const c = resolveTaskCreds("respin");
    if (!c.apiKey) return { label: "AI: no key", hasKey: false };
    return { label: `AI: ${AI_PROVIDER_NAMES[c.provider] ?? c.provider} · ${c.model || "default"}`, hasKey: true };
  } catch {
    return { label: "AI", hasKey: false };
  }
}

// Status → chip label key + color. Draft appears only transiently (rows are created as
// "publishing"), but the schema's vocabulary is rendered completely rather than partially.
// R+: scheduled (deferred by the jitter window) and blocked (uniqueness gate at send time).
export function statusMeta(status: string): { labelKey: string; color: string } {
  switch (status) {
    case "ok": return { labelKey: "publishVerifiedOk", color: "var(--color-accent-green)" };
    case "error": return { labelKey: "publishVerifyFailed", color: "var(--color-accent-red)" };
    case "published": return { labelKey: "publishStatusPublished", color: "var(--color-accent-green)" };
    case "publishing": return { labelKey: "publishStatusPublishing", color: "var(--color-accent-blue)" };
    case "scheduled": return { labelKey: "pubStatusScheduled", color: "#8B5CF6" };
    case "failed": return { labelKey: "publishStatusFailed", color: "var(--color-accent-red)" };
    case "blocked": return { labelKey: "pubBlockedStatus", color: "#F59E0B" };
    case "draft": return { labelKey: "publishStatusDraft", color: "var(--color-text-tertiary)" };
    default: return { labelKey: "publishUnverified", color: "var(--color-text-tertiary)" };
  }
}

export function StatusChip({ status }: { status: string }) {
  const { t } = useLanguage();
  const meta = statusMeta(status);
  return (
    <span style={{ fontSize: "10.5px", fontWeight: 700, padding: "3px 9px", borderRadius: "20px", flexShrink: 0, whiteSpace: "nowrap", color: meta.color, background: `${meta.color}1a` }}>
      {t(meta.labelKey as never)}
    </span>
  );
}

const btnGhost: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", textDecoration: "none" };
const btnPrimary: React.CSSProperties = { display: "flex", alignItems: "center", gap: "7px", padding: "8px 16px", borderRadius: "8px", border: "none", background: "var(--color-accent-blue)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", textDecoration: "none" };
