"use client";

// Stub from the wave-nov foundation (N0). N1 (docs/tasks/wave-nov/N1-footprint-hreflang.md)
// owns this page and replaces the whole body: the hreflang generator (group alternates,
// <head> tags / sitemap block / HTTP header output, live-site verification).

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function HreflangPage() {
  const { t } = useLanguage();
  return (
    <div className="main-content">
      <h1>{t("hlTitle")}</h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("hlHint")}</p>
    </div>
  );
}
