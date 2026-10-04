"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Download, ChevronDown, Link2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

// /magiclinks — the purchase history of both providers in one list.
//
// The page exists even with nothing configured (the nav item is always visible for the same
// reason /serp-monitor's is): it explains what is missing and where to put it, instead of the
// feature disappearing and looking absent.

interface OrderRow {
  provider: "fieldlink" | "magic369";
  providerName: string;
  orderId: string;
  createdAt: string | null;
  status: string;
  rowCount: number;
  completedCount: number;
  failedCount: number;
  amountMinor: number | null;
  hosts: string[];
  quantity: number;
  queries: string[];
}

interface DetailRow {
  id: string;
  status: string;
  targetUrl: string;
  anchor: string;
  quantity: number;
  destination: string | null;
  indexing: string | null;
  error: string | null;
}

const money = (minor: number | null) => (minor == null ? "—" : `${(minor / 100).toFixed(minor % 100 === 0 ? 0 : 2)}`);
const unitOf = (p: string) => (p === "fieldlink" ? "cr." : "tok.");
const pathOf = (url: string) => { try { return new URL(url).pathname || "/"; } catch { return url; } };
const hostOf = (url: string | null) => { if (!url) return ""; try { return new URL(url).host; } catch { return url; } };

export default function MagicLinksPage() {
  const { t } = useLanguage();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailRow[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ordersRes, statusRes] = await Promise.all([
        fetch("/api/magiclinks/orders").then(r => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/api/magiclinks/status").then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setOrders(Array.isArray(ordersRes?.orders) ? ordersRes.orders : []);
      setErrors(ordersRes?.errors ?? {});
      const providers = Array.isArray(statusRes?.providers) ? statusRes.providers : [];
      setConfigured(providers.some((p: { configured: boolean }) => p.configured));
    } catch { /* the banner below covers a total failure */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (o: OrderRow) => {
    if (openId === o.orderId) { setOpenId(null); return; }
    setOpenId(o.orderId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/magiclinks/orders/${encodeURIComponent(o.orderId)}?provider=${o.provider}`);
      const d = await res.json();
      setDetail(Array.isArray(d?.rows) ? d.rows : null);
    } catch { setDetail(null); }
    setDetailLoading(false);
  };

  return (    <div style={{ padding: "32px 28px", maxWidth: "1200px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "6px" }}>
        <div style={{ width: "34px", height: "34px", borderRadius: "9px", background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.3)", display: "flex", alignItems: "center", justifyContent: "center", color: "#7C3AED" }}>
          <Link2 size={16} />
        </div>
        <h1 style={{ fontSize: "26px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.02em", margin: 0 }}>{t("mlTitle")}</h1>
        <div style={{ flex: 1 }} />
        <button onClick={load} disabled={loading}
          style={{ display: "flex", alignItems: "center", gap: "6px", padding: "7px 14px", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-card)", color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: loading ? "wait" : "pointer" }}>
          <RefreshCw size={12} style={{ animation: loading ? "spin 1s linear infinite" : undefined }} /> {t("mlRefresh")}
        </button>
      </div>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "0 0 20px" }}>{t("mlSubtitle")}</p>

      {/* Not configured — the page explains itself rather than showing a fake empty history */}
      {configured === false && (
        <div style={{ padding: "14px 16px", borderRadius: "12px", border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)", marginBottom: "16px", fontSize: "13px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "4px" }}>{t("mlNoProviders")}</div>
          {t("mlNoProvidersDesc")}{" "}
          <a href="/settings?tab=seo-tools" style={{ color: "var(--color-accent-blue)" }}>{t("mlOpenSettings")}</a>
          {" · "}
          <a href="/striking" style={{ color: "var(--color-accent-blue)" }}>{t("mlFromStriking")}</a>
        </div>
      )}

      {/* Provider errors — the list still shows the other provider and the ledger half */}
      {(errors.fieldlink || errors.magic369) && (
        <div style={{ padding: "10px 14px", borderRadius: "10px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", marginBottom: "16px", fontSize: "12px", color: "#f87171", fontFamily: "monospace" }}>
          {errors.fieldlink ? `FieldLink: ${errors.fieldlink}` : ""}
          {errors.fieldlink && errors.magic369 ? " · " : ""}
          {errors.magic369 ? `369Team: ${errors.magic369}` : ""}
        </div>
      )}

      {/* Orders */}
      {!loading && orders.length === 0 ? (
        <div style={{ border: "1px solid var(--color-border)", borderRadius: "12px", padding: "64px 32px", textAlign: "center", background: "var(--color-card)" }}>
          <div style={{ fontSize: "32px", marginBottom: "12px" }}>⬡</div>
          <p style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 6px" }}>{t("mlEmpty")}</p>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("mlEmptyDesc")}</p>
        </div>
      ) : (
        <div className="privacy-blur-all" style={{ border: "1px solid var(--color-border)", borderRadius: "12px", overflow: "hidden", background: "var(--color-card)" }}>
          {loading && orders.length === 0 ? (
            <div style={{ padding: "48px", textAlign: "center", fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("loading")}</div>
          ) : orders.map((o, i) => (
            <div key={`${o.provider}-${o.orderId}`} style={{ borderBottom: i < orders.length - 1 ? "1px solid var(--color-border)" : "none" }}>
              <div style={{ display: "grid", gridTemplateColumns: "100px 90px 1fr 120px 110px 90px 36px", gap: "10px", alignItems: "center", padding: "12px 16px", fontSize: "12px" }}>
                <div style={{ color: "var(--color-text-secondary)", fontFamily: "monospace" }}>{o.createdAt ? o.createdAt.slice(0, 10) : "—"}</div>
                <div>
                  <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 7px", borderRadius: "10px", color: o.provider === "fieldlink" ? "#3B82F6" : "#10B981", background: o.provider === "fieldlink" ? "rgba(59,130,246,0.12)" : "rgba(16,185,129,0.12)" }}>
                    {o.providerName}
                  </span>
                </div>
                <div style={{ overflow: "hidden" }}>
                  <div style={{ color: "var(--color-text-primary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.queries.join(", ")}>
                    {o.queries.length ? o.queries.join(", ") : o.hosts.join(", ")}
                  </div>
                  <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.orderId}>
                    {o.orderId}{o.hosts.length > 1 ? ` · ${o.hosts.length} hosts` : o.hosts[0] ? ` · ${o.hosts[0]}` : ""}
                  </div>
                </div>
                <div style={{ color: "var(--color-text-secondary)", fontFamily: "monospace" }} title={t("mlColLinks")}>
                  {o.quantity} {t("mlLinksWord")}
                </div>
                <div>
                  <div style={{ fontSize: "11px", fontWeight: 600, color: o.status === "completed" ? "#10B981" : o.status === "failed" ? "#EF4444" : "var(--color-text-secondary)" }}>{o.status}</div>
                  <div style={{ fontSize: "10px", color: "var(--color-text-tertiary)", fontFamily: "monospace" }}>{o.completedCount}/{o.rowCount}</div>
                </div>
                <div style={{ color: "var(--color-text-primary)", fontWeight: 600, fontFamily: "monospace" }}>
                  {money(o.amountMinor)} <span style={{ fontSize: "10px", color: "var(--color-text-tertiary)" }}>{unitOf(o.provider)}</span>
                </div>
                <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end" }}>
                  <a href={`/api/magiclinks/orders/${encodeURIComponent(o.orderId)}/csv?provider=${o.provider}`} title={t("mlDownloadCsv")}
                    style={{ width: "26px", height: "26px", borderRadius: "7px", border: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)" }}>
                    <Download size={12} />
                  </a>
                  <button onClick={() => openDetail(o)} title={t("mlDetails")}
                    style={{ width: "26px", height: "26px", borderRadius: "7px", border: "1px solid var(--color-border)", background: "none", color: "var(--color-text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                    <ChevronDown size={12} style={{ transform: openId === o.orderId ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
                  </button>
                </div>
              </div>

              {/* Detail: per-row progress + publication links + indexing */}
              {openId === o.orderId && (
                <div style={{ background: "var(--color-bg)", borderTop: "1px solid var(--color-border)", padding: "10px 16px 14px" }}>
                  {detailLoading ? (
                    <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", padding: "8px 0" }}>{t("loading")}</div>
                  ) : !detail || detail.length === 0 ? (
                    <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", padding: "8px 0" }}>{t("mlNoDetail")}</div>
                  ) : detail.map(r => (
                    <div key={r.id} style={{ display: "flex", gap: "10px", alignItems: "center", padding: "5px 0", fontSize: "11.5px", fontFamily: "monospace" }}>
                      <span style={{ width: "70px", flexShrink: 0, color: r.status === "completed" ? "#10B981" : r.status === "failed" ? "#EF4444" : "var(--color-text-tertiary)" }}>{r.status}</span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-secondary)" }} title={`${r.targetUrl} · ${r.anchor}`}>
                        {r.anchor} → {pathOf(r.targetUrl)}
                      </span>
                      {r.indexing && (
                        <span title={t("mlIndexing")} style={{ flexShrink: 0, fontSize: "10px", color: r.indexing === "completed" ? "#10B981" : r.indexing === "attention" ? "#F59E0B" : "var(--color-text-tertiary)" }}>
                          ⟳ {r.indexing}
                        </span>
                      )}
                      {r.destination ? (
                        <a href={r.destination} target="_blank" rel="noreferrer" style={{ flexShrink: 0, maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-accent-blue)" }} title={r.destination}>
                          {hostOf(r.destination)}
                        </a>
                      ) : (
                        <span style={{ flexShrink: 0, color: "var(--color-text-tertiary)" }}>—</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
