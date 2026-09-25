"use client";

// Stub from the wave foundation (T0). T4 (docs/tasks/wave-oct/T4-index-autocheck.md) owns this
// file and replaces the whole body: automatic URL Inspection inside Google's free quota.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function IndexAutoPanel({ siteDbId, domain }: { siteDbId: string; domain: string }) {
  const { t } = useLanguage();
  void siteDbId; void domain;
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("idxAutoTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
