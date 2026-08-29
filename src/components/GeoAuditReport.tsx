"use client";

import { useState } from "react";
import { ChevronDown, Eye, ExternalLink, Search, Target, Flag, Lightbulb, FileText, Check, X, ArrowUp } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { GeoReport } from "@/lib/seo/geo";

// Small {placeholder} interpolation over the flat t() dictionary.
function useT() {
  const { t } = useLanguage();
  return (key: any, params?: Record<string, string | number>) => {
    let s = t(key);
    if (params) for (const k of Object.keys(params)) s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(params[k]));
    return s;
  };
}

const GREEN = "var(--color-accent-green)";
const BLUE = "var(--color-accent-blue)";

function Ring({ pct, color }: { pct: number; color: string }) {
  const r = 34, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <svg width="84" height="84" viewBox="0 0 84 84" style={{ flexShrink: 0 }}>
      <circle cx="42" cy="42" r={r} fill="none" stroke="var(--color-border)" strokeWidth="8" />
      <circle cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 42 42)" />
      <text x="42" y="42" dominantBaseline="central" textAnchor="middle" fontSize="19" fontWeight="700" fill="var(--color-text-primary)">{pct}%</text>
    </svg>
  );
}

const card: React.CSSProperties = {
  background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "14px", padding: "20px",
};
const secTitle: React.CSSProperties = { fontSize: "18px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 2px" };
const secSub: React.CSSProperties = { fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 16px" };
const chip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", padding: "4px 11px", borderRadius: "8px", fontSize: "12px",
  border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", background: "var(--color-bg)",
};
const factorTag: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: "6px", fontSize: "10px", fontWeight: 700,
  letterSpacing: "0.04em", textTransform: "uppercase", background: "var(--color-text-primary)", color: "var(--color-bg)",
};

