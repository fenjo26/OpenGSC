"use client";

import { useEffect, useState, useCallback } from "react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import {
  MousePointerClick, AlertCircle, ArrowLeft, ScrollText,
  Users, Clock, Code2, RefreshCw, ExternalLink, ChevronDown,
  ChevronUp, Sparkles, BookOpen, Info, Save, Eye, EyeOff, ChevronsDown,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
import type { ClarityMetric, PageRow } from "@/lib/clarityParse";

interface Snapshot {
  fetchedAt: string;
  periodDays: number;
  data: { traffic: any[]; ux: any[]; fetchedWith: { days: number } };
}

// Aggregated view across collected snapshots (computed server-side).
interface Aggregate {
  metrics: ClarityMetric[];
  pages: PageRow[];
  daysCovered: number;
}

// Strip Markdown so the report reads cleanly (and is client-ready) regardless
// of what the model returns: headings, bold, bullets, inline code → plain text.
function cleanReport(s: string): string {
  return (s || "")
    .replace(/^\s*#{1,6}\s*/gm, "")          // # headings
    .replace(/\*\*(.*?)\*\*/g, "$1")          // **bold**
    .replace(/__(.*?)__/g, "$1")              // __bold__
    .replace(/(^|\n)[ \t]*[*\-•]\s+/g, "$1• ") // bullet markers → •
    .replace(/`([^`]+)`/g, "$1")              // `code`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ghostBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "5px",
  padding: "6px 12px", borderRadius: "9999px",
  background: "transparent", color: "var(--color-text-secondary)",
  border: "1px solid var(--color-border)", fontSize: "12px", fontWeight: 500, cursor: "pointer",
};

// ─── Small metric card ────────────────────────────────────────────────────────
function MetricCard({
  icon, label, desc, value, unit, warn,
}: {
  icon: React.ReactNode; label: string; desc: string;
  value: number; unit?: string; warn?: boolean;
}) {
  const color = warn && value > 0 ? "var(--color-accent-red)" : "var(--color-text-primary)";
  const bg    = warn && value > 0 ? "rgba(var(--color-accent-red-rgb,239,68,68),0.07)" : "var(--color-card)";

  return (
    <div style={{
      background: bg, border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-lg)", padding: "16px 18px",
      display: "flex", flexDirection: "column", gap: "6px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--color-text-secondary)", fontSize: "12px" }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: "28px", fontWeight: 700, letterSpacing: "-0.5px", color }}>
        {value.toLocaleString()}{unit && <span style={{ fontSize: "14px", fontWeight: 400, marginLeft: "2px" }}>{unit}</span>}
      </div>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>{desc}</div>
    </div>
  );
}

// ─── Setup instructions ───────────────────────────────────────────────────────
function SetupGuide() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(true);

  const steps = [
    { n: 1, text: t("clarityStep1"), link: "https://clarity.microsoft.com", linkLabel: "clarity.microsoft.com" },
    { n: 2, text: t("clarityStep2") },
    { n: 3, text: t("clarityStep3") },
    { n: 4, text: t("clarityStep4") },
    { n: 5, text: t("clarityStep5") },
    { n: 6, text: t("clarityStep6") },
  ];

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", overflow: "hidden", marginBottom: "24px" }}>
      {/* Header */}
      <button onClick={() => setOpen(o => !o)} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", padding: "14px 18px",
        background: "var(--color-card)", border: "none", cursor: "pointer",
        color: "var(--color-text-primary)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 600, fontSize: "14px" }}>
          <BookOpen size={16} color="var(--color-accent-blue)" />
          {t("claritySetupTitle")}
        </div>
        {open ? <ChevronUp size={16} color="var(--color-text-secondary)" /> : <ChevronDown size={16} color="var(--color-text-secondary)" />}
      </button>

      {open && (
        <div style={{ padding: "6px 18px 18px", background: "var(--color-card)", borderTop: "1px solid var(--color-border-soft)" }}>
          {/* What is / Why */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px", marginTop: "12px" }}>
            {[
              { title: t("clarityWhatIsTitle"), text: t("clarityWhatIsText") },
              { title: t("clarityWhyTitle"),    text: t("clarityWhyText") },
            ].map(({ title, text }) => (
              <div key={title} style={{
                background: "var(--color-bg)", border: "1px solid var(--color-border-soft)",
                borderRadius: "var(--radius-md)", padding: "12px 14px",
              }}>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-accent-blue)", marginBottom: "6px" }}>{title}</div>
                <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{text}</div>
              </div>
            ))}
          </div>

          {/* Steps */}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {steps.map(s => (
              <div key={s.n} style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                <div style={{
                  minWidth: "22px", height: "22px", borderRadius: "50%",
                  background: "var(--color-accent-blue)", color: "#fff",
                  fontSize: "11px", fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  {s.n}
                </div>
                <div style={{ fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.5, paddingTop: "2px" }}>
                  {s.text}
                  {s.link && (
                    <> — <a href={s.link} target="_blank" rel="noopener noreferrer"
                      style={{ color: "var(--color-accent-blue)", textDecoration: "none" }}>
                      {s.linkLabel} <ExternalLink size={10} style={{ display: "inline", verticalAlign: "middle" }} />
                    </a></>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* API limit note */}
          <div style={{
            marginTop: "14px", padding: "8px 12px",
            background: "rgba(255,159,10,0.08)", border: "1px solid rgba(255,159,10,0.25)",
            borderRadius: "var(--radius-md)", fontSize: "12px", color: "var(--color-accent-orange)",
            display: "flex", alignItems: "center", gap: "6px",
          }}>
            <Info size={12} /> {t("clarityApiLimit")}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function ClarityPanel({ siteDbId, domain }: { siteDbId: string; domain?: string }) {
  const { t, language } = useLanguage();
  const [copied, setCopied] = useState(false);

  const [configured, setConfigured]     = useState(false);
  const [snapshot, setSnapshot]         = useState<Snapshot | null>(null);
  const [loading, setLoading]           = useState(true);
  const [fetching, setFetching]         = useState(false);
  const [saving, setSaving]             = useState(false);
  const [saved, setSaved]               = useState(false);
  const [fetchError, setFetchError]     = useState<string | null>(null);

  const [tokenInput, setTokenInput]     = useState("");
  const [projectIdInput, setProjectIdInput] = useState("");
  const [showToken, setShowToken]       = useState(false);
  const [projectId, setProjectId]       = useState<string | null>(null);

  const [aiAnalysis, setAiAnalysis]     = useState<string | null>(null);
  const [aiLoading, setAiLoading]       = useState(false);
  const [aiError, setAiError]           = useState(false);
  const [aiErrorMsg, setAiErrorMsg]     = useState<string | null>(null);

  const [aggregate, setAggregate]       = useState<Aggregate | null>(null);
  const [interval, setIntervalVal]      = useState<string>("disabled");
  const [savingInterval, setSavingInterval] = useState(false);

  // ── Load config + latest snapshot + 30-day aggregate ───────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/clarity?siteId=${siteDbId}`);
      if (!res.ok) return;
      const data = await res.json();
      setConfigured(data.configured);
      setProjectId(data.clarityProjectId);
      if (data.clarityProjectId) setProjectIdInput(data.clarityProjectId);
      if (data.snapshot) setSnapshot(data.snapshot);
      setAggregate(data.aggregate ?? null);
      setIntervalVal(data.clarityInterval ?? "disabled");
    } finally {
      setLoading(false);
    }
  }, [siteDbId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Save token + projectId ──────────────────────────────────────────────────
  const handleSave = async () => {
    if (!tokenInput.trim() && !projectIdInput.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/clarity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteId: siteDbId, action: "save",
          clarityToken: tokenInput.trim() || undefined,
          clarityProjectId: projectIdInput.trim() || undefined,
        }),
      });
      if (res.ok) {
        setSaved(true);
        setConfigured(true);
        setProjectId(projectIdInput.trim());
        setTimeout(() => setSaved(false), 3000);
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Toggle daily auto-collect ────────────────────────────────────────────────
  const changeInterval = async (value: string) => {
    setIntervalVal(value);
    setSavingInterval(true);
    try {
      await fetch("/api/clarity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, action: "save", clarityInterval: value }),
      });
    } finally {
      setSavingInterval(false);
    }
  };

  // ── Fetch fresh Clarity data ────────────────────────────────────────────────
  const handleFetch = async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/clarity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId: siteDbId, action: "fetch", numOfDays: 1 }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "rate_limit") setFetchError("⚠️ " + data.message);
        else if (data.error === "unauthorized") setFetchError("❌ Invalid token");
        else setFetchError(data.message ?? "Error");
        return;
      }
      setConfigured(true);
      await loadData(); // refresh snapshot + aggregate
    } finally {
      setFetching(false);
    }
  };

  // ── AI analysis ─────────────────────────────────────────────────────────────
  const handleAiAnalysis = async () => {
    if (!aggregate) return;
    const view = aggregate;
    setAiLoading(true);
    setAiError(false);
    setAiErrorMsg(null);
    setAiAnalysis(null);
    try {
      const provider = localStorage.getItem("aiProvider") || "anthropic";
      const apiKey = localStorage.getItem(`aiKey_${provider}`) || localStorage.getItem("aiApiKey") || "";

      const raw = JSON.stringify(snapshot?.data.traffic ?? []).slice(0, 6000);
      const site = domain || projectId || "the site";

      // Slavic plural agreement (1 сессия / 2 сессии / 5 сессий).
      const plural = (n: number, forms: [string, string, string]) => {
        const n10 = n % 10, n100 = n % 100;
        if (n10 === 1 && n100 !== 11) return forms[0];
        if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
        return forms[2];
      };

      // Localized output strings: section titles must match the UI language so
      // an English/Ukrainian user never gets a Russian-titled report.
      const PROMPT_I18N = {
        en: {
          langName: "English",
          auditTitle: "UX Audit",
          periodLine: (d: number) => `Period: ${d} day(s) of collected data`,
          sSummary: "🎯 Summary",
          sCritical: "🔴 Critical findings (where money is lost)",
          sCheck: "⚠️ Worth checking",
          sRecs: "✅ Recommendations",
          lowSample: (n: number) =>
            `Note: the sample is small (${n} ${n === 1 ? "session" : "sessions"}) — treat all conclusions as preliminary, not statistically reliable.`,
        },
        ru: {
          langName: "Russian",
          auditTitle: "UX-аудит",
          periodLine: (d: number) => `Период: ${d} дн. собранных данных`,
          sSummary: "🎯 Краткая сводка",
          sCritical: "🔴 Критические находки (где теряем деньги)",
          sCheck: "⚠️ Что стоит проверить",
          sRecs: "✅ Рекомендации",
          lowSample: (n: number) =>
            `Примечание: выборка маленькая (${n} ${plural(n, ["сессия", "сессии", "сессий"])}) — все выводы предварительные, статистически недостоверные.`,
        },
        uk: {
          langName: "Ukrainian",
          auditTitle: "UX-аудит",
          periodLine: (d: number) => `Період: ${d} дн. зібраних даних`,
          sSummary: "🎯 Короткий підсумок",
          sCritical: "🔴 Критичні знахідки (де втрачаємо гроші)",
          sCheck: "⚠️ Що варто перевірити",
          sRecs: "✅ Рекомендації",
          lowSample: (n: number) =>
            `Примітка: вибірка мала (${n} ${plural(n, ["сесія", "сесії", "сесій"])}) — усі висновки попередні, статистично недостовірні.`,
        },
      } as const;

      const L = PROMPT_I18N[language as "en" | "ru" | "uk"] ?? PROMPT_I18N.en;

      const sessionsVal = Number(view.metrics.find(m => m.name === "sessions")?.value ?? 0);
      const lowSample = sessionsVal > 0 && sessionsVal < 100;

      const prompt = `You are a senior CRO (Conversion Rate Optimization) and SEO expert analyzing Microsoft Clarity UX data for ${site}. Produce a client-ready audit grounded ONLY in the data provided below.

WHAT YOU HAVE: aggregated Clarity metrics (counts/averages) and a list of page URLs. WHAT YOU DO NOT HAVE: session recordings, click coordinates, screenshots, or the HTML/content of any page. You have NOT seen any page. This is critical.

STRICT TRUTH RULES — follow exactly:
- Never state as fact what is physically on a page (e.g. "the page has no CTA", "broken widget", "banner without link", "page layout is X"). You cannot see pages. If you propose such a cause, you MUST label it as an unverified hypothesis to check manually (in the output language, e.g. "гипотеза — проверьте вручную").
- Do NOT invent numbers. Only cite numbers that appear in the data below. Do NOT fabricate per-session events, dates, timings ("user left after 6 sec"), or money/lead estimates ("lose 2-3 leads/week", "X% of clients"). The API does not contain this. If you discuss business impact, keep it qualitative, not numeric.
- Distinguish clearly between FACTS (numbers from the data) and HYPOTHESES (your interpretation). Lead each interpretation with a hedge word.
${lowSample ? `- SMALL SAMPLE: only ${sessionsVal} sessions. Soften every conclusion accordingly. Do NOT write a sample-size disclaimer yourself — it is added automatically, so do not mention sample size or statistical reliability.` : ""}

METRIC GLOSSARY (read carefully — misreading these is the most common error): every count is a TOTAL over the whole collected period, summed across ALL sessions and pages — it is NEVER a per-session value. "sessions" = total sessions in the period. "dead" / "rage" / "quickback" / "excessive" / "errors" = the total number of such events across all those sessions ("excessive" = excessive-scrolling events, i.e. users scrolling frantically because they are lost). "scroll" = average scroll depth in %. "engagement" = average engagement time in seconds. Example: "dead": 4 with "sessions": 91 means 4 dead-click events occurred across 91 sessions total (~4% of sessions) — it does NOT mean 4 per session. RULE: whenever you cite a count, relate it to total sessions (e.g. "4 of 91 sessions"), and never describe a small share as "high"/"высокий"; describe magnitude honestly (low/moderate/high) relative to the session total.

DATA-FIELD RULE: "sessions" and "page views" are different things — never call sessions "views"/"просмотры" or vice versa. In the raw per-URL data, "totalSessionCount" = sessions, "pagesViews" = page views; use the correct word for whichever you cite. GRAMMAR: in prose, decline the word for "sessions" correctly for the number (in Russian: 1 сессия, 2 сессии, 5 сессий, 91 сессия).

LANGUAGE RULE (critical): Write the ENTIRE report in ${L.langName} only. Do NOT switch languages mid-text, do NOT insert words from other languages, and never output Chinese/Japanese/Korean characters. Every section title must be reproduced EXACTLY as given below, verbatim.

Structure the report exactly like this:
1) Title line: "${L.auditTitle} — ${site}". Second line: "${L.periodLine(view.daysCovered)}".
2) "${L.sSummary}" — 2-3 sentences on the overall picture, numbers only from the data.
3) "${L.sCritical}" — the 1-3 biggest data-supported issues. For each: the problem (with the actual metric/number), the most likely root cause clearly marked as a hypothesis to verify, and a concrete fix.
4) "${L.sCheck}" — secondary things to check (clearly framed as "check", not as established facts).
5) "${L.sRecs}" — prioritized next steps.

Use relevant emoji as accents (🎯 🔴 ⚠️ ✅ 🖱️ 📊 📉 💰). Do NOT use Markdown: no "#", no "*", no "**", no backticks, no tables. Each section title on its own line; list items start with "- ".

Summary metrics (aggregated over ${view.daysCovered} day(s)): ${JSON.stringify(view.metrics)}. Top problem pages: ${JSON.stringify(view.pages)}. Raw per-URL data (latest day): ${raw}`;

      const model = localStorage.getItem(`aiModel_${provider}`) || undefined;
      const baseUrl = localStorage.getItem(`aiBaseUrl_${provider}`) || undefined;
      const res = await fetch("/api/gsc/ai-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, aiProvider: provider, aiApiKey: apiKey, model, aiBaseUrl: baseUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAiErrorMsg(data?.error === "no_ai_key" ? t("clarityNoAiKey") : t("clarityAnalysisError"));
        setAiError(true);
        return;
      }
      // Inject the exact small-sample disclaimer right under the summary header
      // (deterministic wording — the model is told not to write it itself).
      let report = cleanReport(data.summary ?? "");
      if (lowSample) {
        const note = L.lowSample(sessionsVal);
        const idx = report.indexOf(L.sSummary);
        if (idx !== -1) {
          const at = idx + L.sSummary.length;
          report = report.slice(0, at) + "\n" + note + report.slice(at);
        } else {
          report = note + "\n\n" + report;
        }
      }
      setAiAnalysis(report);
    } catch {
      setAiErrorMsg(t("clarityAnalysisError"));
      setAiError(true);
    } finally {
      setAiLoading(false);
    }
  };

  // ── Report export helpers ────────────────────────────────────────────────────
  const reportHeader = () => {
    const date = snapshot ? new Date(snapshot.fetchedAt).toLocaleString() : new Date().toLocaleString();
    const proj = projectId ? ` · ${projectId}` : "";
    return `${t("clarityReportTitle")}${proj}\n${date}\n${"-".repeat(48)}\n\n`;
  };

  const copyReport = async () => {
    if (!aiAnalysis) return;
    try {
      await navigator.clipboard.writeText(aiAnalysis);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const downloadTxt = () => {
    if (!aiAnalysis) return;
    const blob = new Blob([reportHeader() + aiAnalysis], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clarity-ux-report-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Dependency-free PDF: open a clean print window; the user saves as PDF.
  const downloadPdf = () => {
    if (!aiAnalysis) return;
    const w = window.open("", "_blank");
    if (!w) return;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const date = snapshot ? new Date(snapshot.fetchedAt).toLocaleString() : new Date().toLocaleString();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t("clarityReportTitle"))}</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:720px;margin:40px auto;padding:0 24px;line-height:1.6;font-size:14px}
        h1{font-size:18px;margin:0 0 2px} .meta{color:#666;font-size:12px;margin-bottom:20px;border-bottom:1px solid #ddd;padding-bottom:12px}
        pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:14px;margin:0}
      </style></head><body>
      <h1>${esc(t("clarityReportTitle"))}${projectId ? " · " + esc(projectId) : ""}</h1>
      <div class="meta">${esc(date)}</div>
      <pre>${esc(aiAnalysis)}</pre>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
  };

  // Download the exact raw Clarity API response (what the panel stored) so any
  // metric in an AI report can be verified against the source data.
  const downloadRawJson = () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot.data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clarity-raw-${projectId || "data"}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Derived metrics (aggregated across collected snapshots) ──────────────────
  const parsed = aggregate;

  const metricDefs = [
    { name: "dead",       icon: <MousePointerClick size={14} />, label: t("clarityMetricDeadClicks"),  desc: t("clarityMetricDeadClicksDesc"),  warn: true },
    { name: "rage",       icon: <AlertCircle size={14} />,       label: t("clarityMetricRageClicks"),   desc: t("clarityMetricRageClicksDesc"),  warn: true },
    { name: "quickback",  icon: <ArrowLeft size={14} />,         label: t("clarityMetricQuickback"),    desc: t("clarityMetricQuickbackDesc"),   warn: true },
    { name: "excessive",  icon: <ChevronsDown size={14} />,      label: t("clarityMetricExcessiveScroll"), desc: t("clarityMetricExcessiveScrollDesc"), warn: true },
    { name: "scroll",     icon: <ScrollText size={14} />,        label: t("clarityMetricScroll"),       desc: t("clarityMetricScrollDesc"),      warn: false },
    { name: "sessions",   icon: <Users size={14} />,             label: t("clarityMetricSessions"),     desc: "",                                warn: false },
    { name: "engagement", icon: <Clock size={14} />,             label: t("clarityMetricEngagement"),   desc: "",                                warn: false },
    { name: "errors",     icon: <Code2 size={14} />,             label: t("clarityMetricErrors"),       desc: "",                                warn: true },
  ];

  if (loading) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "14px" }}>
        <RefreshCw size={20} style={{ animation: "spin 1s linear infinite", marginBottom: "8px" }} />
        <div>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 32px 40px" }}>
      {/* Page header */}
      <div style={{ marginBottom: "24px" }}>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.3px", margin: 0 }}>
          {t("clarityTitle")}
        </h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "4px 0 0" }}>
          {t("claritySubtitle")}
        </p>
      </div>

      {/* Setup guide (collapsible) */}
      <SetupGuide />

      {/* Token config form */}
      <div style={{
        background: "var(--color-card)", border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)", padding: "20px", marginBottom: "24px",
      }}>
        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
          <Info size={14} color="var(--color-accent-blue)" />
          {configured ? `✅ ${t("clarityConnected")}` : t("clarityNotConfigured")}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "14px" }}>
          {/* Token field */}
          <div>
            <label style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", display: "block", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {t("clarityTokenLabel")}
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showToken ? "text" : "password"}
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder={t("clarityTokenPlaceholder")}
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "8px 36px 8px 10px", borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border)", background: "var(--color-bg)",
                  color: "var(--color-text-primary)", fontSize: "13px",
                }}
              />
              <button onClick={() => setShowToken(s => !s)} style={{
                position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 0,
              }}>
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Project ID field */}
          <div>
            <label style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", display: "block", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {t("clarityProjectIdLabel")}
            </label>
            <input
              type="text"
              value={projectIdInput}
              onChange={e => setProjectIdInput(e.target.value)}
              placeholder={t("clarityProjectIdPlaceholder")}
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 10px", borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)", background: "var(--color-bg)",
                color: "var(--color-text-primary)", fontSize: "13px",
              }}
            />
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={handleSave} disabled={saving || (!tokenInput.trim() && !projectIdInput.trim())} style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "8px 18px", borderRadius: "9999px",
            background: "var(--color-accent-blue)", color: "#fff",
            border: "none", fontSize: "13px", fontWeight: 500, cursor: "pointer",
            opacity: saving || (!tokenInput.trim() && !projectIdInput.trim()) ? 0.5 : 1,
          }}>
            <Save size={13} />
            {saved ? t("claritySaved") : saving ? t("claritySaving") : t("claritySave")}
          </button>

          <button onClick={handleFetch} disabled={fetching || !configured} style={{
            display: "flex", alignItems: "center", gap: "6px",
            padding: "8px 18px", borderRadius: "9999px",
            background: "transparent", color: "var(--color-text-primary)",
            border: "1px solid var(--color-border)", fontSize: "13px", fontWeight: 500, cursor: "pointer",
            opacity: fetching || !configured ? 0.5 : 1,
          }}>
            <RefreshCw size={13} style={fetching ? { animation: "spin 1s linear infinite" } : {}} />
            {fetching ? t("clarityFetching") : snapshot ? t("clarityRefresh") : t("clarityFetch")}
          </button>

          {/* Auto-collect toggle */}
          {configured && (
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }} title={t("clarityAutoCollectHint")}>
              <Clock size={13} /> {t("clarityAutoCollect")}
              <select value={interval} onChange={e => changeInterval(e.target.value)} disabled={savingInterval}
                style={{ fontSize: "12px", padding: "4px 8px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", cursor: "pointer" }}>
                <option value="disabled">{t("clarityAutoOff")}</option>
                <option value="daily">{t("clarityAutoDaily")}</option>
              </select>
            </label>
          )}

          {projectId && (
            <a href={`https://clarity.microsoft.com/projects/view/${projectId}/dashboard`}
              target="_blank" rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "center", gap: "5px",
                fontSize: "12px", color: "var(--color-accent-blue)", textDecoration: "none",
              }}>
              <ExternalLink size={12} /> {t("clarityOpen")}
            </a>
          )}

          {snapshot && (
            <button onClick={downloadRawJson} style={ghostBtn} title="Raw Clarity API response (for verifying AI report claims)">
              <Code2 size={12} /> {t("clarityDownloadRaw")}
            </button>
          )}

          {snapshot && (
            <span style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginLeft: "auto" }}>
              {t("clarityLastUpdate")} {new Date(snapshot.fetchedAt).toLocaleString()}
            </span>
          )}
        </div>

        {fetchError && (
          <div style={{ marginTop: "10px", padding: "8px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "var(--radius-md)", fontSize: "12px", color: "var(--color-accent-red)" }}>
            {fetchError}
          </div>
        )}
      </div>

      {/* No data placeholder */}
      {!snapshot && (
        <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--color-text-secondary)", fontSize: "14px" }}>
          <MousePointerClick size={36} style={{ opacity: 0.3, marginBottom: "12px" }} />
          <div>{configured ? t("clarityNoData") : t("clarityNotConfigured")}</div>
        </div>
      )}

      {/* Metrics grid */}
      {parsed && (
        <>
          <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "10px" }}>
            {t("clarityCoverage")}: {parsed.daysCovered} {parsed.daysCovered === 1 ? t("clarityDay") : t("clarityDays")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px", marginBottom: "24px" }}>
            {metricDefs.map(def => {
              const m = parsed.metrics.find(x => x.name === def.name);
              return (
                <MetricCard
                  key={def.name}
                  icon={def.icon}
                  label={def.label}
                  desc={def.desc}
                  value={Number(m?.value ?? 0)}
                  unit={m?.unit}
                  warn={def.warn}
                />
              );
            })}
          </div>

          {/* Top problem pages table */}
          {parsed.pages.length > 0 && (
            <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", overflow: "hidden", marginBottom: "24px" }}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--color-border-soft)", fontWeight: 600, fontSize: "14px", color: "var(--color-text-primary)" }}>
                {t("clarityTopPages")}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ background: "var(--color-bg)" }}>
                      {[t("clarityColUrl"), t("clarityColDead"), t("clarityColRage"), t("clarityColScroll"), t("clarityColSessions")].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: h === t("clarityColUrl") ? "left" : "right", color: "var(--color-text-secondary)", fontWeight: 500, fontSize: "11px", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.pages.map((p, i) => (
                      <tr key={p.url} style={{ borderTop: "1px solid var(--color-border-soft)", background: i % 2 === 0 ? "transparent" : "var(--color-bg)" }}>
                        <td style={{ padding: "8px 12px", color: "var(--color-text-primary)", maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span title={p.url}>{p.url.replace(/^https?:\/\/[^/]+/, "")}</span>
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right", color: p.deadClicks > 0 ? "var(--color-accent-red)" : "var(--color-text-secondary)", fontWeight: p.deadClicks > 0 ? 600 : 400 }}>
                          {p.deadClicks}
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right", color: p.rageClicks > 0 ? "var(--color-accent-orange)" : "var(--color-text-secondary)", fontWeight: p.rageClicks > 0 ? 600 : 400 }}>
                          {p.rageClicks}
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--color-text-primary)" }}>
                          {p.scrollDepth > 0 ? `${p.scrollDepth}%` : "—"}
                        </td>
                        <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--color-text-secondary)" }}>
                          {p.sessions.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* AI Analysis section */}
          <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: aiAnalysis ? "14px" : 0 }}>
              <div style={{ fontWeight: 600, fontSize: "14px", color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: "6px" }}>
                <Sparkles size={15} color="var(--color-accent-blue)" />
                {t("clarityAnalysisTitle")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {aiAnalysis && (
                  <>
                    <button onClick={copyReport} style={ghostBtn}>
                      {copied ? `✓ ${t("clarityCopied")}` : t("clarityCopy")}
                    </button>
                    <button onClick={downloadTxt} style={ghostBtn}>{t("clarityDownloadTxt")}</button>
                    <button onClick={downloadPdf} style={ghostBtn}>{t("clarityDownloadPdf")}</button>
                  </>
                )}
                <button onClick={handleAiAnalysis} disabled={aiLoading} style={{
                  display: "flex", alignItems: "center", gap: "6px",
                  padding: "7px 16px", borderRadius: "9999px",
                  background: "var(--color-accent-blue)", color: "#fff",
                  border: "none", fontSize: "12px", fontWeight: 500, cursor: "pointer",
                  opacity: aiLoading ? 0.6 : 1,
                }}>
                  <Sparkles size={12} />
                  {aiLoading ? t("clarityAnalyzing") : t("clarityAnalyzeBtn")}
                </button>
              </div>
            </div>

            {aiError && (
              <div style={{ padding: "10px 12px", background: "rgba(239,68,68,0.08)", borderRadius: "var(--radius-md)", fontSize: "13px", color: "var(--color-accent-red)" }}>
                {aiErrorMsg ?? t("clarityAnalysisError")}
              </div>
            )}

            {aiAnalysis && (
              <div style={{
                padding: "14px 16px", background: "var(--color-bg)",
                border: "1px solid var(--color-border-soft)", borderRadius: "var(--radius-md)",
                fontSize: "13px", color: "var(--color-text-primary)", lineHeight: 1.7,
                whiteSpace: "pre-wrap",
              }}>
                {aiAnalysis}
              </div>
            )}

            {!aiAnalysis && !aiError && (
              <p style={{ margin: "10px 0 0", fontSize: "12px", color: "var(--color-text-secondary)" }}>
                {t("claritySubtitle")}
              </p>
            )}
          </div>
        </>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
