"use client";

// 「最后查到」 for a known rank; 「最后检查」 for a successful not-found check.
// Both use the last successful check, not when the scheduler last touched the row.
// Same badge as the site card's GSC sync time, except the
// yellow line is 72h (keywords run every other day) instead of 48h.

import { rankSuccessLabel } from "@/lib/rankFreshness";
import { useLanguage } from "@/lib/i18n/LanguageProvider";

export default function RankFoundAt({ at, notFound = false }: { at: string | null | undefined; notFound?: boolean }) {
  const { t } = useLanguage();
  const { state, text } = rankSuccessLabel(at, {
    at: t(notFound ? "rankLastCheckedAt" : "rankLastFoundAt"),
    never: t("rankLastFoundNever"),
  });
  const warn = state !== "fresh";
  return (
    <span
      className="rank-found-at"
      title={t(notFound ? "rankLastCheckedHint" : "rankLastFoundHint")}
      style={{
        display: "inline-block",
        boxSizing: "border-box",
        width: "max-content",
        maxWidth: "100%",
        fontSize: "10px",
        fontWeight: 700,
        lineHeight: 1.35,
        padding: "2px 6px",
        borderRadius: "4px",
        whiteSpace: "normal",
        overflow: "visible",
        textOverflow: "clip",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
        background: warn ? "rgba(245,158,11,0.16)" : "rgba(255,255,255,0.04)",
        color: warn ? "#F59E0B" : "var(--color-text-secondary)",
        border: warn ? "1px solid rgba(245,158,11,0.45)" : "1px solid transparent",
      }}
    >
      {text}
    </span>
  );
}
