"use client";

import { Handshake } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { SUPPORT_PARTNERS } from "@/lib/partners";

// /partners — the full partner wall. The "Support Developer" modal keeps only a compact
// logo grid (the row list outgrew its 420px panel at 11 partners); this page carries the
// descriptions and the running promo badges. Donation stays in the modal — its home.
export default function PartnersPage() {
  const { t } = useLanguage();

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

      {/* Partner cards — min() inside minmax keeps the track from overflowing on
          phones, where fixed 32px page padding leaves less than 320px of content. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))", gap: "14px" }}>
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
    </div>
  );
}
