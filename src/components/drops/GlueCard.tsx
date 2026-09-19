"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Check, Copy, Link2, Loader2, Plus, ShieldCheck, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { readUrlParam } from "@/lib/urlParam";
// Pure, client-safe core pieces only: the fetcher/validator stay server-side (safeFetch
// pulls node built-ins), the card imports nothing heavier than locale math and types.
import { checkLocale } from "@/lib/drops/glue/locale";
import type { GlueMode, GluePlan, GlueReport, PageFacts, Severity } from "@/lib/drops/glue/types";

type Alt = { hreflang: string; url: string };

const ghostBtn = (disabled: boolean): CSSProperties => ({
  display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
  border: "1px solid var(--color-border)", background: "transparent",
  color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
  fontSize: 12, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
});

const primaryBtn: CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, padding: "7px 14px", borderRadius: 9,
  border: "none", background: "var(--color-accent-blue)", color: "#fff",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};

const preBlock: CSSProperties = {
  margin: 0, padding: 0, maxHeight: 190, overflow: "auto", fontSize: 11.5,
  fontFamily: "ui-monospace, monospace", color: "var(--color-text-secondary)",
  whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.55,
};

const SEV_COLOR: Record<Severity, string> = {
  blocker: "#ff6b62",
  warn: "var(--color-accent-orange, #ff9f0a)",
  info: "var(--color-text-tertiary)",
};

const isHttp = (v: string) => /^https?:\/\//i.test(v.trim());

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/**
 * The «Склейка» card of the Activation tab: build the hreflang/canonical blocks for a
 * drop ↔ money-site cluster, then check the live pages (optionally as the bot). Phase 1 is
 * stateless on purpose — the plan lives in the form, the report in the response; nothing
 * touches the database until the SERP-Monitor tie-in in phase 2.
 */
