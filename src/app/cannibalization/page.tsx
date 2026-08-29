"use client";

// Portfolio-wide Keyword Cannibalization view (was /?tab=cannibalization).

import { useState } from "react";
import { Anchor } from "lucide-react";
import KeywordCannibalization from "@/components/KeywordCannibalization";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { isReportDays, setUrlParam } from "@/lib/usePersistedState";

export default function CannibalizationPage() {
  const { t } = useLanguage();
  // ?days= pins the report window so the link can be shared at the window it was read at
  // (both the exact and the related-intent mode honor it).
  const [days] = useState<number | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const raw = new URLSearchParams(window.location.search).get("days");
    const n = Number(raw);
    return raw !== null && isReportDays(n) ? n : undefined;
  });
  return (
    <div className="main-content" style={{ gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <Anchor size={22} style={{ color: "var(--color-accent-blue)" }} />
        <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.02em", margin: 0 }}>{t("menuCannibalization")}</h1>
      </div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "8px" }}>{t("cannibalizationPageSub")}</div>
      <KeywordCannibalization siteDbId="all" initialDays={days} onDaysChange={d => setUrlParam("days", String(d))} />
    </div>
  );
}
