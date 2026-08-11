// The SEO Tools list, in one place.
//
// It used to live twice — once as the tab bar in the layout, once as the tile grid on the hub —
// and the two drifted apart the moment a tool was added to one of them. That is not a styling
// bug: a user reads the tab order, then looks at the tiles and finds a different arrangement
// with an item missing, and has no way to tell which list is authoritative.
//
// Both surfaces now render this array, so the order is the same by construction and a new tool
// cannot appear in one and not the other.

import {
  Boxes, Globe, FileText, LayoutTemplate, PenLine, RefreshCw, Fingerprint, Search, Bot,
  Quote, Link2, ScrollText, History, Compass, Users, Workflow, type LucideIcon,
} from "lucide-react";

export interface SeoTool {
  href: string;
  /** i18n key for the label — the tab bar and the tile heading use the same one. */
  key: string;
  /** i18n key for the tile description. Tabs ignore it. */
  desc: string;
  icon: LucideIcon;
  /** Tile accent, also used for the hover border. */
  color: string;
}

export const SEO_TOOLS: SeoTool[] = [
  // Research comes first: both entries answer "what should I write about" and are where a
  // session starts, whereas everything below them assumes that question is already settled.
  { href: "/seo-tools/demand",      key: "seoTabDemand",      desc: "seoTileDemand",      icon: Compass, color: "#2997ff" },
  { href: "/seo-tools/competitors", key: "seoTabCompetitors", desc: "seoTileCompetitors", icon: Users,   color: "#5e5ce6" },
  { href: "/seo-tools/cluster",   key: "seoTabCluster",   desc: "seoTileCluster",   icon: Boxes,         color: "#bf5af2" },
  { href: "/seo-tools/geo",       key: "geoTabGeo",       desc: "seoTileGeo",       icon: Globe,         color: "#5e5ce6" },
  { href: "/seo-tools/outline",   key: "seoTabOutline",   desc: "seoTileOutline",   icon: FileText,      color: "#2997ff" },
  { href: "/seo-tools/landing",   key: "seoTabLanding",   desc: "seoTileLanding",   icon: LayoutTemplate, color: "#ff9f0a" },
  { href: "/seo-tools/text",      key: "seoTabText",      desc: "seoTileText",      icon: PenLine,       color: "#34c759" },
  { href: "/seo-tools/rewrite",   key: "seoTabRewrite",   desc: "seoTileRewrite",   icon: RefreshCw,     color: "#30d158" },
  { href: "/seo-tools/humanize",  key: "seoTabHumanize",  desc: "seoTileHumanize",  icon: Fingerprint,   color: "#ff6482" },
  { href: "/seo-tools/analysis",  key: "seoTabAnalysis",  desc: "seoTileAnalysis",  icon: Search,        color: "#10A37F" },
  { href: "/seo-tools/googlebot", key: "seoTabGooglebot", desc: "seoTileGooglebot", icon: Bot,           color: "#4285F4" },
  { href: "/seo-tools/citations", key: "seoTabCitations", desc: "seoTileCitations", icon: Quote,         color: "#ff375f" },
  { href: "/seo-tools/links",     key: "seoTabLinks",     desc: "seoTileLinks",     icon: Link2,         color: "#64d2ff" },
  { href: "/seo-tools/policy",    key: "seoTabPolicy",    desc: "seoTilePolicy",    icon: ScrollText,    color: "#ffd60a" },
  { href: "/seo-tools/content-ops", key: "contentOpsTab", desc: "contentOpsTile", icon: Workflow, color: "#ff9f0a" },
  { href: "/seo-tools/history",   key: "seoTabHistory",   desc: "seoTileHistory",   icon: History,       color: "#8e8e93" },
];