export default function GlueCard() {
  const { t } = useLanguage();
  const tr = (k: string) => t(k as never) as string;

  // A row of the catalogue sends its domain over as ?glue= — the card keeps it as a
  // one-click prefill rather than silently editing the form behind the user's back.
  // Read after mount, never during render: the server renders without the param, and a
  // cold load with ?glue= present would mismatch the SSR HTML (React #418) — the same
  // reason the site page reads its deep-link tab in an effect.
  const [candidate, setCandidate] = useState<string | null>(null);
  useEffect(() => { setCandidate(readUrlParam("glue")); }, []);

  const [dropUrl, setDropUrl] = useState("");
  const [dropLang, setDropLang] = useState("");
  const [xDefault, setXDefault] = useState("");
  const [mode, setMode] = useState<GlueMode>("cluster");
  const [alts, setAlts] = useState<Alt[]>([{ hreflang: "en-GB", url: "" }]);

  const [busy, setBusy] = useState<"plan" | "check" | "bot" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<GluePlan | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [checkRes, setCheckRes] = useState<{ report: GlueReport; facts: PageFacts[] } | null>(null);

  const filled = alts.filter(a => a.hreflang.trim() && isHttp(a.url));
  const canBuild = isHttp(dropUrl) && filled.length > 0;

  const build = async () => {
    if (!canBuild || busy) return;
    setBusy("plan");
    setErr(null);
    const res = await fetch("/api/drops/glue?action=plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        dropUrl,
        alternates: filled,
        ...(dropLang.trim() ? { dropHtmlLang: dropLang } : {}),
        ...(xDefault.trim() ? { xDefault } : {}),
      }),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.status !== 200) {
      setErr(`${body.error ?? `HTTP ${res.status}`}`);
      return;
    }
    setPlan(body.plan as GluePlan);
    setPageIdx(0);
    setCheckRes(null);
  };

  const runCheck = async (ua: "browser" | "both") => {
    if (!plan || busy) return;
    setBusy(ua === "both" ? "bot" : "check");
    setErr(null);
    const res = await fetch("/api/drops/glue?action=check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: plan.mode,
        urls: plan.pages.map(p => p.url),
        plan,
        ua,
      }),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.status !== 200) {
      setErr(`${body.error ?? `HTTP ${res.status}`}`);
      return;
    }
    setCheckRes({ report: body.report as GlueReport, facts: (body.facts ?? []) as PageFacts[] });
  };

  const copyHead = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* private mode: the button just doesn't light up */ }
  };

  const page = plan?.pages[Math.min(pageIdx, plan.pages.length - 1)] ?? null;
  const pageFindings = checkRes && page
    ? checkRes.report.findings.filter(f => f.page === page.url)
    : [];

  return <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Link2 size={15} style={{ color: "var(--color-accent-blue)" }} />
      <b style={{ fontSize: 14, color: "var(--color-text-primary)" }}>{t("dropsGlue_title")}</b>
      <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>{t("dropsGlue_hint")}</span>
    </div>

    {/* Form */}
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="tool-input" style={{ fontSize: 12, width: 250 }} placeholder={t("dropsGlue_drop_ph")}
          value={dropUrl} onChange={e => { setDropUrl(e.target.value); setErr(null); }} />
        {candidate && <button
          onClick={() => setDropUrl(`https://${candidate}/`)}
          title={candidate} style={ghostBtn(false)}>
          {t("dropsGlue_from_candidate")}
        </button>}
      </div>

      {alts.map((a, i) => {
        const check = a.hreflang.trim() ? checkLocale(a.hreflang) : null;
        const fixed = check && !check.valid && check.suggestion;
        const invalid = check && !check.valid && !check.suggestion;
        return <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input className="tool-input" style={{ fontSize: 12, width: 110 }} placeholder={t("dropsGlue_locale_ph")}
              value={a.hreflang} onChange={e => {
                const next = [...alts];
                next[i] = { ...a, hreflang: e.target.value };
                setAlts(next);
              }} />
            <input className="tool-input" style={{ fontSize: 12, flex: 1, minWidth: 220 }} placeholder={t("dropsGlue_url_ph")}
              value={a.url} onChange={e => {
                const next = [...alts];
                next[i] = { ...a, url: e.target.value };
                setAlts(next);
              }} />
            <button
              onClick={() => setAlts(alts.length > 1 ? alts.filter((_, j) => j !== i) : alts)}
              disabled={alts.length <= 1} aria-label="remove" style={ghostBtn(alts.length <= 1)}>
              <X size={12} />
            </button>
          </div>
          {/* Live locale feedback — the same fix/invalid split the generator reports as
              notes, shown before submission so the input can be corrected in place. */}
          {fixed && <span style={{ fontSize: 11, color: "var(--color-accent-orange, #ff9f0a)" }}>
            {tr("dropsGlueNote_locale_fixed")}: {a.hreflang} → {check!.suggestion}{check!.reason ? ` (${check!.reason})` : ""}
          </span>}
          {invalid && <span style={{ fontSize: 11, color: "#ff6b62" }}>
            {tr("dropsGlueNote_locale_invalid")}{check!.reason ? `: ${check!.reason}` : ""}
          </span>}
        </div>;
      })}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => setAlts([...alts, { hreflang: "", url: "" }])} style={ghostBtn(false)}>
          <Plus size={12} />{t("dropsGlue_add_alt")}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-text-secondary)" }}>
          {t("dropsGlue_mode")}
          <select className="tool-input" style={{ fontSize: 12 }} value={mode}
            onChange={e => setMode(e.target.value as GlueMode)}>
            <option value="cluster">{t("dropsGlue_mode_cluster")}</option>
            <option value="funnel">{t("dropsGlue_mode_funnel")}</option>
          </select>
        </label>
        <input className="tool-input" style={{ fontSize: 12, width: 200 }} placeholder={t("dropsGlue_drop_lang_ph")}
          value={dropLang} onChange={e => setDropLang(e.target.value)} />
        <input className="tool-input" style={{ fontSize: 12, width: 200 }} placeholder={t("dropsGlue_xdefault")}
          value={xDefault} onChange={e => setXDefault(e.target.value)} />
        <button onClick={() => void build()} disabled={!canBuild || busy !== null}
          style={{ ...primaryBtn, opacity: !canBuild || busy !== null ? 0.5 : 1 }}>
          {busy === "plan" ? <Loader2 size={13} className="spin" /> : null}
          {t("dropsGlue_build")}
        </button>
      </div>

      {/* The risk line lives in the form, always on in funnel mode — not in a tooltip. */}
      {mode === "funnel" && <div style={{
        fontSize: 12, lineHeight: 1.6, color: "var(--color-accent-orange, #ff9f0a)",
        border: "1px solid var(--color-accent-orange, #ff9f0a)", borderRadius: 8, padding: "8px 10px",
      }}>
        {t("dropsGlue_funnel_risk")}
      </div>}

      {err && <div style={{ fontSize: 12.5, color: "#ff6b62" }}>
        {t("dropsGlue_err").replace("{err}", err)}
      </div>}
    </div>

    {/* Result */}
    {plan && <div style={{
      display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 9,
      border: "1px solid var(--color-border)", background: "var(--color-card)",
    }}>
      {/* Generator notes: colour by severity, verbatim detail. */}
      {plan.notes.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {plan.notes.map((n, i) => <span key={i} style={{ fontSize: 11.5, color: SEV_COLOR[n.severity] }}>
          {tr(`dropsGlueNote_${n.code}`)}{n.detail ? ` — ${n.detail}` : ""}
        </span>)}
      </div>}

      {/* One tab per page. After a check the chip carries the live HTTP status. */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {plan.pages.map((p, i) => {
          const fact = checkRes?.facts.find(f => f.requestedUrl === p.url);
          const dead = fact && (fact.status >= 400 || fact.status === 0);
          return <button key={p.url} onClick={() => setPageIdx(i)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8,
            fontSize: 11.5, cursor: "pointer",
            border: `1px solid ${i === pageIdx ? "var(--color-accent-blue)" : "var(--color-border)"}`,
            color: i === pageIdx ? "var(--color-text-primary)" : "var(--color-text-secondary)",
          }}>
            <b>{tr(p.role === "drop" ? "dropsGlue_page_drop" : "dropsGlue_page_money")}</b>
            <span style={{ wordBreak: "break-all" }}>{shortUrl(p.url)}</span>
            {fact && <span style={{ color: dead ? "#ff6b62" : "var(--color-text-tertiary)" }}>
              HTTP {fact.status || "—"}
            </span>}
          </button>;
        })}
      </div>

      {page && <>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, color: "var(--color-text-tertiary)" }}>{t("dropsGlue_html_lang")}</span>
          <code style={{ fontSize: 11.5, color: "var(--color-text-secondary)" }}>
            &lt;html lang=&quot;{page.htmlLang}&quot;&gt;
          </code>
          <button onClick={() => void copyHead(page.head)} style={ghostBtn(false)}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t("dropsGlue_copied") : t("dropsGlue_copy")}
          </button>
        </div>
        <pre style={preBlock}>{page.head}</pre>
      </>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => void runCheck("browser")} disabled={busy !== null} style={ghostBtn(busy !== null)}>
          {busy === "check" ? <Loader2 size={12} className="spin" /> : null}
          {t("dropsGlue_check_live")}
        </button>
        <button onClick={() => void runCheck("both")} disabled={busy !== null} style={ghostBtn(busy !== null)}>
          {busy === "bot" ? <Loader2 size={12} className="spin" /> : null}
          {t("dropsGlue_check_bot")}
        </button>
      </div>

      {checkRes && <>
        {checkRes.report.ok
          ? <div style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 12.5,
            color: "var(--color-accent-green, #34c759)",
          }}>
            <ShieldCheck size={14} />{t("dropsGlue_ok")}
          </div>
          : <div style={{ display: "flex", gap: 10, fontSize: 12, color: "var(--color-text-tertiary)" }}>
            {(["blocker", "warn", "info"] as Severity[]).map(s =>
              checkRes.report.counts[s] > 0
                ? <span key={s} style={{ color: SEV_COLOR[s] }}>
                  ● {checkRes.report.counts[s]}
                </span>
                : null)}
          </div>}

        {/* Findings of the selected page; every other page keeps its own under its tab. */}
        {pageFindings.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {pageFindings.map((f, i) => <span key={i} style={{ fontSize: 12, color: SEV_COLOR[f.severity] }}>
            {tr(`dropsGlueFinding_${f.code}`)}{f.detail ? ` — ${f.detail}` : ""}
          </span>)}
        </div>}
      </>}
    </div>}
  </div>;
}
