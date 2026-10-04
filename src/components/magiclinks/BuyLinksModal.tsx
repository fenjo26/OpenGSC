"use client";

import { useEffect, useMemo, useState } from "react";
import { X, RefreshCw, ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { LANGUAGE_OPTIONS, defaultLanguageForHost } from "@/lib/magiclinks/languages";

// The buy window for link purchases from the striking-distance table.
//
// Flow mirrors the money contract exactly: quote first (free — FieldLink even saves the task
// server-side), then pay with the quoted amount echoed back, and a 409 "price changed" sends
// the operator back to a fresh quote rather than charging a different number than the one on
// the button. The provider with the larger balance is preselected but never forced.

interface ProviderInfo {
  id: "fieldlink" | "magic369";
  name: string;
  unit: string;
  configured: boolean;
  balanceMinor: number | null;
  priceMinor: number | null;
  error: string | null;
}

interface QuoteResponse {
  provider: "fieldlink" | "magic369";
  taskId?: string;
  placementCount: number;
  bonusCount: number;
  amountMinor: number;
  balanceMinor: number | null;
  shortfallMinor: number;
  canSubmit: boolean;
}

export interface BuyRow {
  query: string;
  targetUrl: string;
  siteId?: string;
}

const hostOf = (url: string) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; } };
const money = (minor: number | null | undefined) =>
  minor == null ? "—" : `${(minor / 100).toFixed(minor % 100 === 0 ? 0 : 2)}`;

