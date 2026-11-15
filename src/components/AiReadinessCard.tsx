"use client";

// AI Readiness card (site → Audit tab). One button runs three free checks in sequence and the
// card shows what each found plus the 0–100 score built from them
// (docs/tasks/ai-readiness/CONTRACT.md):
//   access   — robots.txt / llms.txt and the User-Agent parity probe of the homepage;
//   presence — the last twelve monthly Common Crawl archives;
//   rank     — the domain's position in Common Crawl's web graph.
//
// Two things the layout must keep honest: the score always sits next to the list of parts it
// was built from, and every colour carries its word — colour is never the only signal.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { isGuestView } from "@/lib/shareParam";
import type { AiReadyGrade, AiReadyPartName, AiReadyReport, ParityVerdict, PresenceMonth } from "@/lib/aiReady/types";

const GREEN = "#34c759", RED = "#ff375f", AMBER = "#ff9f0a";
const GRADE_COLOR: Record<AiReadyGrade, string> = { A: GREEN, B: GREEN, C: AMBER, D: AMBER, E: RED, F: RED };
const VERDICT_TONE: Record<ParityVerdict, "good" | "bad" | "warn" | "muted"> = {
  same: "good", different: "warn", redirected: "warn", blocked: "bad", challenge: "bad", error: "muted", inconclusive: "muted",
};
const STEPS: AiReadyPartName[] = ["access", "presence", "rank"];
/** Presence is resumable; this bounds the re-calls of one click (12 months fit in 2–3). */
const MAX_PRESENCE_CALLS = 6;

const sub: React.CSSProperties = { fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 };
const sectionTitle: React.CSSProperties = { fontSize: "13px", fontWeight: 700, color: "var(--color-text-primary)" };
const tile: React.CSSProperties = { padding: "8px 12px", borderRadius: "var(--radius-md)", background: "var(--color-bg)", border: "1px solid var(--color-border)" };

function Pill({ tone, children }: { tone: "good" | "bad" | "warn" | "muted"; children: React.ReactNode }) {
  const color = tone === "good" ? GREEN : tone === "bad" ? RED : tone === "warn" ? AMBER : "var(--color-text-tertiary)";
  const bg = tone === "good" ? "rgba(52,199,89,0.12)" : tone === "bad" ? "rgba(255,55,95,0.12)" : tone === "warn" ? "rgba(255,159,10,0.14)" : "var(--color-border-soft)";
  return <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: "var(--radius-pill)", fontSize: "11px", fontWeight: 600, color, background: bg, whiteSpace: "nowrap" }}>{children}</span>;
}

function MonthCell({ m, t }: { m: PresenceMonth; t: (k: string) => string }) {
  const state = m.present === null ? "unknown" : m.present ? "present" : "absent";
  const label = state === "unknown" ? t("aiReadyMonthUnknown")
    : state === "absent" ? t("aiReadyMonthAbsent")
    : (m.capped ? t("aiReadyCapturesCapped") : t("aiReadyCaptures")).replace("{n}", m.captures.toLocaleString());
  const color = state === "present" ? GREEN : state === "absent" ? "var(--color-text-tertiary)" : AMBER;
  return (
    <div title={`${m.crawl} · ${label}`} style={{ ...tile, padding: "6px 8px", minWidth: "74px", textAlign: "center" }}>
      <div style={{ fontSize: "11px", fontFamily: "monospace", color: "var(--color-text-secondary)" }}>{m.month || m.crawl.slice(8)}</div>
      <div style={{ fontSize: "11px", fontWeight: 600, color, marginTop: "2px", whiteSpace: "nowrap" }}>
        {state === "present" ? "✓" : state === "absent" ? "—" : "?"} {state === "present" ? `${m.captures.toLocaleString()}${m.capped ? "+" : ""}` : ""}
      </div>
    </div>
  );
}

