"use client";

import { usePathname, useRouter } from "next/navigation";
import { BarChart2, Activity, ListTodo, Globe, Network, BookOpen, Settings } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

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
    </div>
  );
}
