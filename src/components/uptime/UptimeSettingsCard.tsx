"use client";

// Stub from the wave foundation (T0). T2 (docs/tasks/wave-oct/T2-uptime.md) owns this file and
// replaces the whole body: workspace-wide uptime settings (auto-enroll, interval, reminders,
// heartbeat) shown in Settings.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function UptimeSettingsCard() {
  const { t } = useLanguage();
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("uptimeSettingsTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