export default function AiReadinessCard({ siteDbId }: { siteDbId: string }) {
  const { t: tRaw } = useLanguage();
  const t = tRaw as (k: string) => string;
  const guest = isGuestView();
  const [report, setReport] = useState<AiReadyReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<AiReadyPartName | null>(null);
  const [failed, setFailed] = useState<AiReadyPartName[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!siteDbId) return; // the page resolves the site row asynchronously
    (async () => {
      try {
        const res = await fetch(`/api/ai-readiness?siteId=${encodeURIComponent(siteDbId)}`);
        const data = res.ok ? await res.json() : null;
        if (alive.current && data?.report) setReport(data.report);
      } catch { /* the card simply stays empty */ }
      if (alive.current) setLoaded(true);
    })();
    return () => { alive.current = false; };
  }, [siteDbId]);

  const runPart = useCallback(async (part: AiReadyPartName): Promise<AiReadyReport | null> => {
    const res = await fetch("/api/ai-readiness", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siteId: siteDbId, part }),
    });
    const data = await res.json().catch(() => null);
    if (data?.report && alive.current) setReport(data.report);
    return res.ok && data?.report ? (data.report as AiReadyReport) : null;
  }, [siteDbId]);

  const run = useCallback(async () => {
    setFailed([]);
    const bad: AiReadyPartName[] = [];
    for (const part of STEPS) {
      if (!alive.current) return;
      setStep(part);
      try {
        let r = await runPart(part);
        if (!r) { bad.push(part); continue; }
        // Presence stops at its time budget and reports what is left; keep going until done.
        for (let i = 1; part === "presence" && r && (r.presence?.pending ?? 0) > 0 && i < MAX_PRESENCE_CALLS && alive.current; i++) {
          r = await runPart(part);
        }
      } catch { bad.push(part); }
    }
    if (alive.current) { setStep(null); setFailed(bad); }
  }, [runPart]);

  if (!siteDbId || !loaded) return null;
  const score = report?.score;
  const hasAny = Boolean(report?.access || report?.presence || report?.rank);
  if (guest && !hasAny) return null;
  const partName = (p: AiReadyPartName) => t(p === "access" ? "aiReadyPartAccess" : p === "presence" ? "aiReadyPartPresence" : "aiReadyPartRank");
  const access = report?.access, presence = report?.presence, rank = report?.rank;
  const knownMonths = presence?.months.filter(m => m.present !== null) ?? [];

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "16px" }}>
      {/* Header: title, the score with its coverage, the run button */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)" }}>
            <Sparkles size={15} /> {t("aiReadyTitle")}
          </div>
          <div style={{ ...sub, marginTop: "2px" }}>{t("aiReadySub")}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {score?.score != null && score.grade && (
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div aria-label={`${t("aiReadyTitle")}: ${score.grade}, ${score.score}/100`} style={{ width: "44px", height: "44px", borderRadius: "12px", display: "grid", placeItems: "center", fontSize: "22px", fontWeight: 800, color: "#fff", background: GRADE_COLOR[score.grade] }}>
                {score.grade}
              </div>
              <div>
                <div style={{ fontSize: "18px", fontWeight: 800, color: "var(--color-text-primary)", lineHeight: 1.1 }}>{score.score}<span style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-secondary)" }}> / 100</span></div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("aiReadyCoverage").replace("{parts}", score.coverage.map(partName).join(" + "))}</div>
              </div>
            </div>
          )}
          {!guest && (
            <button onClick={run} disabled={!!step}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontWeight: 600, cursor: step ? "default" : "pointer" }}>
              {step && <Loader2 size={13} className="spin" />}
              {step ? `${t("aiReadyRunning")} ${partName(step)}…` : hasAny ? t("aiReadyRerun") : t("aiReadyRun")}
            </button>
          )}
        </div>
      </div>

      {!hasAny && !step && <div style={sub}>{t("aiReadyNoData")}</div>}
      {failed.length > 0 && <div style={{ ...sub, color: AMBER }}>{t("aiReadyError").replace("{parts}", failed.map(partName).join(", "))}</div>}

      {/* Access */}
      {access && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
            <div style={sectionTitle}>{t("aiReadyAccessTitle")}{score?.parts.access != null && <span style={{ fontWeight: 600, color: "var(--color-text-secondary)" }}> · {score.parts.access}/100</span>}</div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <Pill tone={access.crawl.robots.status === "failed" ? "muted" : access.crawl.blockedCount > 0 ? "bad" : "good"}>
                {access.crawl.robots.status === "failed" ? `robots.txt: ${t("auditAiFailed")}` : t("aiReadyRobotsLine").replace("{n}", String(access.crawl.blockedCount)).replace("{m}", String(access.crawl.total))}
              </Pill>
              <Pill tone={access.crawl.llmsTxt.present ? "good" : "muted"}>/llms.txt: {access.crawl.llmsTxt.present ? t("aiReadyLlmsYes") : access.crawl.llmsTxt.status === "failed" ? t("auditAiFailed") : t("aiReadyLlmsNo")}</Pill>
            </div>
          </div>
          {!access.parity.conclusive
            ? <div style={{ ...sub, color: AMBER }}>{t("aiReadyBaselineFailed")}</div>
            : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "8px" }}>
                {access.parity.rows.map(r => (
                  <div key={r.id} style={{ ...tile, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.engine}</div>
                      <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>{r.label}{r.status != null ? ` · HTTP ${r.status}` : ""}</div>
                    </div>
                    <Pill tone={VERDICT_TONE[r.verdict]}>{t(`aiReadyVerdict_${r.verdict}`)}</Pill>
                  </div>
                ))}
              </div>
            )}
          <div style={{ ...sub, fontSize: "11px" }}>{t("aiReadyParityNote")}</div>
        </div>
      )}

      {/* Presence */}
      {presence && presence.months.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={sectionTitle}>
            {t("aiReadyPresenceTitle")}
            <span style={{ fontWeight: 600, color: "var(--color-text-secondary)" }}>
              {" · "}{t("aiReadyPresenceCount").replace("{n}", String(knownMonths.filter(m => m.present).length)).replace("{m}", String(knownMonths.length))}
              {score?.parts.presence != null && ` · ${score.parts.presence}/100`}
            </span>
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {[...presence.months].reverse().map(m => <MonthCell key={m.crawl} m={m} t={t} />)}
          </div>
          <div style={{ ...sub, fontSize: "11px" }}>{t("aiReadyPresenceNote")}</div>
        </div>
      )}

      {/* Rank */}
      {rank && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={sectionTitle}>{t("aiReadyRankTitle")}{score?.parts.authority != null && <span style={{ fontWeight: 600, color: "var(--color-text-secondary)" }}> · {score.parts.authority}/100</span>}</div>
          {rank.status === "ok" ? (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <div style={tile}>
                <div style={{ fontSize: "16px", fontWeight: 800, color: "var(--color-text-primary)" }}>{rank.authority ?? "—"}<span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)" }}> / 100</span></div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("aiReadyAuthority")}</div>
              </div>
              <div style={tile}>
                <div style={{ fontSize: "16px", fontWeight: 800, color: "var(--color-text-primary)" }}>#{rank.hcRank?.toLocaleString() ?? "—"}</div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("aiReadyHcRank")}{rank.total ? ` · ${t("aiReadyRankOf").replace("{total}", rank.total.toLocaleString())}` : ""}</div>
              </div>
              <div style={tile}>
                <div style={{ fontSize: "16px", fontWeight: 800, color: "var(--color-text-primary)" }}>{rank.prRank != null ? `#${rank.prRank.toLocaleString()}` : "—"}</div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{t("aiReadyPrRank")}</div>
              </div>
            </div>
          ) : (
            <div style={{ ...sub, color: rank.status === "not_found" ? "var(--color-text-secondary)" : AMBER }}>
              {t(rank.status === "not_found" ? "aiReadyRankNotFound" : rank.status === "not_configured" ? "aiReadyRankOff" : "aiReadyRankUnavailable")}
            </div>
          )}
          <div style={{ ...sub, fontSize: "11px" }}>
            {t("aiReadyRankNote")}{rank.release ? ` ${t("aiReadyRelease").replace("{release}", rank.release)}` : ""}{rank.domain && rank.domain !== report?.domain ? ` (${rank.domain})` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
