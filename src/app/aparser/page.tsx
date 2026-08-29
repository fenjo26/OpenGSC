"use client";

// The A-Parser console.
//
// Every other data source in this app is somebody else's server, and there is nothing to show
// about it beyond a balance. This one is a machine the user owns, and the questions it raises
// are the ones no other screen in the product can answer: is it up, what is it doing right now,
// which of its 138 parsers does this build actually have, and are there any proxies behind it.
// That last pair is the point — with a metered API, result quality is the vendor's problem;
// here it is the user's own infrastructure, so an empty proxy pool is the explanation for a
// whole class of downstream symptoms and deserves to be visible before they appear.
//
// The test query exists for a narrower reason: A-Parser's option ids (`pagecount`,
// `linksperpage`, …) are addressed internally but documented in prose, so reading a live preset
// is the only reliable way to learn them. It also shows `resultString` next to `results` under a
// warning, because "never parse the formatted string" is a rule that is much easier to keep when
// you can see how far apart the two can drift.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, CheckCircle2, Loader2, Play, RefreshCw, Search, Server, Settings2, XCircle,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { APARSER_CAPABILITIES } from "@/lib/seo/aparserCatalog";

interface Info {
  version: string; pid: string; activeThreads: number; workingTasks: number;
  tasksInQueue: number; activeProxyCheckerThreads: number; availableParsers: string[];
}

const POLL_MS = 15_000;

