"use client";

// N9 — the lead inbox (/leads). Incoming leads from the public audit widget: date, domain,
// e-mail, score, the 3 worst problems, source page, status pipeline (new → contacted →
// won/lost, client), search + filters, CSV export. The card expands into every stored
// finding with evidence, a deterministic first-letter draft (mailto:), "Make client"
// (status → client, then /reports opens), and the proposal editor.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileText, HelpCircle, Inbox, Mail, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { LEAD_STRINGS, t2 } from "@/lib/leads/i18n";
import { generateDraftEmail, mailtoUrl } from "@/lib/leads/proposal";
import { LEAD_STATUSES, type LeadFull, type LeadListItem, type LeadStatus } from "@/lib/leads/types";

interface LeadsResponse {
  leads: LeadListItem[];
  total: number;
  notMigrated?: boolean;
}

const pill: React.CSSProperties = {
  padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: "pointer",
  border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)",
};
const activePill: React.CSSProperties = {
  ...pill, background: "rgba(59,130,246,0.15)", color: "#3B82F6", borderColor: "rgba(59,130,246,0.35)",
};
const smallBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8,
  border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)",
  fontSize: 12, fontWeight: 600, cursor: "pointer",
};
const input: React.CSSProperties = {
  padding: "8px 11px", borderRadius: 8, border: "1px solid var(--color-border)",
  background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: 12, outline: "none", width: "100%",
};

function statusColor(status: LeadStatus | string): string {
  if (status === "new") return "#3B82F6";
  if (status === "contacted") return "#F59E0B";
  if (status === "won" || status === "client") return "#10B981";
  return "var(--color-text-secondary)";
}

