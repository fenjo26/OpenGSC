"use client";

import { useState } from "react";
import { Handshake } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { SUPPORT_PARTNERS, USDT_ADDRESS } from "@/lib/partners";

// /partners — the full partner wall. The "Support Developer" modal keeps only a compact
// logo grid (the row list outgrew its 420px panel at 11 partners); this page carries the
// descriptions, the running promo badges and the donation block.
export default function PartnersPage() {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(USDT_ADDRESS).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="main-content">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ width: "34px", height: "34px", borderRadius: "9px", background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.3)", display: "flex", alignItems: "center", justifyContent: "center", color: "#7C3AED" }}>
          <Handshake size={16} />
        </div>
        <div>
          <h1 style={{ fontSize: "26px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.02em", margin: 0 }}>
            {t("partnersTitle")}
          </h1>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "2px 0 0" }}>
            {t("partnersPageSubtitle")}
          </p>
        </div>
      </div>

      {/* Partner cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "14px" }}>
        {SUPPORT_PARTNERS.map(p => (
          <a
            key={p.id}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer sponsored"
            style={{
              display: "flex", alignItems: "center", gap: "14px",
              padding: "14px", borderRadius: "12px",
              background: "var(--color-card)",
              border: "1px solid var(--color-border)",
              textDecoration: "none",
              transition: "border-color 0.15s",
            }}
            onMouseOver={e => (e.currentTarget.style.borderColor = "rgba(139,92,246,0.5)")}
            onMouseOut={e => (e.currentTarget.style.borderColor = "var(--color-border)")}
          >
            <span style={{
              width: "96px", height: "52px", borderRadius: "8px",
              background: p.tileBg,
              border: "1px solid var(--color-border)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <img src={p.logo} alt={p.name} style={{ display: "block", ...p.imgStyle }} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-text-primary)" }}>
                {p.name}
              </div>
              <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5, marginTop: "3px" }}>
                {t(`partners${p.id}`)}
              </div>
              {p.promo && (
                <div style={{
                  display: "inline-flex", alignItems: "center", marginTop: "7px",
                  padding: "3px 9px", borderRadius: "999px",
                  background: "rgba(245,158,11,0.1)",
                  border: "1px solid rgba(245,158,11,0.35)",
                  fontSize: "11px", fontWeight: 600, color: "#f59e0b",
                }}>
                  {t(p.promo)}
                </div>
              )}
            </div>
            <span style={{ fontSize: "13px", color: "var(--color-text-secondary)", flexShrink: 0 }}>↗</span>
          </a>
        ))}
      </div>

      {/* Donation block — the same address and copy flow as the support modal */}
      <div style={{
        padding: "18px 20px", borderRadius: "12px",
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
      }}>
        <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>
          {t("modalThanksTitle")}
        </div>
        <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", lineHeight: 1.6, marginTop: "4px" }}>
          {t("devStoryDetail")}
        </div>
        <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "14px 0 8px" }}>
          USDT · TRC-20 (Tron network)
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: "8px",
          padding: "11px 14px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--color-border)",
          borderRadius: "10px",
        }}>
          <span style={{ fontSize: "18px" }}>💚</span>
          <code style={{
            flex: 1, fontSize: "11.5px",
            color: "var(--color-text-primary)",
            fontFamily: "monospace", wordBreak: "break-all",
            lineHeight: 1.4,
          }}>
            {USDT_ADDRESS}
          </code>
          <button
            onClick={handleCopy}
            style={{
              flexShrink: 0,
              padding: "5px 12px",
              borderRadius: "6px",
              background: copied ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.07)",
              border: `1px solid ${copied ? "rgba(16,185,129,0.4)" : "var(--color-border)"}`,
              fontSize: "11px", fontWeight: 600,
              color: copied ? "#10B981" : "var(--color-text-secondary)",
              cursor: "pointer", transition: "all 0.2s",
              whiteSpace: "nowrap",
            }}
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
        <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", marginTop: "6px" }}>
          {t("usdtNote")}
        </div>
      </div>
    </div>
  );
}
