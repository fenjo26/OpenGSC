"use client";

// «Доля голоса» sub-tab, lower half (T7): which domains the AI engines cite when answering this
// site's tracked questions. Pure aggregation over stored AeoCheck.citations — being mentioned
// on these sites is how a page gets into the answers, hence the "add to Outreach" action.

import { useEffect, useState } from "react";
import { ExternalLink, Handshake } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import type { CitedDomainRow } from "@/lib/visibility/types";

const GREEN = "#10B981";
const VIOLET = "#8B5CF6";

function engineName(e: string): string {
  const known: Record<string, string> = { chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", grok: "Grok", gemini: "Gemini" };
  return known[e] ?? e;
}

async function fetchCited(siteDbId: string): Promise<{ cited: CitedDomainRow[]; answers: number }> {
  const r = await fetch(`/api/aeo/sov?siteId=${encodeURIComponent(siteDbId)}&days=30`);
  const d = await r.json();
  return {
    cited: Array.isArray(d?.cited) ? (d.cited as CitedDomainRow[]) : [],
    answers: Number(d?.report?.answers ?? 0),
  };
}

export default function CitedDomains({ siteDbId, domain, readOnly = false }: { siteDbId: string; domain: string; readOnly?: boolean }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};
  void domain;

  const [rows, setRows] = useState<CitedDomainRow[]>([]);
  const [answers, setAnswers] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());

  // setState only inside promise callbacks — never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetchCited(siteDbId)
      .then(d => { if (!cancelled) { setRows(d.cited); setAnswers(d.answers); } })
      .catch(() => { /* keep the last list */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteDbId]);

  const toOutreach = async (row: CitedDomainRow) => {
    setSending(row.domain);
    try {
      const r = await fetch("/api/aeo/cited-to-outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, domain: row.domain }),
      });
      if (r.ok) setSentTo(s => new Set([...s, row.domain]));
    } finally { setSending(null); }
  };

  return (
    <div className="card" style={{ padding: "16px" }}>
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aiCitedTitle")}</div>
      <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", marginTop: "4px", marginBottom: "12px", lineHeight: 1.5 }}>
        {t("aiCitedHint")}
      </div>

      {loading ? (
        <div style={{ padding: "20px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>…</div>
      ) : !answers || !rows.length ? (
        <div style={{ padding: "20px", textAlign: "center", fontSize: "13px", color: "var(--color-text-tertiary)" }}>{t("aiSovNoData")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12.5px", minWidth: "640px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>#</th>
                <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>domain</th>
                <th style={{ textAlign: "center", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiCitedCitations")}</th>
                <th style={{ textAlign: "center", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiCitedAnswers")}</th>
                <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aiCitedEngines")}</th>
                <th style={{ textAlign: "left", padding: "7px 10px", color: "var(--color-text-secondary)", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("aeoColQuestion")}</th>
                <th style={{ padding: "7px 10px" }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.domain} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "7px 10px", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{i + 1}</td>
                  <td style={{ padding: "7px 10px", ...blurStyle }}>
                    <span style={{
                      fontWeight: row.isUs ? 700 : 600,
                      color: row.isUs ? GREEN : row.competitor ? VIOLET : "var(--color-text-primary)",
                    }}>
                      {row.domain}
                    </span>
                    {row.isUs && <span style={{ marginLeft: "6px", fontSize: "9.5px", fontWeight: 700, color: GREEN, textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("aiSovUs")}</span>}
                    {row.competitor && <span className="pill" style={{ marginLeft: "6px", fontSize: "9.5px", padding: "1px 7px", color: VIOLET }}>{row.competitor}</span>}
                  </td>
                  <td style={{ padding: "7px 10px", textAlign: "center", color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>{row.citations}</td>
                  <td style={{ padding: "7px 10px", textAlign: "center", color: "var(--color-text-primary)", fontVariantNumeric: "tabular-nums" }}>{row.answers}</td>
                  <td style={{ padding: "7px 10px", color: "var(--color-text-tertiary)", fontSize: "11px", whiteSpace: "nowrap" }}>
                    {row.engines.map(engineName).join(" · ")}
                  </td>
                  <td style={{ padding: "7px 10px", maxWidth: "220px" }}>
                    {row.exampleUrl ? (
                      <a href={row.exampleUrl} target="_blank" rel="noreferrer"
                        style={{ color: "var(--color-text-secondary)", textDecoration: "none", fontSize: "11.5px", display: "flex", alignItems: "center", gap: "4px", ...blurStyle }}
                        title={`${row.exampleQuestion}\n${row.exampleUrl}`}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.exampleQuestion}</span>
                        <ExternalLink size={10} style={{ flexShrink: 0 }} />
                      </a>
                    ) : (
                      <span style={{ color: "var(--color-text-tertiary)", fontSize: "11.5px" }} title={row.exampleQuestion}>{row.exampleQuestion}</span>
                    )}
                  </td>
                  <td style={{ padding: "7px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                    {(sentTo.has(row.domain) || row.isUs || readOnly) ? (
                      sentTo.has(row.domain) && <span style={{ fontSize: "10.5px", fontWeight: 700, color: GREEN }}>✓</span>
                    ) : (
                      <button
                        onClick={() => toOutreach(row)}
                        disabled={sending === row.domain}
                        title={t("aiCitedToOutreach")}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: "5px", padding: "4px 10px", borderRadius: "7px",
                          border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)",
                          fontSize: "11px", fontWeight: 600, cursor: sending === row.domain ? "not-allowed" : "pointer",
                        }}>
                        <Handshake size={11} /> {sending === row.domain ? "…" : t("aiCitedToOutreach")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
