"use client";

// Stub from the wave-nov foundation (N0). N10 (docs/tasks/wave-nov/N10-pwa-push.md) owns this
// file and replaces the whole body: enable/disable push on this device, device list, per-device
// event filter, test send, HTTPS/iOS support status, install button — shown in Settings.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function PushSettingsCard() {
  const { t } = useLanguage();
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("pwaPushTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
