"use client";

// Brand visibility in AI answers, from DataForSEO's LLM Mentions index.
//
// It sits under the AEO Tracker's live checks and answers a different question, which is why it
// is a separate panel rather than more columns in the same table:
//
//   the table above  — "was I cited for the questions I chose to track", asked live today on
//                      your own model keys
//   this panel       — "how visible is this brand across everything models are being asked",
//                      read from an index refreshed roughly monthly
//
// The index covers ChatGPT and Google AI Overview only. Claude and Grok appear in the table
// above and cannot appear here, which is stated rather than hidden — a brand showing zero here
// has not been shown to be invisible to Claude.

import { useCallback, useEffect, useState } from "react";
import { Loader2, ExternalLink, Sparkles } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePrivacy } from "@/lib/PrivacyContext";
import { formatUsd } from "@/lib/seo/metricsClient";
import { getDataForSeoKey } from "@/lib/seo/keys";
import { LLM_PLATFORMS, PLATFORM_LABEL, type LlmPlatform } from "@/lib/seo/llmMentions";

interface Totals { platform: LlmPlatform; mentions: number; aiSearchVolume: number; impressions: number }
interface Mention {
  question: string;
  aiSearchVolume: number | null;
  sources: { url: string; title: string; domain: string }[];
  lastSeen: string | null;
}
interface TopPage { url: string; mentions: number; aiSearchVolume: number }
interface Share { brand: string; mentions: number; aiSearchVolume: number; share: number }

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

