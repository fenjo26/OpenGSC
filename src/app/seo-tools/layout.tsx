"use client";

import { usePathname, useRouter } from "next/navigation";
import { FileText, Search, ScrollText, Sparkles, History, PenLine, Quote, Globe, LayoutTemplate, SlidersHorizontal, Link2, LayoutGrid, Boxes, Bot, RefreshCw, Fingerprint, FileUp } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

const TABS = [
  { href: "/seo-tools", key: "seoTabHome" as const, icon: LayoutGrid },
  { href: "/seo-tools/cluster", key: "seoTabCluster" as const, icon: Boxes },
  { href: "/seo-tools/geo", key: "geoTabGeo" as const, icon: Globe },
  { href: "/seo-tools/outline", key: "seoTabOutline" as const, icon: FileText },
  { href: "/seo-tools/landing", key: "seoTabLanding" as const, icon: LayoutTemplate },
  { href: "/seo-tools/text", key: "seoTabText" as const, icon: PenLine },
  { href: "/seo-tools/rewrite", key: "seoTabRewrite" as const, icon: RefreshCw },
  { href: "/seo-tools/humanize", key: "seoTabHumanize" as const, icon: Fingerprint },
  { href: "/seo-tools/analysis", key: "seoTabAnalysis" as const, icon: Search },
  { href: "/seo-tools/googlebot", key: "seoTabGooglebot" as const, icon: Bot },
  { href: "/seo-tools/citations", key: "seoTabCitations" as const, icon: Quote },
  { href: "/seo-tools/links", key: "seoTabLinks" as const, icon: Link2 },
  { href: "/seo-tools/import", key: "menuImport" as const, icon: FileUp },
  { href: "/seo-tools/policy", key: "seoTabPolicy" as const, icon: ScrollText },
  { href: "/seo-tools/history", key: "seoTabHistory" as const, icon: History },
];

export default function SeoToolsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useLanguage();

  return (
    <div style={{ padding: "28px 32px 60px", maxWidth: "1280px", margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: 38, height: 38, borderRadius: "10px",
            background: "rgba(191,90,242,0.14)", border: "1px solid rgba(191,90,242,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Sparkles size={20} color="var(--color-accent-purple)" />
          </div>
          <div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", margin: 0 }}>
              {t("seoNavTitle")}
            </h1>
            <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: "2px 0 0" }}>
              {t("seoSubtitle")}
            </p>
          </div>
        </div>
        {/* Keys/models/policies now live in project Settings — single place for all keys */}
        <button
          onClick={() => router.push("/settings?tab=seo-tools")}
          style={{
            display: "flex", alignItems: "center", gap: "6px", padding: "8px 14px", borderRadius: "8px",
            border: "1px solid var(--color-border)", background: "var(--color-card)",
            color: "var(--color-text-secondary)", fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          <SlidersHorizontal size={13} /> {t("seoTabSettings")}
        </button>
      </div>

      {/* Sub-tabs */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "20px", marginBottom: "24px",
        borderBottom: "1px solid var(--color-border)", paddingBottom: "0",
      }}>
        {TABS.map(({ href, key, icon: Icon }) => {
          const active = pathname === href;
          return (
            <button
              key={href}
              onClick={() => router.push(href)}
              style={{
                display: "flex", alignItems: "center", gap: "7px",
                padding: "10px 16px", fontSize: "13px", fontWeight: active ? 700 : 500,
                background: "transparent", border: "none", cursor: "pointer",
                color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                borderBottom: active ? "2px solid var(--color-accent-purple)" : "2px solid transparent",
                marginBottom: "-1px", transition: "color 0.15s",
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
