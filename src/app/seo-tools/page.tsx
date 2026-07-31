"use client";

// SEO Tools hub: tile grid — one tile per tool. The top tab bar stays for quick switching
// between tools, but this page is the roomy entry point (tabs were getting too narrow).

import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { SEO_TOOLS } from "@/lib/seo/toolsNav";

// Same order as the tab bar, because it is the same array. Settings is appended rather than
// listed among the tools: it configures them, it is not one of them.
const TILES = [
  ...SEO_TOOLS,
  { href: "/seo-tools/settings", key: "seoTabSettingsTile", desc: "seoTileSettings", icon: SlidersHorizontal, color: "#98989d" },
];

export default function SeoToolsIndex() {
  const { t } = useLanguage();
  return (
    // gridAutoRows:1fr equalizes EVERY row, not just the items within one row. Without it a short
    // final row (two tiles) sizes itself to its own content and ends up visibly shorter than the
    // full rows above it.
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "14px", gridAutoRows: "1fr" }}>
      {TILES.map(({ href, key, desc, icon: Icon, color }) => (
        // The <a> is the grid item and stretches to the row height; making it a flex container is
        // what lets the panel inside actually fill it. `height:100%` on the panel alone did nothing,
        // because the link itself had no resolved height to be a percentage of.
        <Link key={href} href={href} style={{ textDecoration: "none", display: "flex" }}>
          <div className="panel" style={{ flex: 1, cursor: "pointer", display: "flex", flexDirection: "column", gap: "10px", transition: "border-color 0.15s" }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = color)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--color-border)")}>
            <div style={{ width: 40, height: 40, borderRadius: "10px", background: `${color}1a`, border: `1px solid ${color}40`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon size={20} color={color} />
            </div>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t(key as any)}</div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t(desc as any)}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}