export default function GeoAuditReport({ report }: { report: GeoReport }) {
  const tp = useT();
  const m = report.metrics;
  const [openBatch, setOpenBatch] = useState<number | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);

  const maxScore = Math.max(...report.brands.map(b => b.score), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "26px" }}>
      {/* Header meta */}
      <div>
        <div style={{ fontSize: "12px", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "6px" }}>
          {tp("geoAuditLabel")} · {new Date(report.createdAt).toLocaleString()}
        </div>
        <h2 style={{ fontSize: "26px", fontWeight: 800, color: "var(--color-text-primary)", margin: "0 0 12px" }}>{report.query}</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {[report.language, report.country.toUpperCase(), report.model].map((x, i) => <span key={i} style={chip}>{x}</span>)}
          <span style={chip}>{tp("geoIntent")}: {report.classification.intent} · {report.classification.intentConfidence.toFixed(2)}</span>
          <span style={chip}>{tp("geoStage")}: {report.classification.stage}</span>
          <span style={chip}>{tp("geoTopic")}: {report.classification.topic}</span>
          <span style={{ ...chip, color: GREEN, borderColor: GREEN }}><Check size={13} style={{ marginRight: 5 }} /> {tp("geoFullAudit")}</span>
        </div>
      </div>

      {/* Your page — the actionable verdict, present only when the audit ran with a page URL.
          Placed above the metrics on purpose: it is the part the user is here for. */}
      {report.yourPage && (
        <section style={{ ...card, borderColor: report.yourPage.cited ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.3)" }}>
          <h3 style={secTitle}>{tp("geoYourPageTitle")}</h3>
          <p style={secSub}>{report.pageUrl}</p>
          <span style={{ ...chip, color: report.yourPage.cited ? GREEN : "var(--color-accent-red)", borderColor: report.yourPage.cited ? GREEN : "var(--color-accent-red)" }}>
            {report.yourPage.cited ? <Check size={13} style={{ marginRight: 5 }} /> : <X size={13} style={{ marginRight: 5 }} />}
            {report.yourPage.cited ? tp("geoYourPageCited") : tp("geoYourPageNotCited")}
          </span>
          {report.yourPage.summary && (
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.55, margin: "12px 0 0" }}>{report.yourPage.summary}</p>
          )}
          {report.yourPage.gaps.length > 0 && (
            <>
              <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)", margin: "16px 0 6px" }}>{tp("geoYourPageGaps")}</div>
              <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                {report.yourPage.gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </>
          )}
          {report.yourPage.fixes.length > 0 && (
            <>
              <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)", margin: "16px 0 6px" }}>{tp("geoYourPageFixes")}</div>
              <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.6 }}>
                {report.yourPage.fixes.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </>
          )}
          {report.yourPage.citedCompetitors.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "14px" }}>
              {report.yourPage.citedCompetitors.map(d => <span key={d} style={chip}>{d}</span>)}
            </div>
          )}
        </section>
      )}
      {!report.yourPage && report.pageUrl && (
        <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{tp("geoYourPageFetchFail")}</div>
      )}

      {/* Metric cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "14px" }}>
        <Metric label={tp("geoMetricSearchBatches")} value={m.searchBatches} sub={tp("geoMetricUniqueQueries", { n: m.uniqueQueries })} />
        <Metric label={tp("geoMetricPagesOpened")} value={m.pagesOpened} sub={tp("geoMetricDeepReads")} />
        <Metric label={tp("geoMetricSourcesScanned")} value={m.sourcesScanned} sub={tp("geoMetricUniqueDomains", { n: m.uniqueDomains })} />
        <Metric label={tp("geoMetricCitations")} value={m.citations} sub={tp("geoMetricScannedCited", { n: m.scannedToCitedPct })} />
      </div>

      {/* Donuts */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "14px" }}>
        <div style={{ ...card, display: "flex", gap: "18px", alignItems: "center" }}>
          <Ring pct={m.top3ConcentrationPct} color={GREEN} />
          <div>
            <div style={{ fontSize: "12px", letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "6px" }}>{tp("geoTop3Title")}</div>
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
              {m.top3ConcentrationPct < 50 ? tp("geoTop3Fragmented", { n: m.top3ConcentrationPct }) : tp("geoTop3Concentrated", { n: m.top3ConcentrationPct })}
            </div>
          </div>
        </div>
        <div style={{ ...card, display: "flex", gap: "18px", alignItems: "center" }}>
          <Ring pct={m.dominantType.pct} color={BLUE} />
          <div>
            <div style={{ fontSize: "12px", letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "6px" }}>{tp("geoDominantTitle", { label: m.dominantType.label })}</div>
            <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{tp("geoDominantDesc", { n: m.dominantType.pct, label: m.dominantType.label })}</div>
          </div>
        </div>
      </div>

      {/* Search batches */}
      <section>
        <h3 style={secTitle}>{tp("geoSecBatches")} · {tp("geoBatchesCount", { a: report.batches.length, b: m.uniqueQueries })}</h3>
        <p style={secSub}>{tp("geoBatchesSub")}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {report.batches.map((b, i) => {
            const open = openBatch === i;
            return (
              <div key={i} style={card}>
                <div onClick={() => setOpenBatch(open ? null : i)} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", cursor: "pointer", gap: "12px" }}>
                  <div style={{ display: "flex", gap: "14px", flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--color-text-tertiary)" }}>B{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "6px" }}>{tp("geoQueriesN", { n: b.queries.length })}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        {b.queries.map((q, qi) => <div key={qi} style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>· {q}</div>)}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{b.cited > 0 ? tp("geoScannedCited", { s: b.scanned, c: b.cited }) : tp("geoScanned", { s: b.scanned })}</span>
                    <ChevronDown size={16} color="var(--color-text-tertiary)" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Open page actions */}
      {report.openPages.length > 0 && (
        <section>
          <h3 style={secTitle}>{tp("geoSecOpenPages")} · {report.openPages.length}</h3>
          <p style={secSub}>{tp("geoOpenPagesSub")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {report.openPages.map((p) => (
              <div key={p.rank} style={{ ...card, padding: "13px 16px", background: "rgba(255,159,10,0.06)", borderColor: "rgba(255,159,10,0.25)", display: "flex", alignItems: "center", gap: "14px" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--color-text-tertiary)" }}>#{p.rank}</span>
                <span style={{ ...factorTag, background: "rgba(255,159,10,0.18)", color: "var(--color-accent-orange)" }}><Eye size={11} style={{ marginRight: 4 }} /> {tp("geoDeepRead")}</span>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-text-primary)", fontFamily: "monospace" }}>{p.domain}</span>
                <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{p.path}</span>
                <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: "12px", color: BLUE, display: "inline-flex", alignItems: "center", gap: "4px" }}>{tp("geoOpen")} <ExternalLink size={12} /></a>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Brand leaderboard */}
      {report.brands.length > 0 && (
        <section>
          <h3 style={secTitle}>{tp("geoSecLeaderboard")} · {tp("geoLeaderboardSub", { n: report.brands.length })}</h3>
          <p style={secSub}>{tp("geoLeaderboardHint")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {report.brands.map((b) => (
              <div key={b.rank} style={{ ...card, ...(b.dominant ? { background: "rgba(52,199,89,0.06)", borderColor: "rgba(52,199,89,0.4)" } : {}) }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px" }}>
                  <div style={{ display: "flex", gap: "14px", alignItems: "baseline" }}>
                    <span style={{ fontSize: "18px", fontWeight: 700, color: "var(--color-text-tertiary)" }}>{b.rank}</span>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)" }}>{b.name}</span>
                        {b.dominant && <span style={{ ...factorTag, background: GREEN, color: "#fff" }}>{tp("geoDominantBadge")}</span>}
                        <span style={chip}>{tp("geoMentionsN", { n: b.mentions })}</span>
                      </div>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
                        {b.tags.map((tg, i) => <span key={i} style={chip}>{tg}</span>)}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: "160px" }}>
                    <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "var(--color-border)", overflow: "hidden" }}>
                      <div style={{ width: `${(b.score / maxScore) * 100}%`, height: "100%", background: b.dominant ? GREEN : "var(--color-text-primary)" }} />
                    </div>
                    <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{b.score.toFixed(2)}</span>
                  </div>
                </div>
                {/* factor rows */}
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "14px" }}>
                  {([["geoPricing", b.pricing], ["geoSupport", b.support], ["geoFeatureBreadth", b.featureBreadth]] as const).map(([k, val], i) => val ? (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <span style={{ ...factorTag, minWidth: "108px", justifyContent: "center" }}>{tp(k)}</span>
                      <span style={{ fontSize: "13px", color: "var(--color-text-secondary)", flex: 1 }}>{val}</span>
                      <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>{b.domain}</span>
                    </div>
                  ) : null)}
                </div>
                {/* surfaced in */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--color-border)" }}>
                  <span style={{ fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)" }}>{tp("geoSurfacedIn")}</span>
                  <div style={{ display: "flex", gap: "4px" }}>
                    {Array.from({ length: Math.max(10, b.totalQueries) }, (_, i) => i + 1).slice(0, 10).map(n => {
                      const on = b.surfacedIn.includes(n);
                      return <span key={n} style={{ width: 20, height: 20, borderRadius: "5px", fontSize: "11px", fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", background: on ? GREEN : "var(--color-border)", color: on ? "#fff" : "var(--color-text-tertiary)" }}>{n}</span>;
                    })}
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginLeft: "6px" }}>{tp("geoOfQueries", { a: b.surfacedIn.length, b: b.totalQueries })}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Selection factors */}
      {report.selectionFactors.length > 0 && (
        <section>
          <h3 style={secTitle}>{tp("geoSecSelection")}</h3>
          <p style={secSub}>{tp("geoSelectionSub")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {report.selectionFactors.map((f, i) => (
              <div key={i} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>{f.name}</span>
                    <span style={{ ...factorTag, background: "rgba(255,69,58,0.14)", color: "var(--color-accent-red)" }}>{f.weight}</span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{tp("geoMentionsN", { n: f.items.length })}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
                  {f.items.map((it, j) => (
                    <div key={j} style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>
                      <span style={{ color: GREEN }}>● </span>
                      <span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{it.brand}</span> — {it.note}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Key entities */}
      {report.keyEntities.length > 0 && (
        <section>
          <h3 style={secTitle}>{tp("geoSecEntities")}</h3>
          <p style={secSub}>{tp("geoEntitiesSub")}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
            {report.keyEntities.map((g, i) => (
              <div key={i} style={card}>
                <div style={{ fontSize: "11px", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "12px" }}>{g.category}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {g.items.map((e, j) => (
                    <div key={j}>
                      <div style={{ fontSize: "14px", color: "var(--color-text-primary)" }}>{e.name} <span style={{ color: "var(--color-text-tertiary)" }}>·{e.count}</span></div>
                      {e.brands.length > 0 && <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>→ {e.brands.length >= report.brands.length ? tp("geoAllBrands", { n: report.brands.length }) : e.brands.join(", ")}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Source types breakdown */}
      {report.sourceTypes.length > 0 && (
        <section>
          <h3 style={secTitle}>{tp("geoSecSourceTypes")}</h3>
          <p style={secSub}>{tp("geoSourceTypesSub")}</p>
          <div style={{ ...card, display: "flex", flexDirection: "column", gap: "12px" }}>
            {report.sourceTypes.map((s, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                <span style={{ fontSize: "13px", color: "var(--color-text-primary)", width: "130px", flexShrink: 0 }}>{s.label}</span>
                <div style={{ flex: 1, height: "26px", borderRadius: "7px", background: "var(--color-bg)", overflow: "hidden", position: "relative" }}>
                  {s.cites > 0
                    ? <div style={{ width: `${s.pct}%`, height: "100%", background: i === 0 ? GREEN : BLUE, display: "flex", alignItems: "center", paddingLeft: "10px", color: "#fff", fontSize: "12px", fontWeight: 700 }}>{s.pct}%</div>
                    : <div style={{ height: "100%", display: "flex", alignItems: "center", paddingLeft: "10px", color: "var(--color-text-tertiary)", fontSize: "12px", fontStyle: "italic" }}>{tp("geoScannedNeverCited")}</div>}
                </div>
                <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", width: "140px", textAlign: "right", flexShrink: 0 }}>{tp("geoCitesDomains", { c: s.cites, d: s.domains })}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Trust signals */}
      {report.trustSignals.length > 0 && (
        <section>
          <h3 style={secTitle}>{tp("geoSecTrust")} · {tp("geoTrustTop", { n: report.trustSignals.length })}</h3>
          <p style={{ ...secSub, fontFamily: "monospace", fontSize: "12px" }}>{tp("geoTrustFormula")}</p>
          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--color-text-tertiary)", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <th style={{ padding: "12px 16px" }}>{tp("geoColDomain")}</th>
                  <th style={{ padding: "12px 16px" }}>{tp("geoColType")}</th>
                  <th style={{ padding: "12px 16px", textAlign: "center" }}>{tp("geoColCited")}</th>
                  <th style={{ padding: "12px 16px", textAlign: "center" }}>{tp("geoColOpened")}</th>
                  <th style={{ padding: "12px 16px", textAlign: "center" }}>{tp("geoColCites")}</th>
                  <th style={{ padding: "12px 16px" }}>{tp("geoColTrust")}</th>
                </tr>
              </thead>
              <tbody>
                {report.trustSignals.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "12px 16px", fontFamily: "monospace", color: "var(--color-text-primary)" }}>{r.domain}</td>
                    <td style={{ padding: "12px 16px", color: "var(--color-text-secondary)" }}>{r.label}</td>
                    <td style={{ padding: "12px 16px", textAlign: "center", color: r.cited ? GREEN : "var(--color-text-tertiary)" }}>{r.cited ? "✓" : "—"}</td>
                    <td style={{ padding: "12px 16px", textAlign: "center", color: r.opened ? "var(--color-accent-orange)" : "var(--color-text-tertiary)" }}>{r.opened ? "✓" : "—"}</td>
                    <td style={{ padding: "12px 16px", textAlign: "center", color: "var(--color-text-primary)" }}>{r.cites}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <div style={{ width: "90px", height: "6px", borderRadius: "3px", background: "var(--color-border)", overflow: "hidden" }}>
                          <div style={{ width: `${r.trust * 100}%`, height: "100%", background: BLUE }} />
                        </div>
                        <span style={{ fontWeight: 700, color: "var(--color-text-primary)" }}>{r.trust.toFixed(2)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Inclusion pattern */}
      {report.inclusion.signals.length > 0 && (
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={secTitle}>{tp("geoSecInclusion")}</h3>
            <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontFamily: "monospace" }}>{tp("geoStability", { s: report.inclusion.stability })}</span>
          </div>
          <p style={{ ...secSub, fontStyle: "italic" }}>{tp("geoInclusionNote", { n: report.inclusion.topCount })}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {report.inclusion.signals.map((sig, i) => {
              const style = sig.kind === "required" ? { bg: "rgba(52,199,89,0.06)", bd: "rgba(52,199,89,0.4)", icon: <Check size={15} color={GREEN} /> }
                : sig.kind === "boosting" ? { bg: "rgba(255,159,10,0.06)", bd: "rgba(255,159,10,0.4)", icon: <ArrowUp size={15} color="var(--color-accent-orange)" /> }
                : { bg: "transparent", bd: "var(--color-border)", icon: <X size={15} color="var(--color-text-tertiary)" /> };
              return (
                <div key={i} style={{ ...card, background: style.bg, borderColor: style.bd }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                    {style.icon}
                    <span style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-secondary)" }}>{tp(("geoKind_" + sig.kind) as any)} · {sig.type}</span>
                  </div>
                  <div style={{ fontSize: "14px", color: "var(--color-text-primary)", marginBottom: "8px" }}>{sig.text}</div>
                  {sig.kind !== "absent" && (
                    <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontFamily: "monospace", marginBottom: "8px" }}>
                      {tp("geoCitedAcross", { c: sig.cites, b: sig.brands })}  ·  {tp("geoTopHave", { x: report.inclusion.topCount, y: report.inclusion.topCount })}
                    </div>
                  )}
                  {sig.note && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", fontStyle: "italic", marginBottom: "8px" }}>{sig.note}</div>}
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {sig.domains.map((d, j) => <span key={j} style={{ ...chip, fontFamily: "monospace", fontSize: "11px" }}>{d}</span>)}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Coverage gaps */}
      <section>
        <h3 style={secTitle}>{tp("geoSecCoverage")}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "14px", marginTop: "14px" }}>
          <GapCard title={tp("geoMissingFactors")} items={report.coverageGaps.missingFactors} none={tp("geoNone")} />
          <GapCard title={tp("geoMissingEntities")} items={report.coverageGaps.missingEntities} none={tp("geoNone")} />
          <div style={card}>
            <div style={{ fontSize: "11px", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "12px" }}>{tp("geoMissingSourceTypes")}</div>
            {report.coverageGaps.missingSourceTypes.length === 0
              ? <div style={{ fontSize: "13px", color: "var(--color-text-tertiary)", fontStyle: "italic" }}>{tp("geoNone")}</div>
              : report.coverageGaps.missingSourceTypes.map((s, i) => (
                <div key={i} style={{ marginBottom: "10px" }}>
                  <div style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>{s.type}</div>
                  <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{s.note}</div>
                </div>
              ))}
          </div>
        </div>
      </section>

      {/* Insights */}
      <section>
        <h3 style={secTitle}>{tp("geoSecInsights")}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "14px", marginTop: "14px" }}>
          <Insight icon={<Search size={16} color={BLUE} />} title={tp("geoInsightSearch")} body={report.insights.userSearchBehavior} />
          <Insight icon={<Target size={16} color={BLUE} />} title={tp("geoInsightDominant")} body={report.insights.dominantSource} />
          <Insight icon={<Flag size={16} color={GREEN} />} title={tp("geoInsightStrategic")} body={report.insights.strategicEngagement} />
          <Insight icon={<Lightbulb size={16} color="var(--color-accent-orange)" />} title={tp("geoInsightOpportunity")} body={report.insights.opportunityGaps} />
        </div>
      </section>

      {/* Original answer */}
      <section>
        <h3 style={secTitle}>{tp("geoSecAnswer")}</h3>
        <div style={{ ...card, marginTop: "12px", cursor: "pointer" }} onClick={() => setShowAnswer(s => !s)}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "14px", color: "var(--color-text-primary)" }}>
              <FileText size={16} color="var(--color-text-secondary)" /> {tp("geoShowAnswer")}
              <span style={{ color: "var(--color-text-tertiary)", fontSize: "13px" }}>· {tp("geoCitationsChars", { c: report.answer.citations.length, n: report.answer.chars })}</span>
            </span>
            <ChevronDown size={16} color="var(--color-text-tertiary)" style={{ transform: showAnswer ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
          </div>
          {showAnswer && (
            <div style={{ marginTop: "16px", borderTop: "1px solid var(--color-border)", paddingTop: "16px" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: "13px", lineHeight: 1.7, color: "var(--color-text-secondary)", whiteSpace: "pre-wrap" }}>{report.answer.text}</div>
              {report.answer.citations.length > 0 && (
                <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "5px" }}>
                  {report.answer.citations.map(c => (
                    <a key={c.n} href={c.url} target="_blank" rel="noreferrer" style={{ fontSize: "12px", color: BLUE, display: "flex", gap: "6px" }}>
                      <span style={{ color: "var(--color-text-tertiary)" }}>[{c.n}]</span> {c.title || c.url}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "10px" }}>{label}</div>
      <div style={{ fontSize: "40px", fontWeight: 700, color: "var(--color-text-primary)", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginTop: "10px" }}>{sub}</div>
    </div>
  );
}

function GapCard({ title, items, none }: { title: string; items: string[]; none: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: "11px", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-text-tertiary)", marginBottom: "12px" }}>{title}</div>
      {items.length === 0
        ? <div style={{ fontSize: "13px", color: "var(--color-text-tertiary)", fontStyle: "italic" }}>{none}</div>
        : <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>{items.map((it, i) => <div key={i} style={{ fontSize: "13px", color: "var(--color-text-primary)" }}>{it}</div>)}</div>}
    </div>
  );
}

function Insight({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
        {icon}
        <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{title}</span>
      </div>
      <div style={{ fontSize: "13px", lineHeight: 1.6, color: "var(--color-text-secondary)" }}>{body}</div>
    </div>
  );
}
