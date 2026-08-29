"use client";

// Portfolio-wide Striking Distance view (was /?tab=striking). Self-contained: the
// component fetches /api/gsc/striking?siteId=all itself.

import { useState } from "react";
import { TrendingUp } from "lucide-react";
import StrikingDistanceKeywords from "@/components/StrikingDistanceKeywords";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { isReportDays, setUrlParam } from "@/lib/usePersistedState";

export default function StrikingPage() {
  const { t } = useLanguage();
  // ?days= pins the report window so the link can be shared at the window it was read at;
  // moving the selector in the UI rewrites the param without a navigation.
  const [days] = useState<number | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const raw = new URLSearchParams(window.location.search).get("days");
    const n = Number(raw);
    return raw !== null && isReportDays(n) ? n : undefined;
  });
  return (
    <div className="main-content" style={{ gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <TrendingUp size={22} style={{ color: "var(--color-accent-blue)" }} />
        <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--color-text-primary)", letterSpacing: "-0.02em", margin: 0 }}>{t("menuStriking")}</h1>
      </div>
      <div style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "8px" }}>{t("strikingPageSub")}</div>
      <StrikingDistanceKeywords siteDbId="all" initialDays={days} onDaysChange={d => setUrlParam("days", String(d))} />
    </div>
  );
}
