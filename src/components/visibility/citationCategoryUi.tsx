"use client";

// Wave A — shared UI vocabulary for citation classification: the locale key and the colour of
// each category/page type. Pure mapping, no logic — the classifier itself lives in
// lib/seo/aeoCitationClassify and knows nothing about locales, so this file is the only place
// that knows "forum" renders as t("aeoCatForum") in amber.

import type { CitationCategory, CitationPageType } from "@/lib/seo/aeoCitationClassify";

// Mechanical mapping (aeoCat + Capitalized id; forum-thread → aeoPageForumThread) kept explicit
// so a renamed category fails the typecheck here instead of rendering a missing key at runtime.
export const CATEGORY_LABEL_KEY: Record<CitationCategory, "aeoCatBrand" | "aeoCatCompetitor" | "aeoCatForum" | "aeoCatSocial" | "aeoCatVideo" | "aeoCatDeveloper" | "aeoCatEcommerce" | "aeoCatReviews" | "aeoCatReference" | "aeoCatInstitutional" | "aeoCatEditorial" | "aeoCatOther"> = {
  brand: "aeoCatBrand",
  competitor: "aeoCatCompetitor",
  forum: "aeoCatForum",
  social: "aeoCatSocial",
  video: "aeoCatVideo",
  developer: "aeoCatDeveloper",
  ecommerce: "aeoCatEcommerce",
  reviews: "aeoCatReviews",
  reference: "aeoCatReference",
  institutional: "aeoCatInstitutional",
  editorial: "aeoCatEditorial",
  other: "aeoCatOther",
};

export const PAGE_TYPE_LABEL_KEY: Record<CitationPageType, "aeoPageHomepage" | "aeoPageArticle" | "aeoPageListicle" | "aeoPageHowto" | "aeoPageComparison" | "aeoPageReview" | "aeoPageProduct" | "aeoPageDoc" | "aeoPageForumThread" | "aeoPageVideo" | "aeoPageOther"> = {
  homepage: "aeoPageHomepage",
  article: "aeoPageArticle",
  listicle: "aeoPageListicle",
  howto: "aeoPageHowto",
  comparison: "aeoPageComparison",
  review: "aeoPageReview",
  product: "aeoPageProduct",
  doc: "aeoPageDoc",
  "forum-thread": "aeoPageForumThread",
  video: "aeoPageVideo",
  other: "aeoPageOther",
};

// One stable colour per category so the chart, the table badges and the Reddit block read as one
// system. Brand keeps the tracker's green and competitor its violet — those two already mean
// "us" and "rival" everywhere else in the AEO surfaces.
export const CATEGORY_COLOR: Record<CitationCategory, string> = {
  brand: "#10B981",
  competitor: "#8B5CF6",
  forum: "#F59E0B",
  social: "#3B82F6",
  video: "#EF4444",
  developer: "#64748B",
  ecommerce: "#14B8A6",
  reviews: "#EAB308",
  reference: "#94A3B8",
  institutional: "#6366F1",
  editorial: "#F43F5E",
  other: "#A78BFA",
};

/** Small uppercase pill naming a citation's category; the page type rides in the tooltip next
 *  to it (the domain row already links to the URL — the badge explains WHAT was cited). */
export function CategoryBadge({ category, pageType, t }: {
  category: CitationCategory;
  pageType?: CitationPageType | null;
  t: (k: "aeoCatBrand" | "aeoCatCompetitor" | "aeoCatForum" | "aeoCatSocial" | "aeoCatVideo" | "aeoCatDeveloper" | "aeoCatEcommerce" | "aeoCatReviews" | "aeoCatReference" | "aeoCatInstitutional" | "aeoCatEditorial" | "aeoCatOther" | "aeoPageHomepage" | "aeoPageArticle" | "aeoPageListicle" | "aeoPageHowto" | "aeoPageComparison" | "aeoPageReview" | "aeoPageProduct" | "aeoPageDoc" | "aeoPageForumThread" | "aeoPageVideo" | "aeoPageOther") => string;
}) {
  const color = CATEGORY_COLOR[category];
  const label = t(CATEGORY_LABEL_KEY[category]);
  const title = pageType ? `${label} · ${t(PAGE_TYPE_LABEL_KEY[pageType])}` : label;
  return (
    <span title={title} aria-label={title} style={{
      fontSize: "9px", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
      padding: "1px 6px", borderRadius: "999px", whiteSpace: "nowrap",
      color, border: `1px solid ${color}55`, background: `${color}14`,
    }}>
      {label}
    </span>
  );
}