export default function AparserPage() {
  const { t } = useLanguage();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [host, setHost] = useState("");
  const [fromEnv, setFromEnv] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [proxies, setProxies] = useState<{ total: number; byType: Record<string, number> } | null>(null);
  const [filter, setFilter] = useState("");

  const [parser, setParser] = useState("SE::Google");
  const [query, setQuery] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [testOut, setTestOut] = useState<{ results: any[]; resultStringPreview: string } | null>(null);
  const [testErr, setTestErr] = useState("");
  const [preset, setPreset] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    setConfigured(!!localStorage.getItem("seoBaseUrl_aparser") && !!localStorage.getItem("seoKey_aparser"));
    // Show the last known parser list immediately: the whole screen is otherwise blank until a
    // round trip to a machine that may be asleep.
    try {
      const cached = JSON.parse(localStorage.getItem("seoAparserParsers") || "[]");
      if (Array.isArray(cached) && cached.length) {
        setInfo(prev => prev ?? ({ version: "", pid: "", activeThreads: 0, workingTasks: 0, tasksInQueue: 0, activeProxyCheckerThreads: 0, availableParsers: cached } as Info));
      }
    } catch { /* a corrupt cache is not worth a message */ }
  }, []);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch("/api/aparser", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store",
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(d?.error ?? res.status));
    return d;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await call({ op: "info" });
      setInfo(d.info); setHost(d.host || ""); setFromEnv(!!d.fromEnv); setError("");
      if (Array.isArray(d?.info?.availableParsers) && d.info.availableParsers.length) {
        try { localStorage.setItem("seoAparserParsers", JSON.stringify(d.info.availableParsers)); } catch {}
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
    setLoading(false);
  }, [call]);

  useEffect(() => {
    if (configured === null) return;
    if (!configured) { setLoading(false); return; }
    void refresh();
    call({ op: "proxies" }).then(d => setProxies({ total: d.total ?? 0, byType: d.byType ?? {} })).catch(() => setProxies(null));
    // Only while the tab is in front: this polls the user's own workstation, and a background
    // tab quietly knocking on it every fifteen seconds forever is not a thing to ship.
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [configured, refresh, call]);

  async function runTest() {
    if (!parser.trim() || !query.trim() || testBusy) return;
    setTestBusy(true); setTestErr(""); setTestOut(null); setPreset(null);
    try {
      const [out, pre] = await Promise.all([
        call({ op: "test", parser: parser.trim(), query: query.trim() }),
        call({ op: "preset", parser: parser.trim() }).catch(() => null),
      ]);
      setTestOut({ results: out.results ?? [], resultStringPreview: out.resultStringPreview ?? "" });
      if (pre?.preset) setPreset(pre.preset);
    } catch (e: any) {
      setTestErr(String(e?.message ?? e));
    }
    setTestBusy(false);
  }

  const installed = new Set(info?.availableParsers ?? []);
  const list = (info?.availableParsers ?? []).filter(p => !filter.trim() || p.toLowerCase().includes(filter.trim().toLowerCase()));

  if (configured === false) {
    return (
      <div style={{ maxWidth: "760px", margin: "40px auto", padding: "0 20px" }}>
        <Header t={t} host="" fromEnv={false} />
        <div className="panel" style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
          <AlertTriangle size={18} color="var(--color-accent-orange)" style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            <div style={{ fontSize: "13px", color: "var(--color-text-primary)", marginBottom: "6px" }}>{t("aparserNotConfigured")}</div>
            <Link href="/settings?tab=api-keys" style={{ fontSize: "13px", color: "var(--color-accent-blue)", textDecoration: "none" }}>{t("aparserOpenSettings")} →</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "1100px", margin: "28px auto", padding: "0 20px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <Header t={t} host={host} fromEnv={fromEnv} />

      {error && (
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: "10px", borderColor: "rgba(239,68,68,0.3)" }}>
          <XCircle size={16} color="#f87171" />
          <span style={{ fontSize: "12px", fontFamily: "monospace", color: "#f87171", wordBreak: "break-all" }}>{error}</span>
          <button onClick={() => void refresh()} style={btn}><RefreshCw size={12} /> {t("aparserRetry")}</button>
        </div>
      )}

      {/* ── Status ─────────────────────────────────────────────────────────── */}
      <div className="panel">
        <SectionTitle icon={<Server size={16} color="#e8452c" />} title={t("aparserStatusTitle")} sub={t("aparserStatusSub")} />
        {loading && !info ? (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--color-text-secondary)" }}>
            <Loader2 size={14} className="spin" /> …
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "10px" }}>
            <Stat label={t("aparserVersion")} value={info?.version || "—"} />
            <Stat label={t("aparserActiveThreads")} value={String(info?.activeThreads ?? "—")} />
            <Stat label={t("aparserWorkingTasks")} value={String(info?.workingTasks ?? "—")} />
            <Stat label={t("aparserQueue")} value={String(info?.tasksInQueue ?? "—")} />
            <Stat label={t("aparserProxies")} value={proxies ? String(proxies.total) : "—"}
              hint={proxies ? Object.entries(proxies.byType).map(([k, v]) => `${k}: ${v}`).join(", ") : undefined} />
          </div>
        )}
        {proxies?.total === 0 && (
          // Worth its own line rather than a zero in a tile: with no proxies the parsers still
          // answer, they just answer with whatever the search engine serves an unproxied server,
          // which is where "success, and an empty result set" comes from.
          <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--color-accent-orange)" }}>⚠ {t("aparserNoProxies")}</div>
        )}
      </div>

      {/* ── What this build can do for the app ─────────────────────────────── */}
      <div className="panel">
        <SectionTitle icon={<CheckCircle2 size={16} color="#10B981" />} title={t("aparserCapsTitle")} sub={t("aparserCapsSub")} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "8px" }}>
          {APARSER_CAPABILITIES.map(c => {
            const has = installed.has(c.parser);
            return (
              <div key={c.parser} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: has ? "rgba(16,185,129,0.06)" : "transparent" }}>
                {has ? <CheckCircle2 size={13} color="#10B981" /> : <XCircle size={13} color="var(--color-text-tertiary)" />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.parser}</div>
                  <div style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>
                    {t(c.useKey as any)}{c.wired ? "" : ` · ${t("aparserNotWired")}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Full parser list ───────────────────────────────────────────────── */}
      <div className="panel">
        <SectionTitle icon={<Search size={16} color="#2997ff" />} title={`${t("aparserParsersTitle")} (${info?.availableParsers?.length ?? 0})`} sub={t("aparserParsersSub")} />
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={t("aparserSearchPh")}
          style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none", boxSizing: "border-box", marginBottom: "10px" }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", maxHeight: "220px", overflowY: "auto" }}>
          {list.map(p => (
            <button key={p} onClick={() => setParser(p)} title={t("aparserUseInTest")}
              style={{ padding: "4px 9px", borderRadius: "6px", border: "1px solid var(--color-border)", background: parser === p ? "rgba(41,151,255,0.12)" : "transparent", color: parser === p ? "var(--color-accent-blue)" : "var(--color-text-secondary)", fontSize: "11px", fontFamily: "monospace", cursor: "pointer" }}>
              {p}
            </button>
          ))}
          {!list.length && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>—</span>}
        </div>
      </div>

      {/* ── Test query ─────────────────────────────────────────────────────── */}
      <div className="panel">
        <SectionTitle icon={<Play size={16} color="#bf5af2" />} title={t("aparserTestTitle")} sub={t("aparserTestSub")} />
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "10px" }}>
          <input value={parser} onChange={e => setParser(e.target.value)} placeholder="SE::Google"
            style={{ flex: "0 1 240px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", fontFamily: "monospace", outline: "none" }} />
          <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && runTest()} placeholder={t("aparserQueryPh")}
            style={{ flex: "1 1 240px", padding: "8px 12px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none" }} />
          <button onClick={runTest} disabled={testBusy || !parser.trim() || !query.trim()} style={{ ...btn, background: "rgba(191,90,242,0.15)", color: "#bf5af2" }}>
            {testBusy ? <Loader2 size={12} className="spin" /> : <Play size={12} />} {t("aparserRun")}
          </button>
        </div>

        {testErr && <div style={{ fontSize: "12px", fontFamily: "monospace", color: "#f87171", marginBottom: "10px", wordBreak: "break-all" }}>{testErr}</div>}

        {preset && (
          <details style={{ marginBottom: "10px" }}>
            <summary style={{ fontSize: "12px", color: "var(--color-accent-blue)", cursor: "pointer" }}>{t("aparserPresetTitle")}</summary>
            <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "6px 0" }}>{t("aparserPresetSub")}</p>
            <pre style={pre}>{JSON.stringify(preset, null, 2)}</pre>
          </details>
        )}

        {testOut && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px" }}>
            <div>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#10B981", marginBottom: "4px" }}>results[] · {t("aparserUseThis")}</div>
              <pre style={pre}>{JSON.stringify(testOut.results, null, 2) || "—"}</pre>
            </div>
            <div>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--color-accent-orange)", marginBottom: "4px" }}>resultString · {t("aparserNeverParse")}</div>
              <p style={{ fontSize: "11px", color: "var(--color-text-secondary)", margin: "0 0 4px" }}>{t("aparserResultStringWarn")}</p>
              <pre style={pre}>{testOut.resultStringPreview || "—"}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "8px 14px", borderRadius: "8px", border: "none", background: "rgba(255,255,255,0.06)",
  color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer",
  display: "flex", alignItems: "center", gap: "5px",
};

const pre: React.CSSProperties = {
  margin: 0, padding: "10px", borderRadius: "8px", background: "var(--color-card)",
  border: "1px solid var(--color-border)", fontSize: "11px", lineHeight: 1.5,
  color: "var(--color-text-secondary)", maxHeight: "320px", overflow: "auto", whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

function Header({ t, host, fromEnv }: { t: (k: any) => string; host: string; fromEnv: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
      <Server size={20} color="#e8452c" />
      <h1 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>A-Parser</h1>
      {host && <code style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{host}</code>}
      {fromEnv && <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", background: "rgba(16,185,129,0.12)", color: "#10B981" }}>{t("aparserFromEnv")}</span>}
      <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.06)", color: "var(--color-text-secondary)" }}>{t("aparserNoCost")}</span>
      <Link href="/settings?tab=api-keys" style={{ marginLeft: "auto", fontSize: "12px", color: "var(--color-text-secondary)", textDecoration: "none", display: "flex", alignItems: "center", gap: "5px" }}>
        <Settings2 size={13} /> {t("aparserOpenSettings")}
      </Link>
    </div>
  );
}

function SectionTitle({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        {icon}
        <h2 style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>{title}</h2>
      </div>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "4px 0 0" }}>{sub}</p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--color-border)" }}>
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginBottom: "3px" }}>{label}</div>
      <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--color-text-primary)" }}>{value}</div>
      {hint && <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", marginTop: "2px" }}>{hint}</div>}
    </div>
  );
}
