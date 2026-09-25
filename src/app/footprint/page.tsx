"use client";

// Network footprints (N1) — templates repeated across the portfolio's sites.
//
// The same title/description CONSTRUCTION standing on several sites with only the entity
// swapped («{slot} Démo Gratuite : Jouer Sans Inscription ni Dépôt» was found on four sites)
// links the sites together at a manual glance and algorithmically. This page reports those
// constructions from LOCAL data only (last audit of every live site + 180 days of generation
// history), lets the operator hide the ones that are fine, and the generator guard uses the
// same skeletons to stop new outlines from reusing them.

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Fingerprint, EyeOff, Eye, Search } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

type Kind = "title" | "description" | "h1";
type Source = "published" | "generated" | "both";

interface Example { label: string; source: "published" | "generated"; example: string }
interface Group {
  skeleton: string;
  noEntity: boolean;
  sites: number;
  pages: number;
  source: Source;
  examples: Example[];
  ignored?: boolean;
}
interface SimilarGroup { skeletons: string[]; sites: number; pages: number; examples: Example[] }
interface Report {
  kind: Kind;
  minSites: number;
  groups: Group[];
  similar: SimilarGroup[];
  ignored: string[];
  scanned: { sites: number; pages: number; history: number };
  notMigrated?: boolean;
}

const TABS: Array<{ id: Kind; key: string }> = [
  { id: "title", key: "fpTabTitle" },
  { id: "description", key: "fpTabDescription" },
  { id: "h1", key: "fpTabH1" },
];
const SOURCE_KEY: Record<Source, string> = {
  published: "fpSource_published",
  generated: "fpSource_generated",
  both: "fpSource_both",
};

const pill: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 9px",
  borderRadius: "999px", fontSize: "11px", fontWeight: 600,
  border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)",
};

