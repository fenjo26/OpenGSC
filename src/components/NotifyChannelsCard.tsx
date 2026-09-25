"use client";

// Stub from the wave foundation (T0). T3 (docs/tasks/wave-oct/T3-notify-channels.md) owns this
// file and replaces the whole body: Discord / Teams / e-mail / webhook delivery channels.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function NotifyChannelsCard() {
  const { t } = useLanguage();
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("notifyChTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
