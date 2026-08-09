"use client";

import { usePathname, useRouter } from "next/navigation";
import { Sparkles, LayoutGrid } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { SEO_TOOLS } from "@/lib/seo/toolsNav";
import AiModelBadge from "@/components/AiModelBadge";

// "All tools" first, then the shared list — see src/lib/seo/toolsNav.ts for why the list is
// not written out here.
const TABS = [
  { href: "/seo-tools", key: "seoTabHome" as const, icon: LayoutGrid },
  ...SEO_TOOLS,
];

export default function SeoToolsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useLanguage();

  return (
    <div style={{ padding: "28px var(--page-padding) 60px", maxWidth: "var(--page-max-width)", margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
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
        {/* Keys/models/policies live in project Settings — single place for all keys. The button
            names the model the current tool will actually use, so the link reads as an answer
            rather than a place to go looking. */}
        <AiModelBadge pathname={pathname} />
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
              {t(key as never)}
            </button>
          );
        })}
      </div>

      {children}
    </div>
  );
}
