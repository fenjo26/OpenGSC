"use client";

// Rich, in-app rendering of a digest. Unlike the Telegram text (a short summary capped at
// ~4000 chars), this shows the FULL data: every gainer/loser, all striking-distance queries,
// all attention sites, every rank move — with per-section "show all" and CSV export. It also
// splits the view per search engine: Google (from the local store) plus Bing/Yandex tabs that
// lazy-load live data when opened.

import { useState } from "react";
import { ChevronDown, ChevronUp, Download, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import RankFoundAt from "@/components/RankFoundAt";
import type { DigestData } from "@/lib/digest";

// The engine tab now reuses the full engine portfolio (per-site summary with period-over-period
// change), so it can show the same gainers/losers/attention sections as Google.
/** One site row of /api/gsc/portfolio-engine — opaque JSON, read defensively in EngineTab. */
type EngineSite = {
  url: string;
  hasData?: boolean;
  summary?: {
    clicks?: { value?: number; change?: number };
    impressions?: { value?: number };
    position?: { value?: number };
  };
};
type EnginePayload = { sites: EngineSite[] };
const cleanUrl = (u: string) => String(u || "").replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/.*$/, "");

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n)));
const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function downloadCsv(name: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers.join(","), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

const GoogleIcon = ({ s = 15 }) => (<svg width={s} height={s} viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>);
const BingIcon = ({ s = 15 }) => (<svg width={s} height={s} viewBox="0 0 512 512"><polygon points="166.685,38.682 52.904,0 52.904,422.118 166.685,321.987" fill="#008373"/><polygon points="206.501,133.117 253.157,249.166 319.397,270.361 56.324,431.215 170.095,512 459.096,336.78 459.096,216.17" fill="#008373"/></svg>);
const YandexIcon = ({ s = 15 }) => (<svg width={s} height={s} viewBox="0 0 32 32"><path d="M21.88,2h-4c-4,0-8.07,3-8.07,9.62a8.33,8.33,0,0,0,4.14,7.66L9,28.13A1.25,1.25,0,0,0,9,29.4a1.21,1.21,0,0,0,1,.6h2.49a1.24,1.24,0,0,0,1.2-.75l4.59-9h.34v8.62A1.14,1.14,0,0,0,19.82,30H22a1.12,1.12,0,0,0,1.16-1.06V3.22A1.19,1.19,0,0,0,22,2ZM18.7,16.28h-.59c-2.3,0-3.66-1.87-3.66-5,0-3.9,1.73-5.29,3.34-5.29h.94Z" fill="#d61e3b"/></svg>);

const card: React.CSSProperties = { background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden" };
const td: React.CSSProperties = { padding: "6px 14px", textAlign: "right", color: "var(--color-text-secondary)" };

function Delta({ n, invert = false }: { n: number; invert?: boolean }) {
  if (!n) return null;
  const good = invert ? n < 0 : n > 0;
  return <span style={{ fontSize: "11px", fontWeight: 500, marginLeft: "4px", color: good ? "#10B981" : "#EF4444" }}>{sign(n)}%</span>;
}

// A titled table that starts collapsed to `initial` rows with a "show all" toggle + CSV.
function Section({ title, count, initial = 8, csv, children }: { title: string; count: number; initial?: number; csv?: () => void; children: (limit: number) => React.ReactNode }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--color-border)" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>· {count}</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {csv && <button onClick={csv} title={t("exportCsv")} style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 9px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}><Download size={12} /> CSV</button>}
          {count > initial && <button onClick={() => setOpen(o => !o)} style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "4px 9px", borderRadius: "7px", border: "none", background: "transparent", color: "var(--color-accent-blue)", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}>{open ? <>{t("digestShowLess")} <ChevronUp size={13} /></> : <>{t("digestShowAll")} ({count}) <ChevronDown size={13} /></>}</button>}
        </div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
        <tbody>{children(open ? count : initial)}</tbody>
      </table>
    </div>
  );
}

