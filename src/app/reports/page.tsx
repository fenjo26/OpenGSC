"use client";

// Stub from the wave-nov foundation (N0). N8 (docs/tasks/wave-nov/N8-client-reports.md) owns
// this page and replaces the whole body: client reports — list, constructor, preview, client
// link, sent snapshots.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function ReportsPage() {
  const { t } = useLanguage();
  return (
    <div className="main-content">
      <h1>{t("repTitle")}</h1>
    </div>
  );
}
