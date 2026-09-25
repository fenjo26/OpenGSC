"use client";

// Stub from the wave-nov foundation (N0). N1 (docs/tasks/wave-nov/N1-footprint-hreflang.md)
// owns this page and replaces the whole body: network footprints — templates repeated across
// the portfolio's published titles/descriptions and generated H1s.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function FootprintPage() {
  const { t } = useLanguage();
  return (
    <div className="main-content">
      <h1>{t("fpTitle")}</h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("fpHint")}</p>
    </div>
  );
}