export default function DigestView({ data, engines, fetchEngine }: {
  data: DigestData;
  engines: { bing: boolean; yandex: boolean };
  fetchEngine: (e: "bing" | "yandex") => Promise<EnginePayload>;
}) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<"google" | "bing" | "yandex">("google");
  const [engineData, setEngineData] = useState<Record<string, EnginePayload | "loading" | undefined>>({});

  const selectEngine = async (e: "bing" | "yandex") => {
    setTab(e);
    if (engineData[e] && engineData[e] !== "loading") return;
    setEngineData(d => ({ ...d, [e]: "loading" }));
    try { const payload = await fetchEngine(e); setEngineData(d => ({ ...d, [e]: payload })); }
    catch { setEngineData(d => ({ ...d, [e]: { sites: [] } })); }
  };

  const P = data.portfolio;
  const tabs: { id: "google" | "bing" | "yandex"; icon: React.ReactNode; label: string }[] = [
    { id: "google", icon: <GoogleIcon />, label: "Google" },
    ...(engines.bing ? [{ id: "bing" as const, icon: <BingIcon />, label: "Bing" }] : []),
    ...(engines.yandex ? [{ id: "yandex" as const, icon: <YandexIcon />, label: "Яндекс" }] : []),
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Title + explicit date range */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{data.tag ? `${t("digestTagPrefix")} ${data.tag}` : t("digestAllSites")}</div>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "2px" }}>
            {data.period.allTime ? t("digestPeriodAll") : `${data.period.from} — ${data.period.to}`}
            {data.showDelta && !data.period.allTime && <span style={{ opacity: 0.7 }}> · vs {data.period.prevFrom} — {data.period.prevTo}</span>}
          </div>
        </div>
        <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", fontStyle: "italic" }}>{t("digestRenderedNote")}</div>
      </div>

      {/* Engine tabs */}
      {tabs.length > 1 && (
        <div style={{ display: "flex", gap: "2px", background: "rgba(255,255,255,0.06)", borderRadius: "9px", padding: "3px", width: "fit-content" }}>
          {tabs.map(x => (
            <button key={x.id} onClick={() => x.id === "google" ? setTab("google") : selectEngine(x.id)}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 14px", borderRadius: "7px", fontSize: "12px", fontWeight: 700, cursor: "pointer", border: "none", background: tab === x.id ? "var(--color-card)" : "transparent", color: tab === x.id ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
              {x.icon} {x.label}
            </button>
          ))}
        </div>
      )}

      {tab === "google" ? (
        <>
          {/* Portfolio KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
            <div style={{ ...card, padding: "14px 16px" }}>
              <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--color-text-primary)" }}>{fmt(P.clicks)}{data.showDelta && <Delta n={P.prevClicks ? Math.round(((P.clicks - P.prevClicks) / P.prevClicks) * 100) : 0} />}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("clicks")}</div>
            </div>
            <div style={{ ...card, padding: "14px 16px" }}>
              <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--color-text-primary)" }}>{fmt(P.impr)}{data.showDelta && <Delta n={P.prevImpr ? Math.round(((P.impr - P.prevImpr) / P.prevImpr) * 100) : 0} />}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("impressions")}</div>
            </div>
            <div style={{ ...card, padding: "14px 16px" }}>
              <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--color-text-primary)" }}>{P.counted}</div>
              <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("digestSitesWord")}{data.showDelta && <> · <span style={{ color: "#10B981" }}>🟢 {P.up}</span> · <span style={{ color: "#EF4444" }}>🔴 {P.down}</span></>}</div>
            </div>
          </div>

          {data.showDelta ? (
            <>
              <Section title={t("digestSecGainers")} count={data.gainers.length}
                csv={() => downloadCsv("digest-gainers.csv", [t("digestColSite"), t("digestColClicks"), t("digestColChange"), "%"], data.gainers.map(s => [s.name, s.cur, sign(s.d), `${sign(s.pctNum)}%`]))}>
                {limit => data.gainers.slice(0, limit).map(s => (
                  <tr key={s.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>🟢 {s.name}</td>
                    <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{fmt(s.cur)}</td>
                    <td style={td}>{sign(s.d)}<Delta n={s.pctNum} /></td>
                  </tr>
                ))}
              </Section>
              <Section title={t("digestSecLosers")} count={data.losers.length}
                csv={() => downloadCsv("digest-losers.csv", [t("digestColSite"), t("digestColClicks"), t("digestColChange"), "%"], data.losers.map(s => [s.name, s.cur, sign(s.d), `${sign(s.pctNum)}%`]))}>
                {limit => data.losers.slice(0, limit).map(s => (
                  <tr key={s.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>🔴 {s.name}</td>
                    <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{fmt(s.cur)}</td>
                    <td style={td}>{sign(s.d)}<Delta n={s.pctNum} /></td>
                  </tr>
                ))}
              </Section>
            </>
          ) : (
            <Section title={t("digestSecTopSites")} count={data.topSites.length}
              csv={() => downloadCsv("digest-sites.csv", [t("digestColSite"), t("digestColClicks"), t("digestColImpr")], data.topSites.map(s => [s.name, s.cur, s.impr]))}>
              {limit => data.topSites.slice(0, limit).map(s => (
                <tr key={s.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>{s.name}</td>
                  <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{fmt(s.cur)}</td>
                  <td style={td}>{fmt(s.impr)}</td>
                </tr>
              ))}
            </Section>
          )}

          <Section title={t("digestSecWinnersQ")} count={data.winnersQ.length}
            csv={() => downloadCsv("digest-rising-queries.csv", [t("digestColQuery"), t("digestColClicks"), t("digestColChange")], data.winnersQ.map(q => [q.q, q.cur, sign(q.d)]))}>
            {limit => data.winnersQ.slice(0, limit).map((q, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "6px 14px", color: "var(--color-text-primary)", maxWidth: "340px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.q}</td>
                <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{q.cur}</td>
                <td style={{ ...td, color: "#10B981" }}>{sign(q.d)}</td>
              </tr>
            ))}
          </Section>
          <Section title={t("digestSecLosersQ")} count={data.losersQ.length}
            csv={() => downloadCsv("digest-falling-queries.csv", [t("digestColQuery"), t("digestColClicks"), t("digestColChange")], data.losersQ.map(q => [q.q, q.cur, sign(q.d)]))}>
            {limit => data.losersQ.slice(0, limit).map((q, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "6px 14px", color: "var(--color-text-primary)", maxWidth: "340px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.q}</td>
                <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{q.cur}</td>
                <td style={{ ...td, color: "#EF4444" }}>{sign(q.d)}</td>
              </tr>
            ))}
          </Section>

          <Section title={t("digestSecStriking")} count={data.striking.length} initial={10}
            csv={() => downloadCsv("digest-striking.csv", [t("digestColQuery"), t("digestColSite"), t("digestColPos"), t("digestColImpr")], data.striking.map(r => [r.query, r.site, r.pos, r.impr]))}>
            {limit => data.striking.slice(0, limit).map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "6px 14px", color: "var(--color-text-primary)", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.query}</td>
                <td style={{ ...td, textAlign: "left", color: "var(--color-text-secondary)" }}>{r.site}</td>
                <td style={{ ...td, color: "#F59E0B", fontWeight: 600 }}>{r.pos}</td>
                <td style={td}>{fmt(r.impr)}</td>
              </tr>
            ))}
          </Section>

          <Section title={t("digestSecAttention")} count={data.attention.length}
            csv={() => downloadCsv("digest-attention.csv", [t("digestColSite"), t("digestColDrop")], data.attention.map(a => [a.name, `${a.pct}%`]))}>
            {limit => data.attention.slice(0, limit).map((a, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>🚨 {a.name}</td>
                <td style={{ ...td, color: "#EF4444", fontWeight: 600 }}>−{a.pct}%</td>
              </tr>
            ))}
          </Section>

          <Section title={t("digestSecRankMoves")} count={data.rankMoves.length}
            csv={() => downloadCsv("digest-rank-moves.csv", [t("digestColKeyword"), "from", "to"], data.rankMoves.map(m => [m.keyword, m.from, m.to]))}>
            {limit => data.rankMoves.slice(0, limit).map((m, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "6px 14px", color: "var(--color-text-primary)", maxWidth: "340px" }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.d > 0 ? "▲" : "▼"} {m.keyword}</div>
                  {"foundAt" in m && (
                    <div style={{ marginTop: 4, whiteSpace: "normal", overflow: "visible" }}>
                      <RankFoundAt at={m.foundAt} />
                    </div>
                  )}
                </td>
                <td style={{ ...td, color: m.d > 0 ? "#10B981" : "#EF4444", fontWeight: 600, whiteSpace: "nowrap" }}>{m.from} → {m.to}</td>
              </tr>
            ))}
          </Section>

          {!data.gainers.length && !data.losers.length && !data.topSites.length && !data.winnersQ.length && !data.striking.length && !data.rankMoves.length && (
            <div style={{ ...card, padding: "28px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("digestNothing")}</div>
          )}
        </>
      ) : (
        <EngineTab payload={engineData[tab]} name={tab === "bing" ? "Bing" : "Яндекс"} />
      )}
    </div>
  );
}

function EngineTab({ payload, name }: { payload: EnginePayload | "loading" | undefined; name: string }) {
  const { t } = useLanguage();
  if (payload === "loading" || payload === undefined) {
    return <div style={{ ...card, padding: "32px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}><Loader2 size={16} className="spin" /> {t("digestEngineLoading")}</div>;
  }
  const sites = payload.sites || [];
  const rows = sites.map(s => ({
    name: cleanUrl(s.url),
    clicks: s.summary?.clicks?.value ?? 0,
    impr: s.summary?.impressions?.value ?? 0,
    cChg: s.summary?.clicks?.change ?? 0,
    pos: s.summary?.position?.value ?? 0,
    hasData: !!s.hasData,
  }));
  const withData = rows.filter(r => r.hasData);
  if (!withData.length) {
    return <div style={{ ...card, padding: "28px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("digestEngineEmpty")}</div>;
  }
  const totClicks = rows.reduce((a, r) => a + r.clicks, 0);
  const totImpr = rows.reduce((a, r) => a + r.impr, 0);
  const gainers = rows.filter(r => r.cChg > 0 && r.clicks > 0).sort((a, b) => b.cChg - a.cChg).slice(0, 50);
  const losers = rows.filter(r => r.cChg < 0).sort((a, b) => a.cChg - b.cChg).slice(0, 50);
  const attention = rows.filter(r => r.cChg <= -30 && r.clicks >= 0).sort((a, b) => a.cChg - b.cChg).slice(0, 50);
  const allSorted = [...rows].sort((a, b) => b.clicks - a.clicks || b.impr - a.impr);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
        <div style={{ ...card, padding: "14px 16px" }}>
          <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--color-text-primary)" }}>{fmt(totClicks)}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("clicks")}</div>
        </div>
        <div style={{ ...card, padding: "14px 16px" }}>
          <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--color-text-primary)" }}>{fmt(totImpr)}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("impressions")}</div>
        </div>
        <div style={{ ...card, padding: "14px 16px" }}>
          <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--color-text-primary)" }}>{withData.length}</div>
          <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("digestSitesWord")}</div>
        </div>
      </div>

      <Section title={t("digestSecGainers")} count={gainers.length}
        csv={() => downloadCsv(`${name}-gainers.csv`, [t("digestColSite"), t("digestColClicks"), "%"], gainers.map(r => [r.name, r.clicks, `${sign(r.cChg)}%`]))}>
        {limit => gainers.slice(0, limit).map((r, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
            <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>🟢 {r.name}</td>
            <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{fmt(r.clicks)}</td>
            <td style={td}><Delta n={r.cChg} /></td>
          </tr>
        ))}
      </Section>

      <Section title={t("digestSecLosers")} count={losers.length}
        csv={() => downloadCsv(`${name}-losers.csv`, [t("digestColSite"), t("digestColClicks"), "%"], losers.map(r => [r.name, r.clicks, `${sign(r.cChg)}%`]))}>
        {limit => losers.slice(0, limit).map((r, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
            <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>🔴 {r.name}</td>
            <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{fmt(r.clicks)}</td>
            <td style={td}><Delta n={r.cChg} /></td>
          </tr>
        ))}
      </Section>

      <Section title={t("digestSecAttention")} count={attention.length}
        csv={() => downloadCsv(`${name}-attention.csv`, [t("digestColSite"), t("digestColDrop")], attention.map(r => [r.name, `${r.cChg}%`]))}>
        {limit => attention.slice(0, limit).map((r, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
            <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>🚨 {r.name}</td>
            <td style={{ ...td, color: "#EF4444", fontWeight: 600 }}>{r.cChg}%</td>
          </tr>
        ))}
      </Section>

      <Section title={name} count={allSorted.length} initial={15}
        csv={() => downloadCsv(`${name}-sites.csv`, [t("digestColSite"), t("digestColClicks"), t("digestColImpr"), t("digestColPos")], allSorted.map(r => [r.name, r.clicks, r.impr, r.pos || ""]))}>
        {limit => allSorted.slice(0, limit).map((r, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
            <td style={{ padding: "6px 14px", color: "var(--color-text-primary)" }}>{r.name}</td>
            <td style={{ ...td, fontWeight: 600, color: "var(--color-text-primary)" }}>{fmt(r.clicks)}</td>
            <td style={td}>{fmt(r.impr)}</td>
            <td style={{ ...td, color: r.pos ? "#F59E0B" : "var(--color-text-secondary)" }}>{r.pos ? r.pos.toFixed(1) : "—"}</td>
          </tr>
        ))}
      </Section>
    </>
  );
}
