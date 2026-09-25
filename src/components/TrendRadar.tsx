"use client";

// Stub from the wave-nov foundation (N0). N5 (docs/tasks/wave-nov/N5-trend-radar.md) owns this
// file and replaces the whole body: the Trend radar block on /demand — seed chips, three
// source columns, "track position" / "create outline" actions.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function TrendRadar() {
  const { t } = useLanguage();
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("trTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
