"use client";

// The chain view for cross-site moves (src/lib/siteMoves): A → B → C as one brand.
//
// Opened from a toolbar button on the site dashboard and laid over the page, so a site with a
// chain and a site without one keep identical dashboard geometry. Shows the stitched traffic
// (stacked by domain — the top edge is the brand's total), each move with how fast the new domain
// caught up, suggestions the detector found, and the form to link a move.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { X, Trash2, ArrowRight } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

type Recovery = { baseline: number; daysTo50: number | null; daysTo80: number | null; nowPct: number | null; daysObserved: number };
type Move = {
  id: string; fromSiteId: string; toSiteId: string; date: string; reason: string; redirect301: boolean; note: string | null;
  fromUrl: string; toUrl: string; recovery: Recovery;
};
type Suggestion = { fromSiteId: string; toSiteId: string; date: string | null; evidence: string; fromUrl?: string; toUrl?: string };
type Data = {
  needsDbPush?: boolean;
  chain?: { id: string; url: string }[];
  moves?: Move[];
  series?: Record<string, number | string>[];
  suggestions?: Suggestion[];
  userSites?: { id: string; url: string }[];
};

const REASONS = ["block_regulator", "block_isp", "google_penalty", "rebrand", "other"] as const;
const PALETTE = ["#94A3B8", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EF4444", "#0EA5E9"];
const host = (u: string) => u.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const ERR_KEYS: Record<string, string> = {
  has_outgoing: "chainErrHasOutgoing", has_incoming: "chainErrHasIncoming", cycle: "chainErrCycle",
  same_site: "chainErrSameSite", needs_db_push: "annErrNeedsDbPush", bad_date: "chainErrBadDate",
};

export default function SiteChainModal({ siteId, onClose, onChanged }: { siteId: string; onClose: () => void; onChanged?: () => void }) {
  const { t } = useLanguage();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const n = new Date();
  const todayIso = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  const [direction, setDirection] = useState<"to" | "from">("to");
  const [other, setOther] = useState("");
  const [date, setDate] = useState(todayIso);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("block_regulator");
  const [r301, setR301] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // No setLoading(true) here: the first load starts with loading=true, and a reload after a save
  // keeps the current view on screen instead of flashing an empty one.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/site-moves?siteId=${encodeURIComponent(siteId)}`, { cache: "no-store" });
      setData(res.ok ? await res.json() : null);
    } catch { setData(null); }
    setLoading(false);
  }, [siteId]);
  useEffect(() => { load(); }, [load]);

  const chain = useMemo(() => data?.chain ?? [], [data]);
  const moves = useMemo(() => data?.moves ?? [], [data]);
  const colorOf = useMemo(() => new Map(chain.map((s, i) => [s.id, PALETTE[i % PALETTE.length]])), [chain]);
  const candidates = (data?.userSites ?? []).filter(s => s.id !== siteId);

  const save = async (body: Record<string, unknown>) => {
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/site-moves", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        setError(typeof d?.error === "string" ? d.error : "save_failed");
      } else {
        setOther(""); setNote("");
        await load(); onChanged?.();
      }
    } catch { setError("save_failed"); }
    setSaving(false);
  };

  const submit = () => {
    if (!other || saving) return;
    save({
      fromSiteId: direction === "to" ? siteId : other,
      toSiteId: direction === "to" ? other : siteId,
      date, reason, redirect301: r301, note,
    });
  };

  const remove = async (id: string) => {
    if (!confirm(t("chainDeleteConfirm"))) return;
    await fetch(`/api/site-moves?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    await load(); onChanged?.();
  };

  const days = (v: number | null) => v == null ? "—" : t("chainDays").replace("{n}", String(v));
  const field: React.CSSProperties = { padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "13px" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "var(--color-card)", color: "var(--color-text-primary)", borderRadius: "14px", width: "92%", maxWidth: "860px", maxHeight: "90vh", overflowY: "auto", padding: "22px 26px", position: "relative", border: "1px solid var(--color-border)" }}>
        <button onClick={onClose} style={{ position: "absolute", top: "14px", right: "14px", background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)" }}><X size={18} /></button>
        <h3 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 700 }}>{t("chainTitle")}</h3>
        <p style={{ margin: "0 0 16px", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.45 }}>{t("chainIntro")}</p>

        {loading && !data && <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>…</p>}
        {data?.needsDbPush && (
          <div style={{ padding: "10px 12px", borderRadius: "8px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", fontSize: "13px", marginBottom: "14px" }}>{t("annErrNeedsDbPush")}</div>
        )}

        {/* The chain itself */}
        {chain.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginBottom: "14px" }}>
            {chain.map((s, i) => (
              <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                {i > 0 && <ArrowRight size={13} color="var(--color-text-secondary)" />}
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 9px", borderRadius: "999px", border: `1px solid ${s.id === siteId ? colorOf.get(s.id) : "var(--color-border)"}`, fontSize: "12px", fontWeight: s.id === siteId ? 700 : 500 }}>
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: colorOf.get(s.id) }} />
                  {host(s.url)}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Stitched traffic, stacked by domain */}
        {moves.length > 0 && (data?.series?.length ?? 0) > 0 && (
          <div style={{ height: 220, marginBottom: "14px" }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data!.series} margin={{ top: 8, right: 6, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} minTickGap={36} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "var(--color-text-secondary)" }} axisLine={false} tickLine={false} width={40} />
                <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "8px", fontSize: "12px" }}
                  formatter={(v, k) => [String(v ?? 0), host(chain.find(c => c.id === String(k))?.url ?? String(k))]} />
                {chain.map(s => (
                  <Area key={s.id} type="monotone" dataKey={s.id} stackId="brand" stroke={colorOf.get(s.id)} fill={colorOf.get(s.id)} fillOpacity={0.35} strokeWidth={1.2} dot={false} isAnimationActive={false} />
                ))}
                {moves.map(m => (
                  <ReferenceLine key={m.id} x={m.date} stroke="#B91C1C" strokeDasharray="4 3" strokeWidth={1.2} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Moves with recovery */}
        {moves.map(m => (
          <div key={m.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 18px", padding: "10px 0", borderTop: "1px solid var(--color-border)", fontSize: "12px" }}>
            <div style={{ minWidth: "220px", flex: "1 1 220px" }}>
              <div style={{ fontWeight: 700, fontSize: "13px" }}>{host(m.fromUrl)} → {host(m.toUrl)}</div>
              <div style={{ color: "var(--color-text-secondary)", marginTop: "2px" }}>
                {m.date} · {t(`chainReason_${m.reason}` as never)}{m.redirect301 ? " · 301" : ""}{m.note ? ` · ${m.note}` : ""}
              </div>
            </div>
            <div title={t("chainBaselineHint")}><span style={{ color: "var(--color-text-secondary)" }}>{t("chainBaseline")}</span> <b>{m.recovery.baseline}</b>/{t("chainPerDay")}</div>
            <div><span style={{ color: "var(--color-text-secondary)" }}>50%:</span> <b>{days(m.recovery.daysTo50)}</b></div>
            <div><span style={{ color: "var(--color-text-secondary)" }}>80%:</span> <b>{days(m.recovery.daysTo80)}</b></div>
            <div><span style={{ color: "var(--color-text-secondary)" }}>{t("chainNow")}</span> <b>{m.recovery.nowPct == null ? "—" : `${m.recovery.nowPct}%`}</b></div>
            <button title={t("annDeleteNote")} onClick={() => remove(m.id)}
              style={{ width: "28px", height: "28px", borderRadius: "8px", border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.06)", color: "#EF4444", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}

        {/* Detector suggestions */}
        {(data?.suggestions ?? []).length > 0 && (
          <div style={{ marginTop: "12px", padding: "10px 12px", borderRadius: "8px", border: "1px solid rgba(59,130,246,0.3)", background: "rgba(59,130,246,0.06)" }}>
            <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}>{t("chainSuggestions")}</div>
            {data!.suggestions!.map(s => (
              <div key={`${s.fromSiteId}-${s.toSiteId}`} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "12px", padding: "3px 0" }}>
                <span>{host(s.fromUrl ?? "")} → {host(s.toUrl ?? "")}{s.date ? ` · ${s.date}` : ""} · {t(s.evidence === "redirect" ? "chainEvidenceRedirect" : "chainEvidenceTraffic")}</span>
                {/* With a date the suggestion links in one click; a redirect alone does not say when,
                    so it fills the form below and leaves the date to the operator. */}
                <button disabled={saving} onClick={() => {
                  if (s.date) { save({ fromSiteId: s.fromSiteId, toSiteId: s.toSiteId, date: s.date, reason: "other", redirect301: s.evidence === "redirect" }); return; }
                  setDirection(s.fromSiteId === siteId ? "to" : "from");
                  setOther(s.fromSiteId === siteId ? s.toSiteId : s.fromSiteId);
                  setR301(s.evidence === "redirect");
                }}
                  style={{ marginLeft: "auto", padding: "4px 10px", borderRadius: "6px", border: "1px solid var(--color-accent-blue)", background: "transparent", color: "var(--color-accent-blue)", fontSize: "12px", cursor: "pointer" }}>
                  {t("chainLink")}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Link a move */}
        {!data?.needsDbPush && (
          <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid var(--color-border)" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px" }}>{t("chainAdd")}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
              <select value={direction} onChange={e => setDirection(e.target.value as "to" | "from")} style={field}>
                <option value="to">{t("chainDirTo")}</option>
                <option value="from">{t("chainDirFrom")}</option>
              </select>
              <select value={other} onChange={e => setOther(e.target.value)} style={{ ...field, minWidth: "200px" }}>
                <option value="">{t("chainPickSite")}</option>
                {candidates.map(s => <option key={s.id} value={s.id}>{host(s.url)}</option>)}
              </select>
              <input type="date" value={date} max={todayIso} onChange={e => setDate(e.target.value)} style={field} />
              <select value={reason} onChange={e => setReason(e.target.value as (typeof REASONS)[number])} style={field}>
                {REASONS.map(r => <option key={r} value={r}>{t(`chainReason_${r}` as never)}</option>)}
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
                <input type="checkbox" checked={r301} onChange={e => setR301(e.target.checked)} /> 301
              </label>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder={t("chainNotePlaceholder")} style={{ ...field, flex: "1 1 160px" }} />
              <button disabled={!other || saving} onClick={submit}
                style={{ padding: "7px 14px", borderRadius: "8px", border: "none", background: other ? "#3B82F6" : "#9ca3af", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: other && !saving ? "pointer" : "not-allowed" }}>
                {t("annSave")}
              </button>
            </div>
            {error && <div style={{ marginTop: "8px", fontSize: "12px", color: "#EF4444" }}>{t((ERR_KEYS[error] ?? "annSaveFailed") as never)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
