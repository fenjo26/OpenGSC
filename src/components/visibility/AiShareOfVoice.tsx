"use client";

// Stub from the wave foundation (T0). T7 (docs/tasks/wave-oct/T7-ai-share-of-voice.md) owns
// this file and replaces the whole body: share of voice in AI answers vs competitors.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function AiShareOfVoice({ siteDbId, domain }: { siteDbId: string; domain: string }) {
  const { t } = useLanguage();
  void siteDbId; void domain;
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("aiSovTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
