"use client";

// SEO Tools hub: tile grid — one tile per tool. The top tab bar stays for quick switching
// between tools, but this page is the roomy entry point (tabs were getting too narrow).

import Link from "next/link";
import { FileText, Search, ScrollText, History, PenLine, Quote, Globe, LayoutTemplate, Link2, Boxes, SlidersHorizontal, Bot, RefreshCw, Fingerprint } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

const TILES = [
  { href: "/seo-tools/cluster", key: "seoTabCluster", desc: "seoTileCluster", icon: Boxes, color: "#bf5af2" },
  { href: "/seo-tools/outline", key: "seoTabOutline", desc: "seoTileOutline", icon: FileText, color: "#2997ff" },
  { href: "/seo-tools/landing", key: "seoTabLanding", desc: "seoTileLanding", icon: LayoutTemplate, color: "#ff9f0a" },
  { href: "/seo-tools/text", key: "seoTabText", desc: "seoTileText", icon: PenLine, color: "#34c759" },
  { href: "/seo-tools/rewrite", key: "seoTabRewrite", desc: "seoTileRewrite", icon: RefreshCw, color: "#30d158" },
  { href: "/seo-tools/humanize", key: "seoTabHumanize", desc: "seoTileHumanize", icon: Fingerprint, color: "#ff6482" },
  { href: "/seo-tools/analysis", key: "seoTabAnalysis", desc: "seoTileAnalysis", icon: Search, color: "#10A37F" },
  { href: "/seo-tools/googlebot", key: "seoTabGooglebot", desc: "seoTileGooglebot", icon: Bot, color: "#4285F4" },
  { href: "/seo-tools/geo", key: "geoTabGeo", desc: "seoTileGeo", icon: Globe, color: "#5e5ce6" },
  { href: "/seo-tools/citations", key: "seoTabCitations", desc: "seoTileCitations", icon: Quote, color: "#ff375f" },
  { href: "/seo-tools/links", key: "seoTabLinks", desc: "seoTileLinks", icon: Link2, color: "#64d2ff" },
  { href: "/seo-tools/policy", key: "seoTabPolicy", desc: "seoTilePolicy", icon: ScrollText, color: "#ffd60a" },
  { href: "/seo-tools/history", key: "seoTabHistory", desc: "seoTileHistory", icon: History, color: "#8e8e93" },
  { href: "/seo-tools/settings", key: "seoTabSettingsTile", desc: "seoTileSettings", icon: SlidersHorizontal, color: "#98989d" },
] as const;

export default function SeoToolsIndex() {
  const { t } = useLanguage();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "14px" }}>
      {TILES.map(({ href, key, desc, icon: Icon, color }) => (
        <Link key={href} href={href} style={{ textDecoration: "none" }}>
          <div className="panel" style={{ height: "100%", cursor: "pointer", display: "flex", flexDirection: "column", gap: "10px", transition: "border-color 0.15s" }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = color)}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--color-border)")}>
            <div style={{ width: 40, height: 40, borderRadius: "10px", background: `${color}1a`, border: `1px solid ${color}40`, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
