"use client";

// SERP Monitor → "Browser captures" tab: SERP pages saved from the extension's overlay.
// E0 lays the placeholder so the tab exists; wave-ext E5 builds the table, the capture drawer
// and the nearest-snapshot comparison.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function CapturesTab(props: { projectId: string }) {
  void props.projectId; // used by E5 to scope the capture list
  const { t } = useLanguage();
  return (
    <div className="panel" style={{ fontSize: 13, color: "var(--color-text-secondary)", padding: "14px 16px" }}>
      {t("serpmonCaptureSoon")}
    </div>
  );
}
