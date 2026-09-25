"use client";

// Stub from the wave-nov foundation (N0). N8 (docs/tasks/wave-nov/N8-client-reports.md) owns
// this file and replaces the whole body: white-label branding (company name, logo, accent
// colour, footer, "Made with OpenGSC" switch) shown in Settings.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function ReportBrandingCard() {
  const { t } = useLanguage();
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("repBrandingTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