export default function FootprintPage() {
  const { t } = useLanguage();
  // Extra N1 i18n keys not in the locales yet (wave rule: use them in code, list them in the
  // report, R adds them after review) — one typed alias per call site, no `any`.
  const tt = (key: string) => t(key as never);
  const [kind, setKind] = useState<Kind>("title");
  const [publishedOnly, setPublishedOnly] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const q = new URLSearchParams({ kind, includeIgnored: showIgnored ? "1" : "0", publishedOnly: publishedOnly ? "1" : "0" });
      const r = await fetch(`/api/footprint?${q}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) setErr(d.error || "error");
      else setReport(d);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
    setLoading(false);
  }, [kind, publishedOnly, showIgnored]);

  // Every data write inside load() happens after an awaited fetch — no second render can
  // cascade before paint. The linter cannot see across the await; narrow suppression.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function setIgnored(skeleton: string, hidden: boolean) {
    await fetch("/api/footprint/ignore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skeleton, ignored: hidden }),
    }).catch(() => {});
    void load();
  }

  // The skeleton with its {x} placeholders highlighted: the placeholder is the swapped-in
  // entity, so showing it as a chip is what makes "same construction, different site" readable.
  const renderSkeleton = (s: string) => (
    <span style={{ fontSize: "13px", color: "var(--color-text-primary)", wordBreak: "break-word", lineHeight: 1.7 }}>
      {s.split(/(\{x\})/g).map((part, i) =>
        part === "{x}"
          ? <span key={i} style={{ padding: "1px 7px", margin: "0 1px", borderRadius: "6px", background: "rgba(94,92,230,0.12)", border: "1px solid rgba(94,92,230,0.4)", color: "var(--color-accent-purple)", fontWeight: 700, fontSize: "12px", whiteSpace: "nowrap" }}>{part}</span>
          : <span key={i}>{part}</span>,
      )}
    </span>
  );

  return (
    <div className="main-content">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", marginBottom: "14px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}>
            <Fingerprint size={20} color="var(--color-accent-purple)" /> {t("fpTitle")}
          </h1>
          <p style={{ color: "var(--color-text-secondary)", fontSize: "13px", margin: 0, maxWidth: "640px" }}>{t("fpHint")}</p>
        </div>
        <span className="pill">{tt("fpFreeLocal")}</span>
      </div>

      {/* Controls: kind tabs + filters */}
      <div className="panel" style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", marginBottom: "12px" }}>
        <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: "9px", overflow: "hidden" }}>
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setKind(tab.id)}
              style={{ padding: "7px 13px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: kind === tab.id ? "var(--color-text-primary)" : "var(--color-bg)", color: kind === tab.id ? "var(--color-bg)" : "var(--color-text-secondary)" }}>
              {tt(tab.key)}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={publishedOnly} onChange={e => setPublishedOnly(e.target.checked)} /> {t("fpOnlyPublished")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--color-text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={showIgnored} onChange={e => setShowIgnored(e.target.checked)} /> {t("fpShowIgnored")}
        </label>
        <button onClick={() => void load()} disabled={loading}
          style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 13px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", marginLeft: "auto" }}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {err && <div className="panel" style={{ borderColor: "rgba(255,69,58,0.35)", color: "var(--color-accent-red)", fontSize: "12px" }}>{err}</div>}
      {report?.notMigrated && <div className="panel" style={{ fontSize: "12px", color: "var(--color-accent-orange)" }}>{tt("fpNotMigrated")}</div>}

      {report && !report.notMigrated && (
        <>
          {report.groups.length === 0 && report.similar.length === 0 && !loading && (
            <div className="panel" style={{ fontSize: "13px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "8px" }}>
              <Search size={15} /> {t("fpEmpty")}
            </div>
          )}

          {report.groups.map(g => (
            <div key={g.skeleton} className="panel" style={{ marginBottom: "10px", opacity: g.ignored ? 0.62 : 1 }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: "260px" }}>{renderSkeleton(g.skeleton)}</div>
                <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                  {g.noEntity && <span style={{ ...pill, borderColor: "rgba(255,159,10,0.45)", color: "var(--color-accent-orange)" }} title={t("fpNoEntity")}>{t("fpNoEntity")}</span>}
                  <span style={pill}>{tt(SOURCE_KEY[g.source])}</span>
                  <span style={{ ...pill, fontWeight: 700, color: "var(--color-text-primary)" }}>{t("fpSites")}: {g.sites}</span>
                  <span style={pill}>{t("fpPages")}: {g.pages}</span>
                  <button onClick={() => void setIgnored(g.skeleton, !g.ignored)}
                    style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "5px 11px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-secondary)", fontSize: "11px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                    {g.ignored ? <><Eye size={12} /> {tt("fpUnhide")}</> : <><EyeOff size={12} /> {t("fpIgnore")}</>}
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid var(--color-border)" }}>
                {g.examples.map((ex, i) => (
                  <div key={i} style={{ fontSize: "12px", color: "var(--color-text-secondary)", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, color: "var(--color-text-primary)", minWidth: "120px" }}>{ex.label}</span>
                    <span style={{ wordBreak: "break-all" }}>{ex.example}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {report.similar.length > 0 && (
            <>
              <h2 style={{ fontSize: "14px", fontWeight: 700, color: "var(--color-text-secondary)", margin: "18px 0 8px" }}>{t("fpSimilar")}</h2>
              {report.similar.map((sg, idx) => (
                <div key={idx} className="panel" style={{ marginBottom: "10px" }}>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" }}>
                    <span style={{ ...pill, fontWeight: 700, color: "var(--color-text-primary)" }}>{t("fpSites")}: {sg.sites}</span>
                    <span style={pill}>{t("fpPages")}: {sg.pages}</span>
                  </div>
                  {sg.skeletons.map((s, i) => (
                    <div key={i} style={{ padding: "3px 0" }}>{renderSkeleton(s)}</div>
                  ))}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