export default function LeadsPage() {
  const { t, language } = useLanguage();
  const tr = useCallback((k: string) => t2(language, k), [language]);

  const [leads, setLeads] = useState<LeadListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [notMigrated, setNotMigrated] = useState(false);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [full, setFull] = useState<LeadFull | null>(null);
  const [proposalFor, setProposalFor] = useState<LeadFull | null>(null);
  const [proposalText, setProposalText] = useState("");
  const [includeCodes, setIncludeCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState("");
  // The "what is this tab" explainer + the Orbitra tracker bridge (settings on this page:
  // URL and write API key, instance-wide — see src/lib/leads/orbitra.ts).
  const [showWhat, setShowWhat] = useState(false);
  const [origin, setOrigin] = useState("");
  const [orb, setOrb] = useState<{ configured: boolean; url: string } | null>(null);
  const [orbUrl, setOrbUrl] = useState("");
  const [orbKey, setOrbKey] = useState("");
  const [orbMsg, setOrbMsg] = useState<{ text: string; ok: boolean }>({ text: "", ok: false });
  const [orbBusy, setOrbBusy] = useState(false);
  const [orbLeadBusy, setOrbLeadBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    fetch(`/api/leads?${params.toString()}`)
      .then(res => res.json())
      .then((data: LeadsResponse) => {
        setLeads(data.leads ?? []);
        setTotal(data.total ?? 0);
        setNotMigrated(data.notMigrated === true);
      })
      .catch(() => setLeads([]));
  }, [status, q]);

  useEffect(() => { load(); }, [load]);

  // The explainer's embed snippet shows this instance's real origin; the Orbitra card
  // loads its saved config (the key itself never comes back — only configured + URL).
  useEffect(() => {
    const id = setTimeout(() => {
      setOrigin(window.location.origin);
      void fetch("/api/leads/orbitra").then(r => r.json())
        .then((d: { configured?: boolean; url?: string }) => {
          setOrb({ configured: d?.configured === true, url: d?.url ?? "" });
          if (d?.configured && d.url) setOrbUrl(d.url);
        })
        .catch(() => setOrb({ configured: false, url: "" }));
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const openLead = async (id: string) => {
    if (openId === id) { setOpenId(null); setFull(null); return; }
    setOpenId(id);
    setFull(null);
    const res = await fetch(`/api/leads/${id}`).then(r => r.json()).catch(() => null);
    setFull(res?.lead ?? null);
  };

  const patchLead = async (id: string, patch: { status?: string; proposal?: string }) => {
    setBusy(true);
    try {
      await fetch(`/api/leads/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      load();
    } finally { setBusy(false); }
  };

  const makeClient = async (lead: LeadListItem) => {
    await patchLead(lead.id, { status: "client" });
    window.open("/reports", "_blank");
  };

  const saveOrb = async () => {
    setOrbBusy(true); setOrbMsg({ text: "", ok: false });
    try {
      const r = await fetch("/api/leads/orbitra", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: orbUrl, key: orbKey }),
      });
      const d = await r.json().catch(() => ({}));
      if (d?.ok) { setOrb({ configured: true, url: d.url as string }); setOrbKey(""); setOrbMsg({ text: t("leadOrbSaved" as never), ok: true }); }
      else setOrbMsg({ text: `${t("leadOrbFail" as never)} (${String(d?.error ?? "error")})`, ok: false });
    } finally { setOrbBusy(false); }
  };

  const testOrb = async () => {
    setOrbBusy(true); setOrbMsg({ text: "", ok: false });
    try {
      const r = await fetch("/api/leads/orbitra", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      setOrbMsg(d?.ok ? { text: t("leadOrbTestOk" as never), ok: true } : { text: `${t("leadOrbFail" as never)} (${String(d?.error ?? "error")})`, ok: false });
    } finally { setOrbBusy(false); }
  };

  const sendOrbitra = async (id: string) => {
    setOrbLeadBusy(id);
    try {
      const r = await fetch(`/api/leads/${id}/orbitra`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (d?.ok) load();
      else setOrbMsg({ text: `${t("leadOrbFail" as never)} (${String(d?.error ?? "error")})`, ok: false });
    } finally { setOrbLeadBusy(null); }
  };

  /** The "Write" draft, as a plain link: the operator's mail client opens it unmodified. */
  const draftHref = (lead: LeadFull): string => mailtoUrl(lead.email, generateDraftEmail({
    domain: lead.domain,
    score: lead.score,
    findings: lead.findings,
    lang: language,
    leadName: lead.name,
  }));

  const openProposal = (lead: LeadFull) => {
    setProposalFor(lead);
    setIncludeCodes(lead.findings.map(f => f.code));
    setProposalText(lead.proposal ?? "");
  };

  const regenerate = async () => {
    if (!proposalFor) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${proposalFor.id}/proposal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include: includeCodes, lang: language }),
      }).then(r => r.json()).catch(() => null);
      if (typeof res?.proposal === "string") setProposalText(res.proposal);
    } finally { setBusy(false); }
  };

  const saveProposal = async () => {
    if (!proposalFor) return;
    setBusy(true);
    try {
      await patchLead(proposalFor.id, { proposal: proposalText });
      setSavedFlash(tr("leadSaved"));
      setTimeout(() => setSavedFlash(""), 1500);
    } finally { setBusy(false); }
  };

  const exportUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    return `/api/leads/export?${params.toString()}`;
  }, [status, q]);

  return (
    <div className="main-content">
      <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}><Inbox size={22} /> {tr("leadTitle")}</h1>

      {/* The tab explains itself: where leads come from, where the widget code lives,
          what the pipeline does — instead of being a mystery inbox. */}
      <div style={{ marginBottom: 14 }}>
        <button className="pill" style={smallBtn} onClick={() => setShowWhat(v => !v)} aria-expanded={showWhat}>
          <HelpCircle size={13} /> {t("leadWhatToggle" as never)}
        </button>
        {showWhat ? (
          <div className="card" style={{ padding: 16, marginTop: 10, fontSize: 13, lineHeight: 1.55, color: "var(--color-text-secondary)" }}>
            <p style={{ margin: "0 0 8px" }}><strong>{t("leadWhatP1" as never)}</strong></p>
            <p style={{ margin: "0 0 8px" }}>{t("leadWhatP2" as never)}</p>
            <p style={{ margin: 0 }}>{t("leadWhatP3" as never)}</p>
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{t("leadWhatEmbedHint" as never)}</div>
              <code style={{ display: "block", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all", background: "rgba(127,127,127,0.12)", padding: "8px 10px", borderRadius: 8 }}>
{`<iframe src="${origin || "https://YOUR-INSTANCE"}/embed/audit?key=wid_…"
        style="width:100%;height:640px;border:0" loading="lazy" title="SEO audit"></iframe>`}
              </code>
            </div>
          </div>
        ) : null}
      </div>

      {/* Orbitra tracker bridge: connect once, then every lead grows a "create campaign"
          button — the campaign lands in the tracker named after the lead's domain. */}
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>{t("leadOrbTitle" as never)}</strong>
          {orb?.configured ? <span className="pill" style={{ color: "#10B981" }}>✓ {orb.url}</span> : null}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>{t("leadOrbHint" as never)}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, flex: "1 1 200px", minWidth: 180 }} placeholder="https://tracker.example.com"
            value={orbUrl} onChange={e => setOrbUrl(e.target.value)} aria-label={t("leadOrbUrl" as never)} />
          <input style={{ ...input, flex: "1 1 160px", minWidth: 140 }} type="password"
            placeholder={t("leadOrbKey" as never)} value={orbKey} onChange={e => setOrbKey(e.target.value)}
            aria-label={t("leadOrbKey" as never)} />
          <button style={smallBtn} disabled={orbBusy || !orbUrl.trim() || !orbKey.trim()} onClick={saveOrb}>
            {t("leadOrbSave" as never)}
          </button>
          {orb?.configured ? (
            <button style={smallBtn} disabled={orbBusy} onClick={testOrb}>{t("leadOrbTest" as never)}</button>
          ) : null}
          {orbMsg.text ? <span style={{ fontSize: 12, color: orbMsg.ok ? "#10B981" : "#EF4444" }}>{orbMsg.text}</span> : null}
        </div>
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 200 }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: 10, opacity: .5 }} />
          <input style={{ ...input, paddingLeft: 30 }} placeholder={tr("leadSearch")} value={q}
            onChange={e => setQ(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button style={status === "" ? activePill : pill} onClick={() => setStatus("")}>{tr("leadFilterAll")}</button>
          {LEAD_STATUSES.map(s => (
            <button key={s} style={status === s ? activePill : pill} onClick={() => setStatus(s)}
              aria-pressed={status === s}>
              {tr(`leadStatus_${s}`)}
            </button>
          ))}
        </div>
        <a href={exportUrl} style={{ ...smallBtn, textDecoration: "none" }} download>
          <Download size={13} /> {tr("leadExportCsv")}
        </a>
      </div>

      {notMigrated ? (
        <div className="card" style={{ padding: 14, color: "var(--color-text-secondary)", fontSize: 13 }}>
          {tr("autoSyncNotMigrated")} — <code>npx prisma db push</code>
        </div>
      ) : null}

      {leads === null ? (
        <div className="card" style={{ padding: 14, color: "var(--color-text-secondary)", fontSize: 13 }}>…</div>
      ) : leads.length === 0 ? (
        <div className="card" style={{ padding: 18, color: "var(--color-text-secondary)", fontSize: 13 }}>{tr("leadEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {leads.map(lead => (
            <div key={lead.id} className="card" style={{ padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", cursor: "pointer" }}
                onClick={() => openLead(lead.id)}>
                <span style={{
                  fontSize: 18, fontWeight: 800, minWidth: 52, textAlign: "center",
                  color: lead.score >= 80 ? "#10B981" : lead.score >= 50 ? "#F59E0B" : "#EF4444",
                }} title={`${tr("leadScore")}: ${lead.score}/100`}>{lead.score}</span>
                <div style={{ flex: "1 1 200px", minWidth: 180 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{lead.domain}</div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                    {lead.email}{lead.name ? ` · ${lead.name}` : ""} · {new Date(lead.createdAt).toLocaleString()}
                  </div>
                </div>
                <span className="pill" style={{ color: statusColor(lead.status) }} title={tr("leadStatus")}>
                  {tr(`leadStatus_${lead.status}`)}
                </span>
                {lead.orbitraAlias ? (
                  <a href={orb?.url || "#"} target="_blank" rel="noreferrer" className="pill"
                    style={{ textDecoration: "none", color: "#8B5CF6" }} title={`Orbitra: ${lead.orbitraAlias}`}>
                    Orbitra ↗
                  </a>
                ) : null}
                <select
                  value={lead.status}
                  disabled={busy}
                  onClick={e => e.stopPropagation()}
                  onChange={e => { e.stopPropagation(); patchLead(lead.id, { status: e.target.value }); }}
                  style={{ ...input, width: "auto", cursor: "pointer" }}
                  aria-label={tr("leadStatus")}
                >
                  {LEAD_STATUSES.map(s => <option key={s} value={s}>{tr(`leadStatus_${s}`)}</option>)}
                </select>
              </div>

              {lead.top.length ? (
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
                  <strong>{tr("leadTopIssues")}:</strong> {lead.top.join(" · ")}
                </div>
              ) : null}

              {openId === lead.id ? (
                <div style={{ marginTop: 12, borderTop: "1px solid var(--color-border)", paddingTop: 12 }}>
                  {!full ? <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>…</span> : (
                    <>
                      {full.message ? (
                        <p style={{ fontSize: 13, marginTop: 0 }}>“{full.message}”</p>
                      ) : null}
                      {full.origin ? (
                        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>
                          {tr("leadSource")}: {full.origin}
                        </div>
                      ) : null}
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                        {full.findings.map((f, i) => (
                          <div key={`${f.code}-${i}`} style={{ display: "flex", gap: 8, fontSize: 13 }}>
                            <span aria-hidden style={{
                              flex: "0 0 auto", width: 8, height: 8, borderRadius: 99, marginTop: 5,
                              background: f.severity === "critical" ? "#EF4444" : f.severity === "warning" ? "#F59E0B" : "#3B82F6",
                            }} />
                            <span>
                              <strong>{f.title}</strong>
                              {f.evidence ? <span style={{ color: "var(--color-text-secondary)" }}> · {f.evidence}</span> : null}
                              <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{f.fix}</div>
                            </span>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <a style={{ ...smallBtn, textDecoration: "none" }} href={draftHref(full)}>
                          <Mail size={13} /> {tr("leadWrite")}
                        </a>
                        <button style={smallBtn} onClick={() => openProposal(full)}><FileText size={13} /> {tr("leadMakeProposal")}</button>
                        <button style={smallBtn} disabled={busy} onClick={() => makeClient(lead)}>{tr("leadMakeClient")}</button>
                        {orb?.configured ? (
                          lead.orbitraAlias ? (
                            <a style={{ ...smallBtn, textDecoration: "none" }} href={orb.url} target="_blank" rel="noreferrer">
                              <ExternalLink size={13} /> {t("leadOrbOpen" as never)}
                            </a>
                          ) : (
                            <button style={smallBtn} disabled={orbLeadBusy === lead.id || busy} onClick={() => sendOrbitra(lead.id)}>
                              <ExternalLink size={13} /> {orbLeadBusy === lead.id ? "…" : t("leadOrbSend" as never)}
                            </button>
                          )
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ))}
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{leads.length} / {total}</div>
        </div>
      )}

      {proposalFor ? (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex",
          alignItems: "flex-start", justifyContent: "center", padding: 20, overflow: "auto", zIndex: 50,
        }} onClick={() => setProposalFor(null)}>
          <div className="card" style={{ maxWidth: 760, width: "100%", padding: 18 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <FileText size={16} />
              <strong style={{ fontSize: 15 }}>{tr("leadProposal")} — {proposalFor.domain}</strong>
              <span style={{ flex: 1 }} />
              <button style={smallBtn} onClick={() => setProposalFor(null)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 10 }}>
              {LEAD_STRINGS[language].proposal.noPromises}
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{tr("leadInclude")}:</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {proposalFor.findings.map(f => {
                const active = includeCodes.includes(f.code);
                return (
                  <button key={f.code} style={active ? activePill : pill}
                    onClick={() => setIncludeCodes(active ? includeCodes.filter(c => c !== f.code) : [...includeCodes, f.code])}
                    aria-pressed={active}>
                    {f.title}
                  </button>
                );
              })}
            </div>

            <textarea
              value={proposalText}
              onChange={e => setProposalText(e.target.value)}
              rows={16}
              style={{ ...input, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
            />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <button style={smallBtn} disabled={busy} onClick={regenerate}>{tr("leadMakeProposal")}</button>
              <button style={smallBtn} disabled={busy} onClick={saveProposal}>{tr("leadSave")}</button>
              <a href={`/api/leads/${proposalFor.id}/proposal`} target="_blank" rel="noreferrer"
                style={{ ...smallBtn, textDecoration: "none" }}>
                <Download size={13} /> {tr("leadDownload")}
              </a>
              <a href={`/api/leads/${proposalFor.id}/proposal`} target="_blank" rel="noreferrer"
                style={{ ...smallBtn, textDecoration: "none" }}>
                {tr("leadPrint")}
              </a>
              {savedFlash ? <span style={{ fontSize: 12, color: "#10B981", alignSelf: "center" }}>{savedFlash}</span> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
