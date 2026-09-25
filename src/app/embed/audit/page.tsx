"use client";

// Stub from the wave-nov foundation (N0). N9 (docs/tasks/wave-nov/N9-audit-widget-leads.md)
// owns this page and replaces the whole body: the PUBLIC embeddable audit widget (no app
// shell, no session — the proxy lets /embed/ through and the page itself enforces the
// widgetKey, rate limits and Turnstile).

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function EmbedAuditPage() {
  const { t } = useLanguage();
  return (
    <div style={{ padding: "20px", fontFamily: "inherit" }}>
      <div style={{ fontSize: "17px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("leadEmbedTitle")}</div>
    </div>
  );
}
