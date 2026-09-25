"use client";

// Stub from the wave foundation (T0). T6 (docs/tasks/wave-oct/T6-mentions.md) owns this file
// and replaces the whole body: Google News + Wikipedia/Wikidata brand mentions feed.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function MentionsPanel({ siteDbId, domain }: { siteDbId: string; domain: string }) {
  const { t } = useLanguage();
  void siteDbId; void domain;
  return (
    <div className="card">
      <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--color-text-primary)" }}>{t("mentionsTitle")}</div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "8px" }}>…</div>
    </div>
  );
}
