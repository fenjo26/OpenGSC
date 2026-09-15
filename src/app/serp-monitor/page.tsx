"use client";

// Stub page so the /serp-monitor route exists from T0 on: the menu entry needs somewhere to
// land, and T1…T6 need the locale keys live while they build against the shared types.
// T5 rewrites this file entirely (docs/tasks/serp-monitor/).
import { Waves } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function SerpMonitorPage() {
  const { t } = useLanguage();

  return (
    <div className="main-content" style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 20, paddingBottom: 40 }}>
      <div>
        <h1 style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 22, margin: 0, color: "var(--color-text-primary)" }}>
          <Waves size={20} /> {t("serpmonTitle")}
        </h1>
        <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 6, maxWidth: 820 }}>
          {t("serpmonSubtitle")}
        </p>
      </div>
      <p style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{t("serpmonEmpty")}</p>
    </div>
  );
}
