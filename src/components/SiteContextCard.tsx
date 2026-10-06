"use client";

import { useCallback, useEffect, useState } from "react";
import { BrainCircuit, Plus, Save, Trash2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

// The Context card (Project Memory): everything the AI surfaces believe about this site —
// sections, competitors, key pages, research log — in one place the operator can inspect and
// correct. Reads and writes go through /api/site-context, which is the same store the MCP
// tools (get_site_context / update_site_context) use, so an edit here is what the agent sees
// next time, and an agent's write-back is what this card shows (rows carry provenance).

interface Section { key: string; title: string; content: string; updatedBy: string; updatedAt: string; }
interface Competitor { name: string; domain: string; terms: string[]; notes?: string; }
interface KeyPage { id: string; url: string; role: string; topic: string; notes: string; updatedBy: string; updatedAt: string; }
interface LogEntry { id: string; entryDate: string; summary: string; createdBy: string; }
interface SuggestedKeyPage { url: string; role: string; clicks: number; impressions: number; }
interface SuggestedCompetitor { domain: string; keywords: number; }
interface Context {
  sections: Section[]; missingSections: string[]; competitors: Competitor[];
  keyPages: KeyPage[]; researchLog: LogEntry[];
  bootstrap?: { suggestedKeyPages: SuggestedKeyPage[]; suggestedCompetitors: SuggestedCompetitor[]; sitemapUrls: number };
}

type SectionLabelKey = "scxSectionBusiness" | "scxSectionGoal" | "scxSectionPositioning" | "scxSectionWriting";
const TYPED: Array<{ key: string; label: SectionLabelKey }> = [
  { key: "business_overview", label: "scxSectionBusiness" },
  { key: "current_goal", label: "scxSectionGoal" },
  { key: "positioning", label: "scxSectionPositioning" },
  { key: "writing_preferences", label: "scxSectionWriting" },
];
type RoleKey = "scxRoleMoney" | "scxRoleHub" | "scxRoleSpoke" | "scxRoleOther";
const ROLES: RoleKey[] = ["scxRoleMoney", "scxRoleHub", "scxRoleSpoke", "scxRoleOther"];
const ROLE_VALUE: Record<RoleKey, string> = { scxRoleMoney: "money", scxRoleHub: "hub", scxRoleSpoke: "spoke", scxRoleOther: "other" };
const ROLE_OF: Record<string, RoleKey> = { money: "scxRoleMoney", hub: "scxRoleHub", spoke: "scxRoleSpoke", other: "scxRoleOther" };

const inputStyle = (flex = 1): React.CSSProperties => ({
  flex, minWidth: 0, padding: "6px 10px", borderRadius: "6px", border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none",
});
const miniBtn: React.CSSProperties = {
  width: "26px", height: "26px", borderRadius: "7px", border: "1px solid var(--color-border)",
  background: "none", color: "var(--color-text-secondary)", cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0,
};
const th: React.CSSProperties = { textAlign: "left", fontSize: "10px", fontWeight: 600, color: "var(--color-text-tertiary)", padding: "4px 8px", textTransform: "uppercase", letterSpacing: "0.04em" };
const td: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)", padding: "4px 8px", verticalAlign: "top" };

function By({ who }: { who: string }) {
  if (who !== "mcp") return null;
  return (
    <span title="AI" style={{ fontSize: "9px", fontWeight: 700, padding: "1px 6px", borderRadius: "8px", color: "#8B5CF6", background: "rgba(139,92,246,0.12)", marginLeft: "6px" }}>
      AI
    </span>
  );
}

