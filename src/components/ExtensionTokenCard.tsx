"use client";

// Stub from the wave-nov foundation (N0). N11 (docs/tasks/wave-nov/N11-browser-extension.md)
// owns this file and replaces the whole body: extension bearer token (create / regenerate /
// revoke) and allowed extension IDs for CORS — shown in Settings.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function ExtensionTokenCard() {
  const { t } = useLanguage();
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("extTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
