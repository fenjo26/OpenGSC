"use client";

// Stub from the wave-nov foundation (N0). N9 (docs/tasks/wave-nov/N9-audit-widget-leads.md)
// owns this file and replaces the whole body: widget on/off, key management, allowed origins,
// consent text, Turnstile status, embed code — shown in Settings.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function WidgetSettingsCard() {
  const { t } = useLanguage();
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("leadWidgetTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
