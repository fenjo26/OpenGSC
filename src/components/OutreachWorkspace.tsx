"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, Check, Clipboard, ExternalLink, Link2, Loader2, Mail, Plus, RefreshCw, Save, Target, Trash2, UserRound } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { outreachErrorKey, OUTREACH_STAGES } from "@/lib/outreach/types";

type Mode = "prospects" | "campaigns";

interface Props {
  mode: Mode;
  refreshToken?: number;
  onError?: (message: string) => void;
}

const input = "tool-input";
const ghost: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, border: "none", background: "var(--color-accent-purple)", color: "#fff" };

const stageKey: Record<string, string> = Object.fromEntries(OUTREACH_STAGES.map(stage => [stage, `outreachStage${stage[0].toUpperCase()}${stage.slice(1)}`]));
const stageColor: Record<string, string> = {
  discovered: "#8e8e93", qualified: "#5ac8fa", ready: "#007aff", contacted: "#af52de",
  replied: "#ff9f0a", negotiating: "#ff6b35", won: "#34c759", lost: "#ff375f",
};

function localDateInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function backlinkState(backlink: any): string {
  if (!backlink) return "unknown";
  if (["alive", "dead", "blocked"].includes(backlink.aliveStatus)) return backlink.aliveStatus;
  return backlink.isAlive === true ? "alive" : backlink.isAlive === false ? "dead" : "unknown";
}

