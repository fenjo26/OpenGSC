"use client";

// The «Видимость» hub: the site tab formerly known as "AI Visibility" (deep-link key `aeo`
// stays), now a shell of sub-tabs. T0 builds the shell; the panels are filled by the wave —
// AI answers is the existing AeoTracker, Share of voice and Cited domains land with T7,
// Mentions with T6. LLM Mentions (the DataForSEO index) already existed as BrandVisibility.

import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import AeoTracker from "@/components/AeoTracker";
import BrandVisibility from "@/components/BrandVisibility";
import AiShareOfVoice from "@/components/visibility/AiShareOfVoice";
import CitedDomains from "@/components/visibility/CitedDomains";
import MentionsPanel from "@/components/visibility/MentionsPanel";

// Sub-tab vocabulary. Allow-listed so a stale or foreign ?vis= value falls back to "ai" the
// same way the site page validates ?tab=. "llm" is guest-hidden (see below).
const VIS_TABS = ["ai", "sov", "mentions", "llm"] as const;
type VisTab = typeof VIS_TABS[number];
const isVisTab = (v: unknown): boolean => typeof v === "string" && (VIS_TABS as readonly string[]).includes(v);

export default function VisibilityHub({
  siteDbId, domain, readOnly = false,
}: { siteDbId: string; domain: string; readOnly?: boolean }) {
  const { t } = useLanguage();
  // Deep-linkable sub-tab (?tab=aeo&vis=sov): read once on mount, mirrored back on change —
  // same URL-param store the site page uses for `tab`, so both survive refresh and share.
  const [vis, setVis] = usePersistedState<VisTab>(null, "ai", isVisTab, "vis");

  // The guest (read-only share) view keeps only the analytic sub-tabs: mentions carry
  // outreach actions T6 builds, LLM Mentions spends a DataForSEO key. Mirrors how the site
  // page's TABS drop action-heavy tabs for guests.
  const tabs: { key: VisTab; label: string }[] = [
    { key: "ai", label: t("visTabAi") },
    { key: "sov", label: t("visTabSov") },
    ...(readOnly ? [] : [
      { key: "mentions" as const, label: t("visTabMentions") },
      { key: "llm" as const, label: t("visTabLlm") },
    ]),
  ];
  const active: VisTab = tabs.some(item => item.key === vis) ? vis : "ai";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {tabs.map(({ key, label }) => (
            <button key={key} className={active === key ? "pill active" : "pill"} onClick={() => setVis(key)}
              style={{ cursor: "pointer" }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{t("visHubHint")}</div>
      </div>

      {active === "ai" && <AeoTracker siteDbId={siteDbId} domain={domain} />}
      {active === "sov" && (
        <>
          <AiShareOfVoice siteDbId={siteDbId} domain={domain} readOnly={readOnly} />
          <CitedDomains siteDbId={siteDbId} domain={domain} readOnly={readOnly} />
        </>
      )}
      {active === "mentions" && <MentionsPanel siteDbId={siteDbId} domain={domain} readOnly={readOnly} />}
      {active === "llm" && <BrandVisibility siteDbId={siteDbId} />}
    </div>
  );
}
