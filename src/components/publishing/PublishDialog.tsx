"use client";

// The Publish dialog — shared by the History list rows and the history detail page. Picks a
// site (connections belong to one), multi-selects its connections, optionally turns on the
// AI respin, and POSTs once. The respin toggle names the model that will spend (resolved from
// the "respin" task slot, the same chain the badge on /publishing uses) because a switch that
// bills silently is how per-task settings end up ignored.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Send, Loader2, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { AI_PROVIDER_NAMES, resolveTaskCreds } from "@/lib/seo/keys";

export const PUBLISHING_SITE_KEY = "publishingSiteId";

interface SiteLite { id: string; url: string }
interface ConnectionLite {
  id: string; platform: string; label: string; siteIdentifier: string; status: string;
}
interface PostResult {
  id: string; title: string; status: string; remoteUrl: string; respinUsed: boolean; error: string;
  connectionLabel: string;
}

export interface PublishDialogProps {
  /** SeoHistory id to publish (falls back to the passed title/markdown if not synced yet). */
  historyId?: string;
  fallbackTitle?: string;
  fallbackMarkdown?: string;
  onClose: () => void;
}

export default function PublishDialog({ historyId, fallbackTitle, fallbackMarkdown, onClose }: PublishDialogProps) {
  const { t } = useLanguage();
  const router = useRouter();
  const [sites, setSites] = useState<SiteLite[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [connections, setConnections] = useState<ConnectionLite[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [respin, setRespin] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ posts: PostResult[]; failures: { label: string; error: string }[] } | null>(null);

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

  const canSend = !sending && !!siteId && selected.size > 0 && (!respin || !!respinCreds?.hasKey);

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function send() {
    setSending(true); setError(""); setResult(null);
    try {
      const res = await fetch("/api/publishing/publish", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId,
          historyId,
          title: fallbackTitle || undefined,
          markdown: fallbackMarkdown || undefined,
          connectionIds: [...selected],
          respin,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setError(String(d?.error ?? "failed")); setSending(false); return; }
      setResult({ posts: d?.posts ?? [], failures: d?.failures ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSending(false);
  }

  const siteLabel = useMemo(() => (url: string) =>
    url.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/+$/, ""), []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: "24px" }} onClick={onClose}>
      <div className="panel" style={{ width: "520px", maxWidth: "95vw", maxHeight: "85vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "8px" }}>
            <Send size={16} color="var(--color-accent-blue)" /> {t("publishPublish")}
          </div>
          <button onClick={onClose} style={{ ...btnGhost, padding: "6px" }}><X size={14} /></button>
        </div>
        <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "12px" }}>
          {fallbackTitle || historyId ? (fallbackTitle || historyId!.slice(0, 8)) : ""}
        </div>

        {!result && (<>
          {/* Site picker — connections are per site, so this comes first. */}
          <select className="tool-input" value={siteId} onChange={e => setSiteId(e.target.value)} disabled={!!result}>
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
                <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.platform} · {c.siteIdentifier}</span>
              </span>
              <StatusChip status={c.status} />
            </label>
          ))}

          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "13px", color: "var(--color-text-primary)", cursor: "pointer", marginTop: "14px", padding: "10px 12px", border: "1px solid var(--color-border)", borderRadius: "8px" }}>
            <input type="checkbox" checked={respin} onChange={e => setRespin(e.target.checked)} style={{ marginTop: "2px" }} />
            <span style={{ flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{t("publishRespin")}</span>
              <span style={{ display: "block", fontSize: "11px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>{t("publishRespinHint")}</span>
              {respinCreds && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", fontWeight: 600, marginTop: "6px", padding: "2px 8px", borderRadius: "20px", background: respinCreds.hasKey ? "rgba(52,199,89,0.12)" : "rgba(245,158,11,0.12)", color: respinCreds.hasKey ? "var(--color-accent-green)" : "#F59E0B" }}>
                  {respinCreds.label}
                </span>
              )}
            </span>
          </label>

          {error && <div style={{ fontSize: "12px", color: "var(--color-accent-red)", marginTop: "10px" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "16px" }}>
            <button onClick={onClose} style={btnGhost}>{t("seoCancelEdit")}</button>
            <button onClick={send} disabled={!canSend} style={{ ...btnPrimary, opacity: canSend ? 1 : 0.5 }}>
              {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />} {t("publishPublish")}
            </button>
          </div>
        </>)}

        {result && (
          <div>
            {result.posts.map(p => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--color-border)" }}>
                {p.status === "published" ? <CheckCircle2 size={16} color="var(--color-accent-green)" /> : <AlertTriangle size={16} color="var(--color-accent-red)" />}
                <span style={{ flex: 1, minWidth: 0, fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.title}
                  {p.respinUsed && <span style={{ fontSize: "10px", fontWeight: 700, marginLeft: "8px", padding: "2px 7px", borderRadius: "10px", background: "rgba(191,90,242,0.14)", color: "var(--color-accent-purple)" }}>{t("publishRespinUsed")}</span>}
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
export function statusMeta(status: string): { labelKey: string; color: string } {
  switch (status) {
    case "ok": return { labelKey: "publishVerifiedOk", color: "var(--color-accent-green)" };
    case "error": return { labelKey: "publishVerifyFailed", color: "var(--color-accent-red)" };
    case "published": return { labelKey: "publishStatusPublished", color: "var(--color-accent-green)" };
    case "publishing": return { labelKey: "publishStatusPublishing", color: "var(--color-accent-blue)" };
    case "failed": return { labelKey: "publishStatusFailed", color: "var(--color-accent-red)" };
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