export default function BuyLinksModal({ siteId, rows, onClose, onDone }: {
  siteId?: string;
  rows: BuyRow[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useLanguage();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providerId, setProviderId] = useState<"fieldlink" | "magic369" | "">("");
  const [count, setCount] = useState(5);
  const [langs, setLangs] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ orderId: string } | null>(null);

  const hosts = useMemo(() => [...new Set(rows.map(r => hostOf(r.targetUrl)).filter(Boolean))], [rows]);
  // TLD hint where it says something; the operator finishes the choice — a silent English
  // fallback would be a guess dressed as an answer.
  useEffect(() => {
    setLangs(Object.fromEntries(hosts.map(h => [h, defaultLanguageForHost(h) ?? ""])));
  }, [hosts]);

  useEffect(() => {
    fetch("/api/magiclinks/status")
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!Array.isArray(d?.providers)) { setProviders([]); return; }
        setProviders(d.providers);
        // Default to the provider with the larger live balance, when both answer.
        const usable: ProviderInfo[] = d.providers.filter((p: ProviderInfo) => p.configured && p.balanceMinor != null);
        if (usable.length) {
          const best = usable.reduce((a, b) => ((a.balanceMinor ?? 0) >= (b.balanceMinor ?? 0) ? a : b));
          setProviderId(best.id);
        }
      })
      .catch(() => setProviders([]));
  }, []);

  const missingLang = hosts.filter(h => !langs[h]);
  const provider = providers?.find(p => p.id === providerId) ?? null;
  const context = rows.map(r => ({ siteId: r.siteId ?? siteId ?? "", targetUrl: r.targetUrl, query: r.query }));

  async function doQuote() {
    if (!providerId || missingLang.length) return;
    setBusy(true); setError(""); setQuote(null);
    try {
      const res = await fetch("/api/magiclinks/quote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          items: rows.map(r => ({
            targetUrl: r.targetUrl, query: r.query, language: langs[hostOf(r.targetUrl)] ?? "", count,
          })),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || d?.error || t("mlQuoteFailed"));
      setQuote(d);
    } catch (e: any) { setError(String(e?.message ?? e)); }
    setBusy(false);
  }

  async function doPay() {
    if (!quote || !providerId) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/magiclinks/submit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          taskId: quote.taskId,
          expectedMinor: quote.amountMinor,
          siteId: siteId ?? "",
          context,
          items: rows.map(r => ({
            targetUrl: r.targetUrl, query: r.query, language: langs[hostOf(r.targetUrl)] ?? "", count,
            siteId: r.siteId ?? siteId ?? "",
          })),
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        if (d?.error === "price_changed") {
          setError(t("mlPriceChanged"));
          setQuote(d.quote ? { provider: providerId, ...d.quote } : null);
        } else if (d?.error === "insufficient_balance") {
          setError(t("mlInsufficient"));
        } else {
          throw new Error(d?.message || d?.error || t("mlSubmitFailed"));
        }
        setBusy(false);
        return;
      }
      setDone({ orderId: String(d.orderId ?? "") });
      onDone?.();
    } catch (e: any) { setError(String(e?.message ?? e)); }
    setBusy(false);
  }

  const inp: React.CSSProperties = { padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text-primary)", fontSize: "12px", outline: "none" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }} onClick={onClose}>
      <div style={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: "14px", width: "100%", maxWidth: "640px", boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}>
          <div style={{ width: "30px", height: "30px", borderRadius: "8px", background: "rgba(124,58,237,0.14)", display: "flex", alignItems: "center", justifyContent: "center", color: "#7C3AED", fontWeight: 700, fontSize: 13 }}>⬡</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("mlBuyTitle")}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{rows.length} × {t("mlRowsWord")}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: 4 }}><X size={16} /></button>
        </div>

        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {done ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", textAlign: "center", padding: "18px 0" }}>
              <div style={{ fontSize: "30px" }}>✅</div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("mlOrderCreated")}</div>
              <div style={{ fontSize: "12px", fontFamily: "monospace", color: "var(--color-text-secondary)", wordBreak: "break-all" }}>{done.orderId}</div>
              <a href="/magiclinks" style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--color-accent-blue)", textDecoration: "none" }}>{t("mlOpenOrders")} <ExternalLink size={11} /></a>
            </div>
          ) : (
            <>
              {/* No provider wired up: the window explains itself instead of failing on a button. */}
              {providers && providers.length > 0 && providers.every(p => !p.configured) && (
                <div style={{ padding: "12px 14px", borderRadius: "10px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                  {t("mlNoProviders")}{" "}
                  <a href="/settings?tab=seo-tools" style={{ color: "var(--color-accent-blue)" }}>{t("mlOpenSettings")}</a>
                </div>
              )}

              {/* Provider picker */}
              <div>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "8px" }}>{t("mlProvider")}</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {(providers ?? []).map(p => (
                    <button key={p.id} onClick={() => { setProviderId(p.id); setQuote(null); }} disabled={!p.configured}
                      style={{
                        flex: 1, padding: "9px 12px", borderRadius: "10px", cursor: p.configured ? "pointer" : "not-allowed",
                        border: `1px solid ${providerId === p.id ? "#7C3AED" : "var(--color-border)"}`,
                        background: providerId === p.id ? "rgba(124,58,237,0.1)" : "var(--color-bg)",
                        color: providerId === p.id ? "#7C3AED" : "var(--color-text-secondary)",
                        fontSize: "12px", fontWeight: 600, textAlign: "left", opacity: p.configured ? 1 : 0.45,
                      }}>
                      <div>{p.name}{!p.configured ? ` · ${t("mlNotSet")}` : ""}</div>
                      <div style={{ fontSize: "11px", fontWeight: 500, fontFamily: "monospace" }}>
                        {p.error ? t("mlProviderError") : p.balanceMinor != null ? `${t("mlBalance")}: ${money(p.balanceMinor)} ${p.unit}` : "…"}
                      </div>
                    </button>
                  ))}
                  {providers === null && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", padding: "9px 0" }}>{t("loading")}</div>}
                </div>
              </div>

              {/* Count + languages */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("mlCountPerRow")}</span>
                  <input type="number" min={1} max={250} value={count}
                    onChange={e => { setCount(Math.max(1, Math.min(250, Number(e.target.value) || 1))); setQuote(null); }}
                    style={{ ...inp, width: "100%", boxSizing: "border-box" }} />
                </label>
                {hosts.slice(0, 1).map(h => (
                  <label key={h} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("mlLanguage")} · {h}</span>
                    <select value={langs[h] ?? ""} onChange={e => { setLangs(p => ({ ...p, [h]: e.target.value })); setQuote(null); }}
                      style={{ ...inp, width: "100%", boxSizing: "border-box" }}>
                      <option value="">—</option>
                      {LANGUAGE_OPTIONS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              {hosts.length > 1 && (
                <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>
                  {hosts.length} {t("mlHostsWord")} · {hosts.join(", ")}
                </div>
              )}
              {missingLang.length > 0 && (
                <div style={{ fontSize: "11px", color: "#F59E0B" }}>{t("mlLangRequired")}</div>
              )}

              {/* Rows */}
              <div style={{ border: "1px solid var(--color-border)", borderRadius: "10px", maxHeight: "180px", overflowY: "auto" }}>
                {rows.map((r, i) => (
                  <div key={`${r.targetUrl}-${i}`} style={{ display: "flex", gap: "8px", alignItems: "center", padding: "7px 12px", borderBottom: i < rows.length - 1 ? "1px solid var(--color-border)" : "none", fontSize: "12px" }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, color: "var(--color-text-primary)" }} title={r.query}>{r.query}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-secondary)" }} title={r.targetUrl}>{hostOf(r.targetUrl)}</span>
                    <span style={{ fontFamily: "monospace", color: "var(--color-text-secondary)", flexShrink: 0 }}>×{count}</span>
                  </div>
                ))}
              </div>

              {/* Quote result */}
              {quote && (
                <div style={{ padding: "12px 14px", borderRadius: "10px", border: "1px solid rgba(124,58,237,0.3)", background: "rgba(124,58,237,0.06)", display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>{t("mlPlacements")}</span>
                    <span style={{ fontFamily: "monospace", color: "var(--color-text-primary)" }}>{quote.placementCount}{quote.bonusCount > 0 ? ` +${quote.bonusCount} ${t("mlBonus")}` : ""}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>{t("mlTotal")}</span>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#7C3AED" }}>{money(quote.amountMinor)} {provider?.unit ?? ""}</span>
                  </div>
                  {quote.balanceMinor != null && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--color-text-secondary)" }}>{t("mlBalanceAfter")}</span>
                      <span style={{ fontFamily: "monospace", color: quote.shortfallMinor > 0 ? "#EF4444" : "var(--color-text-primary)" }}>{money(quote.balanceMinor - quote.amountMinor)} {provider?.unit ?? ""}</span>
                    </div>
                  )}
                  {quote.shortfallMinor > 0 && (
                    <div style={{ color: "#EF4444", fontSize: "11px" }}>{t("mlShortfall")}: {money(quote.shortfallMinor)} {provider?.unit ?? ""}</div>
                  )}
                </div>
              )}

              {error && (
                <div style={{ padding: "10px 12px", borderRadius: "10px", border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.07)", fontSize: "12px", color: "#f87171" }}>{error}</div>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button onClick={onClose} style={{ padding: "9px 14px", borderRadius: "9px", border: "1px solid var(--color-border)", background: "none", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>{t("mlCancel")}</button>
                {!quote ? (
                  <button onClick={doQuote} disabled={busy || !providerId || missingLang.length > 0}
                    style={{ padding: "9px 16px", borderRadius: "9px", border: "none", background: busy ? "rgba(124,58,237,0.25)" : "#7C3AED", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: busy ? "wait" : "pointer", display: "flex", alignItems: "center", gap: "6px" }}>
                    <RefreshCw size={12} style={{ animation: busy ? "spin 1s linear infinite" : undefined }} /> {busy ? t("mlCalculating") : t("mlCalculate")}
                  </button>
                ) : (
                  <button onClick={doPay} disabled={busy || !quote.canSubmit}
                    style={{ padding: "9px 16px", borderRadius: "9px", border: "none", background: busy || !quote.canSubmit ? "rgba(124,58,237,0.25)" : "#7C3AED", color: "#fff", fontSize: "12px", fontWeight: 700, cursor: busy ? "wait" : quote.canSubmit ? "pointer" : "not-allowed" }}>
                    {busy ? t("mlPaying") : `${t("mlPay")} · ${money(quote.amountMinor)} ${provider?.unit ?? ""}`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