export default function SiteContextCard({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const [ctx, setCtx] = useState<Context | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [addComp, setAddComp] = useState({ name: "", domain: "", notes: "" });
  const [addPage, setAddPage] = useState({ url: "", role: "other", topic: "" });
  const [customTitle, setCustomTitle] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/site-context?siteId=${encodeURIComponent(siteDbId)}`);
      if (!r.ok) { setCtx(null); return; }
      const d: Context = await r.json();
      setCtx(d);
      setDrafts(Object.fromEntries(d.sections.map(s => [s.key, s.content])));
    } catch { setCtx(null); }
  }, [siteDbId]);
  useEffect(() => { load(); }, [load]);

  const send = async (updates: unknown[]) => {
    setSaving(true);
    try {
      await fetch("/api/site-context", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, updates }),
      });
      await load();
    } finally { setSaving(false); }
  };

  const cardStyle: React.CSSProperties = { background: "var(--color-card)", borderRadius: "12px", border: "1px solid var(--color-border)", padding: "24px" };

  return (
    <div id="context" style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
        <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: "rgba(139,92,246,0.1)", display: "flex", alignItems: "center", justifyContent: "center", color: "#8B5CF6" }}>
          <BrainCircuit size={18} />
        </div>
        <div>
          <h3 style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{t("scxTitle")}</h3>
          <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "2px 0 0" }}>{t("scxDesc")}</p>
        </div>
      </div>

      {ctx && ctx.missingSections.length > 0 && (
        <div style={{ margin: "10px 0 4px", fontSize: "11.5px", color: "#F59E0B" }}>
          {t("scxMissing")}: {ctx.missingSections
            .map(k => TYPED.find(x => x.key === k))
            .filter((x): x is { key: string; label: SectionLabelKey } => !!x)
            .map(x => t(x.label)).join(", ")}
        </div>
      )}

      {/* Bootstrap proposals on an empty context: the site's own top GSC pages and stored
          competitor scans, offered as one-click adds. Proposals, not writes — they land only
          when confirmed here or by the agent through update_site_context. */}
      {ctx?.bootstrap && (ctx.bootstrap.suggestedKeyPages.length > 0 || ctx.bootstrap.suggestedCompetitors.length > 0) && (
        <div style={{ marginTop: "12px", padding: "12px 14px", borderRadius: "10px", border: "1px dashed var(--color-border)", background: "var(--color-bg)" }}>
          <div style={{ fontSize: "11.5px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "2px" }}>{t("scxSuggestTitle")}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("scxSuggestNote")}</div>
          {ctx.bootstrap.suggestedKeyPages.length > 0 && (
            <>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", margin: "6px 0 4px" }}>{t("scxSuggestPages")}:</div>
              {ctx.bootstrap.suggestedKeyPages.map(p => (
                <div key={p.url} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", fontSize: "11.5px" }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "monospace", color: "var(--color-text-primary)" }} title={p.url}>{p.url}</span>
                  <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>{p.clicks.toLocaleString()} clicks</span>
                  <button onClick={() => send([{ addKeyPages: [{ url: p.url, role: p.role }] }])} disabled={saving}
                    title={t("scxSuggestAdd")} style={{ ...miniBtn, borderColor: "rgba(16,185,129,0.4)", color: "#10B981" }}><Plus size={12} /></button>
                </div>
              ))}
            </>
          )}
          {ctx.bootstrap.suggestedCompetitors.length > 0 && (
            <>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", margin: "8px 0 4px" }}>{t("scxSuggestComps")}:</div>
              {ctx.bootstrap.suggestedCompetitors.map(c => (
                <div key={c.domain} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", fontSize: "11.5px" }}>
                  <span style={{ flex: 1, fontFamily: "monospace", color: "var(--color-text-primary)" }}>{c.domain}</span>
                  <span style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>{c.keywords.toLocaleString()} kw</span>
                  <button onClick={() => send([{ addCompetitors: [{ name: c.domain, domain: c.domain }] }])} disabled={saving}
                    title={t("scxSuggestAdd")} style={{ ...miniBtn, borderColor: "rgba(16,185,129,0.4)", color: "#10B981" }}><Plus size={12} /></button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Typed sections */}
      {TYPED.map(({ key, label }) => {
        const s = ctx?.sections.find(x => x.key === key);
        const dirty = (drafts[key] ?? "") !== (s?.content ?? "");
        return (
          <div key={key} style={{ marginTop: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t(label)}</span>
              {s && <By who={s.updatedBy} />}
              {dirty && (
                <button onClick={() => send([{ section: key, content: drafts[key] ?? "" }])} disabled={saving}
                  style={{ ...miniBtn, width: "auto", padding: "0 10px", gap: "5px", fontSize: "11px", fontWeight: 600, color: "#10B981", borderColor: "rgba(16,185,129,0.4)" }}>
                  <Save size={11} /> {t("scxSave")}
                </button>
              )}
            </div>
            <textarea
              value={drafts[key] ?? ""}
              onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
              rows={3}
              placeholder={t("scxPlaceholder")}
              style={{ ...inputStyle(), width: "100%", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
            />
          </div>
        );
      })}

      {/* Custom sections */}
      {ctx?.sections.filter(s => s.key.startsWith("custom:")).map(s => (
        <div key={s.key} style={{ marginTop: "14px", borderTop: "1px dashed var(--color-border)", paddingTop: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)" }}>{s.title || s.key}</span>
            <By who={s.updatedBy} />
            <div style={{ flex: 1 }} />
            <button onClick={() => send([{ deleteCustomSection: s.key }])} disabled={saving} title={t("scxRemove")} style={miniBtn}><Trash2 size={12} /></button>
          </div>
          <textarea
            value={drafts[s.key] ?? s.content}
            onChange={e => setDrafts(d => ({ ...d, [s.key]: e.target.value }))}
            onBlur={() => { if ((drafts[s.key] ?? "") !== s.content) send([{ section: s.key, title: s.title, content: drafts[s.key] ?? "" }]); }}
            rows={3}
            style={{ ...inputStyle(), width: "100%", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          />
        </div>
      ))}
      <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
        <input value={customTitle} onChange={e => setCustomTitle(e.target.value)} placeholder={t("scxCustomAdd")} style={inputStyle()} />
        <button
          onClick={() => { if (customTitle.trim()) { send([{ section: `custom:${customTitle.trim()}`, title: customTitle.trim(), content: drafts[`custom:${customTitle.trim()}`] ?? t("scxNewSection") }]); setCustomTitle(""); } }}
          disabled={saving || !customTitle.trim()}
          style={{ ...miniBtn, width: "auto", padding: "0 12px", gap: "5px", fontSize: "11px", fontWeight: 600 }}><Plus size={12} /></button>
      </div>

      {/* Competitors — the same list the AEO tracker and AI share of voice use */}
      <div style={{ marginTop: "22px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{t("scxCompetitors")}</div>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("scxCompetitorsNote")}</div>
        {ctx && ctx.competitors.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
            <thead><tr><th style={th}>{t("scxName")}</th><th style={th}>{t("scxDomain")}</th><th style={th}>{t("scxNotes")}</th><th style={{ ...th, width: "34px" }} /></tr></thead>
            <tbody>
              {ctx.competitors.map((c, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td style={{ ...td, color: "var(--color-text-primary)", fontWeight: 600 }}>{c.name}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{c.domain || "—"}</td>
                  <td style={td}>{c.notes || ""}</td>
                  <td style={td}><button onClick={() => send([{ removeCompetitors: [c.domain || c.name] }])} disabled={saving} title={t("scxRemove")} style={miniBtn}><X size={11} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", gap: "8px" }}>
          <input value={addComp.name} onChange={e => setAddComp(v => ({ ...v, name: e.target.value }))} placeholder={t("scxName")} style={inputStyle()} />
          <input value={addComp.domain} onChange={e => setAddComp(v => ({ ...v, domain: e.target.value }))} placeholder="domain.com" style={inputStyle()} />
          <input value={addComp.notes} onChange={e => setAddComp(v => ({ ...v, notes: e.target.value }))} placeholder={t("scxNotes")} style={inputStyle(1.5)} />
          <button
            onClick={() => { if (addComp.name.trim()) { send([{ addCompetitors: [{ name: addComp.name.trim(), domain: addComp.domain.trim(), notes: addComp.notes.trim() }] }]); setAddComp({ name: "", domain: "", notes: "" }); } }}
            disabled={saving || !addComp.name.trim()}
            style={{ ...miniBtn, width: "auto", padding: "0 12px" }}><Plus size={12} /></button>
        </div>
      </div>

      {/* Key pages */}
      <div style={{ marginTop: "22px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{t("scxKeyPages")}</div>
        {ctx && ctx.keyPages.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "8px" }}>
            <thead><tr><th style={th}>{t("scxUrl")}</th><th style={th}>{t("scxRole")}</th><th style={th}>{t("scxTopic")}</th><th style={{ ...th, width: "34px" }} /></tr></thead>
            <tbody>
              {ctx.keyPages.map(p => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td style={{ ...td, fontFamily: "monospace", color: "var(--color-text-primary)" }}>{p.url}</td>
                  <td style={td}>{t(ROLE_OF[p.role] ?? "scxRoleOther")}</td>
                  <td style={td}>{p.topic}</td>
                  <td style={td}><button onClick={() => send([{ removeKeyPages: [p.url] }])} disabled={saving} title={t("scxRemove")} style={miniBtn}><X size={11} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", gap: "8px" }}>
          <input value={addPage.url} onChange={e => setAddPage(v => ({ ...v, url: e.target.value }))} placeholder="/pricing" style={inputStyle()} />
          <select value={addPage.role} onChange={e => setAddPage(v => ({ ...v, role: e.target.value }))} style={{ ...inputStyle(), flex: "none", width: "110px", cursor: "pointer" }}>
            {ROLES.map(r => <option key={r} value={ROLE_VALUE[r]}>{t(r)}</option>)}
          </select>
          <input value={addPage.topic} onChange={e => setAddPage(v => ({ ...v, topic: e.target.value }))} placeholder={t("scxTopic")} style={inputStyle(1.5)} />
          <button
            onClick={() => { if (addPage.url.trim()) { send([{ addKeyPages: [{ url: addPage.url.trim(), role: addPage.role, topic: addPage.topic.trim() }] }]); setAddPage({ url: "", role: "other", topic: "" }); } }}
            disabled={saving || !addPage.url.trim()}
            style={{ ...miniBtn, width: "auto", padding: "0 12px" }}><Plus size={12} /></button>
        </div>
      </div>

      {/* Research log */}
      <div style={{ marginTop: "22px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{t("scxLog")}</div>
        <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)", marginBottom: "8px" }}>{t("scxLogNote")}</div>
        {ctx?.researchLog.length ? ctx.researchLog.map(e => (
          <div key={e.id} style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "5px 0", borderTop: "1px solid var(--color-border)", fontSize: "11.5px" }}>
            <span style={{ fontFamily: "monospace", color: "var(--color-text-tertiary)", flexShrink: 0 }}>{e.entryDate}</span>
            <span style={{ color: "var(--color-text-secondary)", flex: 1 }}>{e.summary}</span>
            {e.createdBy === "mcp" && <By who={e.createdBy} />}
            <button onClick={() => send([{ removeResearchLog: [e.id] }])} disabled={saving} title={t("scxRemove")} style={{ ...miniBtn, width: "20px", height: "20px" }}><X size={10} /></button>
          </div>
        )) : <div style={{ fontSize: "11.5px", color: "var(--color-text-tertiary)" }}>{t("scxLogEmpty")}</div>}
      </div>
    </div>
  );
}
