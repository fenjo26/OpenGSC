"use client";

// Stub from the wave foundation (T0). T2 (docs/tasks/wave-oct/T2-uptime.md) owns this file and
// replaces the whole body: per-site uptime summary, incidents, monitor settings.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function UptimePanel({ siteDbId }: { siteDbId: string }) {
  const { t } = useLanguage();
  void siteDbId;
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("uptimeTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
