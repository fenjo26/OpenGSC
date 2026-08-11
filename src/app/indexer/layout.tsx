"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BarChart2, Activity, ListTodo, Globe, Network, BookOpen, Settings, ShieldAlert } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

const RISK_ACK_KEY = "opengsc:indexer-risk:v1";

const TABS = [
  { href: "/indexer/stats", key: "indexerTabStats" as const, icon: BarChart2 },
  { href: "/indexer/logs", key: "indexerTabLogs" as const, icon: Activity },
  { href: "/indexer/queue", key: "indexerTabQueue" as const, icon: ListTodo },
  { href: "/indexer/domains", key: "indexerTabDomains" as const, icon: Globe },
  { href: "/indexer/links", key: "indexerTabLinks" as const, icon: Network },
  { href: "/indexer/dictionary", key: "indexerTabDict" as const, icon: BookOpen },
  { href: "/indexer/settings", key: "indexerTabSettings" as const, icon: Settings },
];

export default function IndexerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useLanguage();
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setAcknowledged(localStorage.getItem(RISK_ACK_KEY) === "accepted");
  }, []);

  const acknowledgeRisk = () => {
    if (!accepted) return;
    localStorage.setItem(RISK_ACK_KEY, "accepted");
    setAcknowledged(true);
  };

  return (
    <div style={{ padding: "28px var(--page-padding) 60px", maxWidth: "var(--page-max-width)", margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "6px" }}>
        <div style={{
          width: 38,
          height: 38,
          borderRadius: "10px",
          background: "rgba(41,151,255,0.14)",
          border: "1px solid rgba(41,151,255,0.3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          <Globe size={20} color="var(--color-accent-blue)" />
        </div>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
            {t("indexerNavTitle")}
          </h1>
          <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "2px 0 0" }}>
            {t("indexerSubtitle")}
          </p>
        </div>
      </div>

      {acknowledged === false && (
        <div className="card" style={{ marginTop: "22px", padding: "24px", borderColor: "rgba(239,68,68,0.35)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "14px" }}>
            <div style={{ width: 38, height: 38, borderRadius: "10px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)" }}>
              <ShieldAlert size={20} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ margin: 0, color: "var(--color-text-primary)", fontSize: "17px" }}>{t("indexerRiskTitle")}</h2>
              <p style={{ margin: "8px 0 0", color: "var(--color-text-secondary)", fontSize: "13px", lineHeight: 1.7 }}>{t("indexerRiskBody")}</p>
              <p style={{ margin: "8px 0 0", color: "var(--color-text-secondary)", fontSize: "13px", lineHeight: 1.7 }}>{t("indexerRiskOptional")}</p>
              <a href="https://github.com/fenjo26/opengsc/blob/main/docs/RESPONSIBLE-USE.md" target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: "10px", color: "var(--color-accent-blue)", fontSize: "12px", fontWeight: 600 }}>
                {t("indexerRiskRead")} ↗
              </a>
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "9px", marginTop: "20px", color: "var(--color-text-primary)", fontSize: "13px", lineHeight: 1.5, cursor: "pointer" }}>
            <input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} style={{ marginTop: "3px" }} />
            <span>{t("indexerRiskConfirm")}</span>
          </label>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "16px" }}>
            <button type="button" onClick={acknowledgeRisk} disabled={!accepted} style={{ padding: "9px 16px", border: "none", borderRadius: "8px", background: "var(--color-accent-blue)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: accepted ? "pointer" : "not-allowed", opacity: accepted ? 1 : 0.45 }}>
              {t("indexerRiskContinue")}
            </button>
            <button type="button" onClick={() => router.push("/")} style={{ padding: "9px 16px", border: "1px solid var(--color-border)", borderRadius: "8px", background: "transparent", color: "var(--color-text-primary)", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              {t("indexerRiskLeave")}
            </button>
          </div>
        </div>
      )}

      {acknowledged === true && <>
      <div className="panel" style={{ marginTop: "18px", padding: "10px 13px", display: "flex", alignItems: "flex-start", gap: "9px", borderColor: "rgba(245,158,11,0.28)", background: "rgba(245,158,11,0.06)" }}>
        <ShieldAlert size={15} color="#F59E0B" style={{ marginTop: "1px", flexShrink: 0 }} />
        <div style={{ color: "var(--color-text-secondary)", fontSize: "12px", lineHeight: 1.5 }}>
          {t("indexerRiskBanner")} {" "}
          <a href="https://github.com/fenjo26/opengsc/blob/main/docs/RESPONSIBLE-USE.md" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent-blue)", fontWeight: 600 }}>{t("indexerRiskRead")}</a>
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{
        display: "flex",
        gap: "4px",
        marginTop: "20px",
        marginBottom: "24px",
        borderBottom: "1px solid var(--color-border)",
        paddingBottom: "0",
        overflowX: "auto",
      }}>
        {TABS.map(({ href, key, icon: Icon }) => {
          const active = pathname === href || (pathname === "/indexer" && href.endsWith("/stats"));
          return (
            <button
              key={href}
              onClick={() => router.push(href)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "7px",
                padding: "10px 16px",
                fontSize: "13px",
                fontWeight: active ? 700 : 500,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                borderBottom: active ? "2px solid var(--color-accent-blue)" : "2px solid transparent",
                marginBottom: "-1px",
                transition: "color 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              <Icon size={15} />
              {t(key)}
            </button>
          );
        })}
      </div>

      {children}
      </>}
    </div>
  );
}
