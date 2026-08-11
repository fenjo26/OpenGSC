"use client";

// Link Monitor — the detailed.com/ai-backlinks-api workflow: watch competitor brands,
// pull their fresh quality backlinks via the Ahrefs API, spot multi-linker domains and
// content/PR opportunities, with an AI summary on top.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, Plus, X, RefreshCw, Link2, Sparkles, ExternalLink, Star, Send, Target, Check } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getTaskCreds } from "@/lib/seo/keys";
import { getMetricsCreds } from "@/lib/seo/metricsClient";
import { markdownToHtml } from "@/lib/seo/outlineFormat";
import OutreachWorkspace from "@/components/OutreachWorkspace";
import { outreachErrorKey } from "@/lib/outreach/types";

const card = "panel";
const inputStyle = "tool-input";
const btnGhost: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 13px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" };
const btnPurple: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 16px", borderRadius: "9px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" };

export default function LinkWatchPage() {
  const { t, language } = useLanguage() as any;
  const lang = language || "en";
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  // Through the shared resolver rather than reading the storage key by name: the key and the
  // host it should be sent to are one setting, configured together under Settings → SEO Metrics.
  // Reading only half of it here is how this page ended up talking to the official API with a
  // gateway key in the first place.
  const ahrefsKey = mounted ? getMetricsCreds("ahrefs").apiKey : "";

  const [brands, setBrands] = useState<any[]>([]);
  const [mentions, setMentions] = useState<any[]>([]);
  const [topDomains, setTopDomains] = useState<any[]>([]);
  const [newDomains, setNewDomains] = useState("");
  const [running, setRunning] = useState(false);
  const [insLoading, setInsLoading] = useState(false);
  const [insights, setInsights] = useState("");
  const [err, setErr] = useState("");
  const [runInfo, setRunInfo] = useState("");
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [section, setSection] = useState<"mentions" | "prospects" | "campaigns">("mentions");
  const [resultView, setResultView] = useState<"domains" | "mentions">("domains");
  const [outreachRefresh, setOutreachRefresh] = useState(0);
  const [prospectDomains, setProspectDomains] = useState<Set<string>>(new Set());
  const [outreachInfo, setOutreachInfo] = useState("");

  useEffect(() => {
    if (!mounted) return;
    try { setFavs(new Set(JSON.parse(localStorage.getItem("lwFavDomains") || "[]"))); } catch {}
    reload();
    reloadOutreachDomains();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  async function reload() {
    try {
      const d = await fetch("/api/linkwatch").then(r => r.json());
      setBrands(d.brands || []); setMentions(d.mentions || []); setTopDomains(d.topDomains || []);
    } catch {}
  }

  async function reloadOutreachDomains() {
    try {
      const d = await fetch("/api/outreach", { cache: "no-store" }).then(r => r.json());
      setProspectDomains(new Set((d.prospects || []).map((prospect: any) => String(prospect.domain))));
    } catch {}
  }

  async function addProspect(input: { domain?: string; sourceUrl?: string }) {
    setErr(""); setOutreachInfo("");
    try {
      const res = await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "outreach_error");
      setOutreachInfo(t(d.created ? "outreachProspectAdded" : "outreachProspectExists"));
      await reloadOutreachDomains();
      setOutreachRefresh(value => value + 1);
    } catch (e: any) { setErr(t(outreachErrorKey(e?.message ?? e))); }
  }

  function toggleFav(domain: string) {
    setFavs(prev => {
      const n = new Set(prev);
      n.has(domain) ? n.delete(domain) : n.add(domain);
      localStorage.setItem("lwFavDomains", JSON.stringify([...n]));
      return n;
    });
  }

  async function addBrands() {
    const domains = newDomains.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean);
    if (!domains.length) return;
    setErr("");
    const res = await fetch("/api/linkwatch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domains }) });
    if (res.ok) { setNewDomains(""); reload(); } else setErr((await res.json()).error || "error");
  }

  async function removeBrand(domain: string) {
    await fetch(`/api/linkwatch?domain=${encodeURIComponent(domain)}`, { method: "DELETE" });
    reload();
  }

  async function run() {
    if (!ahrefsKey) { setErr(t("lwNoKey")); return; }
    setRunning(true); setErr(""); setRunInfo("");
    try {
      const res = await fetch("/api/linkwatch/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // Same key and same host override as the rest of the metrics stack, so a gateway user
        // does not have to keep a second, official key just for Link Monitor.
        body: JSON.stringify({ ahrefsKey, baseUrl: getMetricsCreds("ahrefs").baseUrl }),
      });
      const d = await res.json();
      if (!res.ok) setErr(d.error || "error");
      else {
        const errCount = Object.keys(d.errors || {}).length;
        setRunInfo(`${t("lwRunDone")}: ${d.saved} ${t("lwLinksSaved")} (${d.brandsChecked} ${t("lwBrandsChecked")}${errCount ? `, ${errCount} ${t("lwErrors")}` : ""})`);
        if (errCount) setErr(Object.entries(d.errors).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(" · "));
        reload();
      }
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setRunning(false);
  }

  async function genInsights() {
    const ai = getTaskCreds("analysis");
    if (!ai.apiKey) { setErr(t("seoErrNoAiKey")); return; }
    setInsLoading(true); setErr("");
    try {
      const res = await fetch("/api/linkwatch/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiProvider: ai.provider, aiApiKey: ai.apiKey, model: ai.model || undefined, aiBaseUrl: ai.baseUrl || undefined, language: lang || "ru" }),
      });
      const d = await res.json();
      if (!res.ok) setErr(d.error || "error"); else setInsights(d.insights || "");
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setInsLoading(false);
  }

  const shownMentions = mentions.filter(m => favs.size === 0 || resultView !== "mentions" ? true : favs.has(m.domainFrom));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}>
          <Link2 size={20} color="var(--color-accent-purple)" /> {t("lwTitle")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("lwSub")}</p>
      </div>

      <div style={{ display: "flex", gap: "4px", borderBottom: "1px solid var(--color-border)", overflowX: "auto" }}>
        {([
          ["mentions", "lwMentions", Link2],
          ["prospects", "outreachProspects", Send],
          ["campaigns", "outreachCampaigns", Target],
        ] as const).map(([value, key, Icon]) => (
          <button key={value} onClick={() => setSection(value)} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "9px 14px", border: "none", borderBottom: section === value ? "2px solid var(--color-accent-purple)" : "2px solid transparent", background: "transparent", color: section === value ? "var(--color-text-primary)" : "var(--color-text-secondary)", fontSize: "12px", fontWeight: section === value ? 700 : 500, cursor: "pointer", whiteSpace: "nowrap" }}>
            <Icon size={14} /> {t(key)}
          </button>
        ))}
      </div>

      {err && <div className={card} style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "12px" }}>{err}</div>}

      {section === "mentions" && <>

      {mounted && !ahrefsKey && (
        <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" /> {t("lwNoKey")} <Link href="/settings?tab=metrics" style={{ color: "var(--color-accent-blue)" }}>{t("navMetrics")}</Link>
        </div>
      )}
      {/* Brands */}
      <div className="panel privacy-blur-all">
        <div className="tool-section-label">{t("lwBrands")} ({brands.length})</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: "8px 0" }}>
          {brands.map(b => (
            <span key={b.id} style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 10px", borderRadius: "20px", fontSize: "12px", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}>
              {b.domain}
              <X size={12} style={{ cursor: "pointer", color: "var(--color-text-tertiary)" }} onClick={() => removeBrand(b.domain)} />
            </span>
          ))}
          {!brands.length && <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("lwNoBrands")}</span>}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <textarea className={inputStyle} style={{ flex: 1, minHeight: "42px", resize: "vertical" }} value={newDomains} onChange={e => setNewDomains(e.target.value)} placeholder={t("lwAddPh")} />
          <button onClick={addBrands} style={{ ...btnGhost, alignSelf: "flex-start" }}><Plus size={13} /> {t("lwAdd")}</button>
        </div>
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={run} disabled={running || !brands.length} style={{ ...btnPurple, opacity: running || !brands.length ? 0.6 : 1 }}>
            {running ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} {t("lwRun")}
          </button>
          <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("lwRunHint")}</span>
          {runInfo && <span style={{ fontSize: "12px", color: "var(--color-accent-green)" }}>{runInfo}</span>}
        </div>
      </div>

      {/* Results */}
      {(topDomains.length > 0 || mentions.length > 0) && (
        <div className={card}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
            <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "8px", overflow: "hidden" }}>
              {([["domains", t("lwTopDomains")], ["mentions", t("lwMentions")]] as const).map(([v, lbl]) => (
                <button key={v} onClick={() => setResultView(v)} style={{ padding: "7px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: resultView === v ? "var(--color-text-primary)" : "var(--color-bg)", color: resultView === v ? "var(--color-bg)" : "var(--color-text-secondary)" }}>{lbl}</button>
              ))}
            </div>
            <button onClick={genInsights} disabled={insLoading} style={{ ...btnGhost, marginLeft: "auto" }}>
              {insLoading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} {t("lwInsights")}
            </button>
          </div>

          {resultView === "domains" ? (
            <div className="privacy-blur-all" style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "480px", overflow: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "26px minmax(0,1fr) 90px 70px 70px 110px", gap: "8px", fontSize: "10px", fontWeight: 700, textTransform: "uppercase", color: "var(--color-text-tertiary)", padding: "4px 8px" }}>
                <span /><span>{t("lwColDomain")}</span><span>{t("lwColBrands")}</span><span>{t("lwColLinks")}</span><span>{t("lwColMaxDr")}</span><span />
              </div>
              {topDomains.map((d: any) => (
                <div key={d.domainFrom} style={{ display: "grid", gridTemplateColumns: "26px minmax(0,1fr) 90px 70px 70px 110px", gap: "8px", alignItems: "center", padding: "7px 8px", borderRadius: "8px", border: "1px solid var(--color-border)", fontSize: "12px" }}>
                  <Star size={14} style={{ cursor: "pointer" }} color={favs.has(d.domainFrom) ? "#F59E0B" : "var(--color-border)"} fill={favs.has(d.domainFrom) ? "#F59E0B" : "none"} onClick={() => toggleFav(d.domainFrom)} />
                  <a href={`https://${d.domainFrom}`} target="_blank" rel="noreferrer" style={{ color: "var(--color-text-primary)", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis" }}>{d.domainFrom} <ExternalLink size={9} style={{ opacity: 0.5 }} /></a>
                  <span style={{ fontWeight: 700, color: Number(d.brandsLinked) > 1 ? "var(--color-accent-green)" : "var(--color-text-secondary)" }}>{Number(d.brandsLinked)}</span>
                  <span>{Number(d.links)}</span>
                  <span>DR {Math.round(Number(d.maxDr))}</span>
                  <button onClick={() => addProspect({ domain: d.domainFrom })} disabled={prospectDomains.has(d.domainFrom)} style={{ ...btnGhost, padding: "5px 8px", fontSize: "10px", opacity: prospectDomains.has(d.domainFrom) ? 0.55 : 1 }}>
                    {prospectDomains.has(d.domainFrom) ? <Check size={11} /> : <Plus size={11} />} {t(prospectDomains.has(d.domainFrom) ? "outreachSaved" : "outreachSaveProspect")}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="privacy-blur-all" style={{ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "480px", overflow: "auto" }}>
              {shownMentions.slice(0, 300).map((m: any, i: number) => (
                <div key={i} style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
                  <div style={{ fontSize: "12px", color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <a href={m.urlFrom} target="_blank" rel="noreferrer" style={{ color: "var(--color-text-primary)" }}>{m.title || m.urlFrom}</a>
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
                    {m.domainFrom} → <b>{m.brand}</b> · DR {Math.round(m.drFrom)}{m.dofollow ? "" : " · nofollow"}{m.anchor ? ` · «${String(m.anchor).slice(0, 60)}»` : ""} · {m.firstSeen}
                  </div>
                  <button onClick={() => addProspect({ domain: m.domainFrom, sourceUrl: m.urlFrom })} disabled={prospectDomains.has(m.domainFrom)} style={{ ...btnGhost, padding: "5px 8px", fontSize: "10px", marginTop: "6px", opacity: prospectDomains.has(m.domainFrom) ? 0.55 : 1 }}>
                    {prospectDomains.has(m.domainFrom) ? <Check size={11} /> : <Plus size={11} />} {t(prospectDomains.has(m.domainFrom) ? "outreachSaved" : "outreachSaveProspect")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {insights && (
        <div className={card}>
          <div className="tool-section-label" style={{ marginBottom: "8px" }}>{t("lwInsightsTitle")}</div>
          <div className="seo-article" dangerouslySetInnerHTML={{ __html: markdownToHtml(insights) }} />
        </div>
      )}
      {outreachInfo && <div style={{ fontSize: "12px", color: "var(--color-accent-green)" }}>{outreachInfo}</div>}
      </>}

      {section !== "mentions" && <OutreachWorkspace mode={section} refreshToken={outreachRefresh} onError={setErr} />}
    </div>
  );
}
