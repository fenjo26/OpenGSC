"use client";

// Stub from the wave-nov foundation (N0). N6 (docs/tasks/wave-nov/N6-plagiarism-serp-index.md)
// owns this page and replaces the whole body: paste text / pick from history, cost estimate
// before the run, sources and highlighted fragments.

import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function PlagiarismPage() {
  const { t } = useLanguage();
  return (
    <div className="main-content">
      <h1>{t("plgTitle")}</h1>
      <p style={{ color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("plgHint")}</p>
    </div>
  );
}
