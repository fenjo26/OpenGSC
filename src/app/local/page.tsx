"use client";

// Stub from the wave-nov foundation (N0). N4 (docs/tasks/wave-nov/N4-local-seo.md) owns this
// page and replaces the whole body: Local SEO — business profile, NAP check, directories,
// schema generator, Google Business Profile.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function LocalPage() {
  const { t } = useLanguage();
  return (
    <div className="main-content">
      <h1>{t("locTitle")}</h1>
    </div>
  );
}