export default function OutreachWorkspace({ mode, refreshToken = 0, onError }: Props) {
  const { t, language } = useLanguage() as any;
  const [data, setData] = useState<any>({ campaigns: [], prospects: [], backlinks: [], stats: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notMigrated, setNotMigrated] = useState(false);
  const [filterStage, setFilterStage] = useState("");
  const [filterCampaign, setFilterCampaign] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [manualDomain, setManualDomain] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignAsset, setCampaignAsset] = useState("");
  const [campaignNotes, setCampaignNotes] = useState("");

  const fail = (message: unknown) => onError?.(t(outreachErrorKey(message)));

  async function reload() {
    setLoading(true);
    try {
      const response = await fetch("/api/outreach", { cache: "no-store" });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || "outreach_error");
      setData(next);
      setNotMigrated(next.notMigrated === true);
      if (selected) {
        const fresh = (next.prospects || []).find((prospect: any) => prospect.id === selected.id);
        if (fresh) setSelected({ ...fresh, nextFollowUpAt: localDateInput(fresh.nextFollowUpAt), lastContactAt: localDateInput(fresh.lastContactAt) });
      }
    } catch (error: any) { fail(error?.message); }
    setLoading(false);
  }

  useEffect(() => { void reload(); }, [refreshToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => (data.prospects || []).filter((prospect: any) =>
    (!filterStage || prospect.stage === filterStage) && (!filterCampaign || prospect.campaignId === filterCampaign),
  ), [data.prospects, filterStage, filterCampaign]);

  const pitch = useMemo(() => {
    if (!selected) return "";
    return String(t("outreachPitchTemplate"))
      .replaceAll("{name}", selected.contactName || t("outreachPitchFallbackName"))
      .replaceAll("{domain}", selected.domain || "")
      .replaceAll("{source}", selected.sourceTitle || selected.sourceUrl || selected.domain || "")
      .replaceAll("{brand}", selected.sourceBrand || t("outreachPitchTheirReference"))
      .replaceAll("{asset}", selected.targetAsset || selected.campaign?.targetAsset || t("outreachPitchOurAsset"))
      .replaceAll("{angle}", selected.pitchAngle || t("outreachPitchFallbackAngle"));
  }, [selected, t]);

  async function createManualProspect() {
    if (!manualDomain.trim() && !manualUrl.trim()) return;
    setSaving(true);
    try {
      const response = await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: manualDomain, sourceUrl: manualUrl, campaignId: filterCampaign || null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "outreach_error");
      setManualDomain(""); setManualUrl("");
      await reload();
    } catch (error: any) { fail(error?.message); }
    setSaving(false);
  }

  async function createCampaign() {
    if (!campaignName.trim()) return;
    setSaving(true);
    try {
      const response = await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "campaign", name: campaignName, targetAsset: campaignAsset, notes: campaignNotes }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "outreach_error");
      setCampaignName(""); setCampaignAsset(""); setCampaignNotes("");
      await reload();
    } catch (error: any) { fail(error?.message); }
    setSaving(false);
  }

  async function patchProspect(id: string, changes: Record<string, unknown>, keepEditor = false) {
    setSaving(true);
    try {
      const response = await fetch(`/api/outreach/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "outreach_error");
      if (!keepEditor) setSelected(null);
      await reload();
    } catch (error: any) { fail(error?.message); }
    setSaving(false);
  }

  async function saveSelected() {
    if (!selected) return;
    await patchProspect(selected.id, {
      stage: selected.stage,
      campaignId: selected.campaignId || null,
      contactName: selected.contactName,
      contactEmail: selected.contactEmail,
      contactUrl: selected.contactUrl,
      contactSource: selected.contactSource,
      pitchAngle: selected.pitchAngle,
      targetAsset: selected.targetAsset,
      notes: selected.notes,
      nextFollowUpAt: selected.nextFollowUpAt ? new Date(selected.nextFollowUpAt).toISOString() : null,
      lastContactAt: selected.lastContactAt ? new Date(selected.lastContactAt).toISOString() : null,
      backlinkId: selected.backlinkId || null,
      wonBacklinkUrl: selected.wonBacklinkUrl,
    }, true);
  }

  async function deleteProspect(id: string) {
    if (!window.confirm(t("outreachDeleteConfirm"))) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/outreach/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error || "outreach_error");
      setSelected(null);
      await reload();
    } catch (error: any) { fail(error?.message); }
    setSaving(false);
  }

  async function toggleCampaign(campaign: any) {
    try {
      const response = await fetch(`/api/outreach/campaigns/${encodeURIComponent(campaign.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: campaign.status === "active" ? "archived" : "active" }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "outreach_error");
      await reload();
    } catch (error: any) { fail(error?.message); }
  }

  async function copyPitch() {
    try {
      await navigator.clipboard.writeText(pitch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { fail("clipboard_error"); }
  }

  async function verifyBacklink(prospect: any) {
    if (!prospect.backlink?.id || !prospect.backlink?.siteId) return;
    setSaving(true);
    try {
      const response = await fetch("/api/backlinks/check-alive", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteDbId: prospect.backlink.siteId, ids: [prospect.backlink.id] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "outreach_error");
      await reload();
    } catch (error: any) { fail(error?.message); }
    setSaving(false);
  }

  if (loading) return <div className="panel" style={{ padding: "36px", textAlign: "center" }}><Loader2 size={18} className="spin" /></div>;
  if (notMigrated) return <div className="panel" style={{ color: "var(--color-accent-orange)", fontSize: "13px" }}>{t("outreachMigrationRequired")}</div>;

  if (mode === "campaigns") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div className="panel" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "8px", alignItems: "start" }}>
          <input className={input} value={campaignName} onChange={e => setCampaignName(e.target.value)} placeholder={t("outreachCampaignNamePh")} />
          <input className={input} value={campaignAsset} onChange={e => setCampaignAsset(e.target.value)} placeholder={t("outreachTargetAssetPh")} />
          <input className={input} value={campaignNotes} onChange={e => setCampaignNotes(e.target.value)} placeholder={t("outreachCampaignNotesPh")} />
          <button onClick={createCampaign} disabled={saving || !campaignName.trim()} style={{ ...primary, opacity: saving || !campaignName.trim() ? 0.55 : 1, minHeight: "38px" }}><Plus size={13} /> {t("outreachCampaignCreate")}</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: "10px" }}>
          {(data.campaigns || []).map((campaign: any) => (
            <div key={campaign.id} className="panel" style={{ display: "flex", flexDirection: "column", gap: "9px", opacity: campaign.status === "archived" ? 0.68 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Target size={15} color="var(--color-accent-purple)" />
                <strong style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>{campaign.name}</strong>
                <span style={{ marginLeft: "auto", fontSize: "10px", color: campaign.status === "active" ? "#34c759" : "var(--color-text-tertiary)" }}>{t(campaign.status === "active" ? "outreachCampaignActive" : "outreachCampaignArchived")}</span>
              </div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", minHeight: "18px" }}>{campaign.targetAsset || t("outreachNoTargetAsset")}</div>
              <div style={{ display: "flex", gap: "14px", fontSize: "11px", color: "var(--color-text-secondary)" }}>
                <span>{t("outreachProspects")}: <b>{campaign.total}</b></span>
                <span>{t("outreachWon")}: <b style={{ color: "#34c759" }}>{campaign.won}</b></span>
              </div>
              {campaign.notes && <div className="privacy-blur-all" style={{ fontSize: "11px", color: "var(--color-text-tertiary)", whiteSpace: "pre-wrap" }}>{campaign.notes}</div>}
              <button onClick={() => toggleCampaign(campaign)} style={{ ...ghost, alignSelf: "flex-start" }}><Archive size={12} /> {t(campaign.status === "active" ? "outreachArchive" : "outreachRestore")}</button>
            </div>
          ))}
          {!data.campaigns?.length && <div className="panel" style={{ color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("outreachNoCampaigns")}</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {data.stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: "8px" }}>
          {[["total", "outreachTotal", "var(--color-text-primary)"], ["open", "outreachOpen", "#007aff"], ["due", "outreachDue", "#ff9f0a"], ["won", "outreachWon", "#34c759"], ["conversionPercent", "outreachConversion", "#af52de"]].map(([field, key, color]) => (
            <div key={field} className="panel" style={{ textAlign: "center", padding: "12px" }}>
              <div style={{ fontSize: "23px", fontWeight: 800, color }}>{data.stats[field]}{field === "conversionPercent" ? "%" : ""}</div>
              <div style={{ fontSize: "10px", color: "var(--color-text-secondary)" }}>{t(key)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="panel" style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <select className={input} value={filterStage} onChange={e => setFilterStage(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("outreachAllStages")}</option>
          {OUTREACH_STAGES.map(stage => <option key={stage} value={stage}>{t(stageKey[stage])}</option>)}
        </select>
        <select className={input} value={filterCampaign} onChange={e => setFilterCampaign(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("outreachAllCampaigns")}</option>
          {(data.campaigns || []).map((campaign: any) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <input className={input} value={manualDomain} onChange={e => setManualDomain(e.target.value)} placeholder={t("outreachDomainPh")} style={{ width: "180px" }} />
        <input className={input} value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder={t("outreachSourceUrlPh")} style={{ minWidth: "220px", flex: "0.7" }} />
        <button onClick={createManualProspect} disabled={saving || (!manualDomain.trim() && !manualUrl.trim())} style={{ ...primary, opacity: saving ? 0.55 : 1 }}><Plus size={13} /> {t("outreachAddProspect")}</button>
      </div>

      <div className="panel" style={{ padding: 0, overflowX: "auto" }}>
        <table className="privacy-sensitive" style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
          <thead><tr style={{ textAlign: "left", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" }}>
            <th style={{ padding: "10px 12px" }}>{t("outreachDomain")}</th>
            <th style={{ padding: "10px 8px" }}>{t("outreachStage")}</th>
            <th style={{ padding: "10px 8px" }}>{t("outreachEvidence")}</th>
            <th style={{ padding: "10px 8px" }}>{t("outreachContact")}</th>
            <th style={{ padding: "10px 8px" }}>{t("outreachFollowUp")}</th>
            <th style={{ padding: "10px 8px" }}>{t("outreachWonLink")}</th>
            <th style={{ padding: "10px 12px" }} />
          </tr></thead>
          <tbody>
            {filtered.map((prospect: any) => {
              const due = prospect.nextFollowUpAt && new Date(prospect.nextFollowUpAt).getTime() <= Date.now() && !["won", "lost"].includes(prospect.stage);
              const alive = backlinkState(prospect.backlink);
              return (
                <tr key={prospect.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "9px 12px", fontWeight: 700, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>{prospect.domain}<div style={{ fontSize: "10px", fontWeight: 400, color: "var(--color-text-tertiary)" }}>DR {Math.round(prospect.sourceDr || 0)}</div></td>
                  <td style={{ padding: "9px 8px" }}><select value={prospect.stage} onChange={e => patchProspect(prospect.id, { stage: e.target.value })} style={{ padding: "5px 7px", borderRadius: "7px", border: `1px solid ${stageColor[prospect.stage]}55`, background: `${stageColor[prospect.stage]}15`, color: stageColor[prospect.stage], fontSize: "11px", fontWeight: 700 }}>{OUTREACH_STAGES.map(stage => <option key={stage} value={stage}>{t(stageKey[stage])}</option>)}</select></td>
                  <td style={{ padding: "9px 8px", maxWidth: "270px" }}>{prospect.sourceUrl ? <a href={prospect.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prospect.sourceTitle || prospect.sourceUrl} <ExternalLink size={9} /></a> : <span style={{ color: "var(--color-text-tertiary)" }}>—</span>}<div style={{ fontSize: "10px", color: "var(--color-text-tertiary)" }}>{prospect.sourceBrand || ""}</div></td>
                  <td style={{ padding: "9px 8px", color: prospect.contactEmail || prospect.contactUrl ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>{prospect.contactName || prospect.contactEmail || prospect.contactUrl || t("outreachNoContact")}</td>
                  <td style={{ padding: "9px 8px", color: due ? "#ff9f0a" : "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{prospect.nextFollowUpAt ? new Date(prospect.nextFollowUpAt).toLocaleString(language) : "—"}</td>
                  <td style={{ padding: "9px 8px" }}>{prospect.backlink || prospect.wonBacklinkUrl ? <span style={{ color: alive === "alive" ? "#34c759" : alive === "dead" ? "#ff375f" : alive === "blocked" ? "#ff9f0a" : "var(--color-text-secondary)" }}>{t(`outreachLink${alive[0].toUpperCase()}${alive.slice(1)}`)}</span> : "—"}</td>
                  <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}><button onClick={() => setSelected({ ...prospect, nextFollowUpAt: localDateInput(prospect.nextFollowUpAt), lastContactAt: localDateInput(prospect.lastContactAt) })} style={ghost}><UserRound size={12} /> {t("outreachOpenEditor")}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && <div style={{ padding: "30px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("outreachNoProspects")}</div>}
      </div>

      {selected && (
        <div className="panel privacy-blur-all" style={{ display: "flex", flexDirection: "column", gap: "12px", borderColor: "rgba(175,82,222,0.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}><Mail size={16} color="var(--color-accent-purple)" /><strong style={{ color: "var(--color-text-primary)" }}>{selected.domain}</strong><span style={{ flex: 1 }} /><button onClick={() => setSelected(null)} style={ghost}>{t("close")}</button></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: "8px" }}>
            <select className={input} value={selected.stage} onChange={e => setSelected({ ...selected, stage: e.target.value })}>{OUTREACH_STAGES.map(stage => <option key={stage} value={stage}>{t(stageKey[stage])}</option>)}</select>
            <select className={input} value={selected.campaignId || ""} onChange={e => setSelected({ ...selected, campaignId: e.target.value })}><option value="">{t("outreachNoCampaign")}</option>{(data.campaigns || []).filter((campaign: any) => campaign.status === "active" || campaign.id === selected.campaignId).map((campaign: any) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select>
            <input className={input} value={selected.contactName || ""} onChange={e => setSelected({ ...selected, contactName: e.target.value })} placeholder={t("outreachContactNamePh")} />
            <input className={input} value={selected.contactEmail || ""} onChange={e => setSelected({ ...selected, contactEmail: e.target.value })} placeholder={t("outreachContactEmailPh")} />
            <input className={input} value={selected.contactUrl || ""} onChange={e => setSelected({ ...selected, contactUrl: e.target.value })} placeholder={t("outreachContactUrlPh")} />
            <input className={input} value={selected.contactSource || ""} onChange={e => setSelected({ ...selected, contactSource: e.target.value })} placeholder={t("outreachContactSourcePh")} />
            <input className={input} value={selected.targetAsset || ""} onChange={e => setSelected({ ...selected, targetAsset: e.target.value })} placeholder={t("outreachTargetAssetPh")} />
            <input className={input} type="datetime-local" value={selected.nextFollowUpAt || ""} onChange={e => setSelected({ ...selected, nextFollowUpAt: e.target.value })} title={t("outreachFollowUp")} />
            <select className={input} value={selected.backlinkId || ""} onChange={e => setSelected({ ...selected, backlinkId: e.target.value })}><option value="">{t("outreachNoBacklink")}</option>{(data.backlinks || []).map((backlink: any) => <option key={backlink.id} value={backlink.id}>{backlink.url}</option>)}</select>
            <input className={input} value={selected.wonBacklinkUrl || ""} onChange={e => setSelected({ ...selected, wonBacklinkUrl: e.target.value })} placeholder={t("outreachWonUrlPh")} />
          </div>
          <textarea className={input} value={selected.pitchAngle || ""} onChange={e => setSelected({ ...selected, pitchAngle: e.target.value })} placeholder={t("outreachPitchAnglePh")} style={{ minHeight: "64px", resize: "vertical" }} />
          <textarea className={input} value={selected.notes || ""} onChange={e => setSelected({ ...selected, notes: e.target.value })} placeholder={t("outreachNotesPh")} style={{ minHeight: "70px", resize: "vertical" }} />
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "8px", alignItems: "start" }}>
            <textarea className={input} readOnly value={pitch} style={{ minHeight: "120px", resize: "vertical", lineHeight: 1.5 }} />
            <button onClick={copyPitch} style={ghost}>{copied ? <Check size={13} /> : <Clipboard size={13} />} {t(copied ? "outreachCopied" : "outreachCopyPitch")}</button>
          </div>
          <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("outreachNoAutoSend")}</div>
          {selected.events?.length > 0 && <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>{selected.events.slice(0, 8).map((event: any) => <span key={event.id} style={{ fontSize: "10px", color: "var(--color-text-secondary)", padding: "3px 7px", borderRadius: "6px", background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>{event.fromStage ? `${t(stageKey[event.fromStage])} → ` : ""}{t(stageKey[event.toStage])} · {new Date(event.createdAt).toLocaleString(language)}</span>)}</div>}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button onClick={saveSelected} disabled={saving} style={primary}>{saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} {t("outreachSave")}</button>
            {selected.backlink && <button onClick={() => verifyBacklink(selected)} disabled={saving} style={ghost}><RefreshCw size={13} /> {t("outreachVerifyLink")}</button>}
            {selected.backlink?.url && <a href={selected.backlink.url} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: "none" }}><Link2 size={13} /> {t("outreachOpenLink")}</a>}
            <button onClick={() => deleteProspect(selected.id)} disabled={saving} style={{ ...ghost, marginLeft: "auto", color: "#ff375f" }}><Trash2 size={13} /> {t("outreachDelete")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
