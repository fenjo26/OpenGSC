"use client";

// Stub from the wave-nov foundation (N0). N9 (docs/tasks/wave-nov/N9-audit-widget-leads.md)
// owns this page and replaces the whole body: incoming leads with findings, status pipeline,
// proposals.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function LeadsPage() {
  const { t } = useLanguage();
  return (
    <div className="main-content">
      <h1>{t("leadTitle")}</h1>
    </div>
  );
}