export default function BrandVisibility({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  const { blur } = usePrivacy();
  const blurStyle: React.CSSProperties = blur ? { filter: "blur(5px)", userSelect: "none" } : {};

  const [platform, setPlatform] = useState<LlmPlatform>("chat_gpt");
  const [kind, setKind] = useState<"domain" | "brand">("domain");
  const [competitors, setCompetitors] = useState("");

  const [totals, setTotals] = useState<Totals[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [topPages, setTopPages] = useState<TopPage[]>([]);
  const [share, setShare] = useState<Share[]>([]);
  const [brand, setBrand] = useState("");
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [priceUsd, setPriceUsd] = useState(0);
  const [busy, setBusy] = useState<null | "lookup" | "share">(null);
  const [notice, setNotice] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => { setHasKey(getDataForSeoKey().length > 4); }, []);

  const call = useCallback(async (action: "lookup" | "share", wantFetch: boolean) => {
    const body: Record<string, unknown> = {
      siteId: siteDbId, action, platform, kind,
      competitors: action === "share" ? competitors : undefined,
      fetch: wantFetch,
    };
    if (wantFetch) {
      body.apiKey = getDataForSeoKey();
      body.cap = Number(localStorage.getItem("seoDemandCap") || 0) || 0;
    }
    const res = await fetch("/api/aeo/mentions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));

    if (d.brand) setBrand(d.brand);
    if (typeof d.priceUsd === "number") setPriceUsd(d.priceUsd);
    setCachedAt(d.cachedAt ?? null);

    if (action === "share") {
      setShare(Array.isArray(d.rows) ? d.rows : []);
    } else {
      setTotals(Array.isArray(d.totals) ? d.totals : []);
      setMentions(Array.isArray(d.mentions) ? d.mentions : []);
      setTopPages(Array.isArray(d.topPages) ? d.topPages : []);
    }

    if (!res.ok || d.error) {
      setNotice(
        d.error === "cap_exceeded" ? t("dmCapExceeded")
        : d.error === "no_key" ? t("dmNoKey")
        : d.error === "need_two" ? t("bvNeedCompetitor")
        : d.error === "too_many" ? t("bvTooMany")
        : t("dmFailed"),
      );
      return;
    }
    setNotice("");
  }, [siteDbId, platform, kind, competitors, t]);

  // Free cache read when the panel opens or its parameters change. Nothing here spends without
  // a button press.
  useEffect(() => {
    if (!open) return;
    call("lookup", false).catch(() => {});
    call("share", false).catch(() => {});
  }, [open, platform, kind, call]);

  async function run(action: "lookup" | "share") {
    if (busy || !hasKey) return;
    setBusy(action);
    await call(action, true).catch(() => {});
    setBusy(null);
  }

  const cell: React.CSSProperties = { padding: "9px 12px", fontSize: "13px" };
  const th: React.CSSProperties = {
    ...cell, fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)",
    textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left",
  };

  const current = totals.find(x => x.platform === platform);

  return (
    <div className="panel" style={{ marginTop: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", cursor: "pointer" }}
        onClick={() => setOpen(o => !o)}>
        <Sparkles size={16} style={{ color: "var(--color-accent-purple)" }} />
        <span className="tool-section-label" style={{ marginBottom: 0 }}>{t("bvTitle")}</span>
        <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("bvSub")}</span>
        <span style={{ marginLeft: "auto", fontSize: "12px", color: "var(--color-accent-blue)" }}>
          {open ? t("bvHide") : t("bvShow")}
        </span>
      </div>

      {open && (
        <div style={{ marginTop: "14px" }}>
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap", marginBottom: "12px" }}>
            {LLM_PLATFORMS.map(p => (
              <button key={p} className={platform === p ? "pill active" : "pill"} onClick={() => setPlatform(p)}
                style={{ cursor: "pointer" }}>{PLATFORM_LABEL[p]}</button>
            ))}
            {/* Domain finds answers that linked to you; brand finds answers that named you
                without linking. Two different numbers, so the choice is explicit. */}
            <select className="tool-input inline" value={kind} onChange={e => setKind(e.target.value as "domain" | "brand")}
              title={t("bvKindHint")}>
              <option value="domain">{t("bvByDomain")}</option>
              <option value="brand">{t("bvByBrand")}</option>
            </select>
            <button className="metric-action" onClick={() => run("lookup")} disabled={!!busy || !hasKey}
              title={!hasKey ? t("dmNoKey") : undefined}>
              {busy === "lookup" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              {t("bvLookup")}
            </button>
            {hasKey && <span className="metric-cost">≈ {formatUsd(priceUsd)}</span>}
            {cachedAt && <span style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>{t("dmFromCache")}</span>}
            {notice && <span style={{ fontSize: "12px", color: "var(--color-danger)" }}>{notice}</span>}
          </div>

          {current && (
            <div style={{ display: "flex", gap: "32px", flexWrap: "wrap", marginBottom: "14px" }}>
              <div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("bvMentions")}</div>
                <div className="metric-value" style={{ fontSize: "24px", ...blurStyle }}>{fmt(current.mentions)}</div>
              </div>
              <div>
                <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("bvAiVolume")}</div>
                <div className="metric-value" style={{ fontSize: "24px", ...blurStyle }}>{fmt(current.aiSearchVolume)}</div>
              </div>
              <div style={{ alignSelf: "center", fontSize: "12px", color: "var(--color-text-tertiary)", maxWidth: "380px", lineHeight: 1.5 }}>
                {t("bvIndexNote")}
              </div>
            </div>
          )}

          {/* Share of voice — the one thing the live tracker structurally cannot answer, since
              it only ever asks on your own behalf. */}
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "12px", marginTop: "4px" }}>
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 260px" }}>
                <span className="tool-field-label">{t("bvCompetitors")}</span>
                <input className="tool-input" value={competitors} onChange={e => setCompetitors(e.target.value)}
                  placeholder={t("bvCompetitorsPh")} style={{ fontFamily: "monospace" }} />
              </div>
              <button className="metric-action" onClick={() => run("share")}
                disabled={!!busy || !hasKey || !competitors.trim()}>
                {busy === "share" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                {t("bvShareOfVoice")}
              </button>
            </div>

            {share.length > 0 && (
              <div style={{ marginTop: "12px" }}>
                {share.map((s, i) => (
                  <div key={s.brand} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <span style={{ width: "160px", fontSize: "13px", fontWeight: i === 0 ? 700 : 400, ...blurStyle }}>{s.brand}</span>
                    <div style={{ flex: 1, height: "10px", background: "var(--color-bg)", borderRadius: "var(--radius-pill)", overflow: "hidden" }}>
                      <div style={{
                        width: `${Math.round(s.share * 100)}%`, height: "100%",
                        background: i === 0 ? "var(--color-accent-blue)" : "var(--color-text-tertiary)",
                      }} />
                    </div>
                    <span style={{ width: "70px", textAlign: "right", fontSize: "12px", color: "var(--color-text-secondary)" }}>
                      {(s.share * 100).toFixed(1)}%
                    </span>
                    <span style={{ width: "60px", textAlign: "right", fontSize: "12px", color: "var(--color-text-tertiary)" }}>
                      {fmt(s.mentions)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {topPages.length > 0 && (
            <div style={{ marginTop: "16px" }}>
              <span className="tool-section-label">{t("bvTopPages")}</span>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <th style={th}>{t("dmColUrl")}</th>
                    <th style={{ ...th, textAlign: "right", width: "100px" }}>{t("bvMentions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {topPages.slice(0, 10).map(p => (
                    <tr key={p.url} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td style={{ ...cell, maxWidth: "420px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...blurStyle }}>
                        <a href={p.url} target="_blank" rel="noreferrer" title={p.url}
                          style={{ color: "var(--color-text-primary)", textDecoration: "none" }}>
                          {p.url.replace(/^https?:\/\//, "")} <ExternalLink size={9} style={{ opacity: 0.5 }} />
                        </a>
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>{fmt(p.mentions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {mentions.length > 0 && (
            <div style={{ marginTop: "16px" }}>
              <span className="tool-section-label">{t("bvQuestions").replace("{n}", String(mentions.length))}</span>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <th style={th}>{t("bvQuestion")}</th>
                    <th style={{ ...th, textAlign: "right", width: "90px" }}>{t("bvAiVolume")}</th>
                    <th style={{ ...th, width: "90px" }}>{t("bvSources")}</th>
                  </tr>
                </thead>
                <tbody>
                  {mentions.slice(0, 25).map(m => (
                    <tr key={m.question} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td style={{ ...cell, ...blurStyle }}>{m.question}</td>
                      <td style={{ ...cell, textAlign: "right", color: "var(--color-text-secondary)" }}>{fmt(m.aiSearchVolume)}</td>
                      <td style={cell}>
                        {m.sources.slice(0, 3).map(s => (
                          <a key={s.url} href={s.url} target="_blank" rel="noreferrer" title={s.title || s.url}
                            style={{ color: "var(--color-accent-blue)", marginRight: "6px" }}>
                            <ExternalLink size={11} style={{ display: "inline" }} />
                          </a>
                        ))}
                        {!m.sources.length && <span style={{ color: "var(--color-text-tertiary)", fontSize: "11px" }}>{t("bvNoLink")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {open && !current && !busy && (
            <div style={{ padding: "24px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
              {hasKey ? t("bvEmpty").replace("{brand}", brand || "—") : t("dmEmptyNoKey")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
