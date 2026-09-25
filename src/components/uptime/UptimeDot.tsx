"use client";

// The dashboard status dot: one 8px circle, one text label. The colour is never the only
// carrier of meaning — every state also has an aria-label/title (status, since, cause, 24h
// uptime). A site without a monitor renders NO dot: a gray dot would read as "checked and
// unknown" and a green one would lie outright (null ≠ 0 ≠ "not checked").
//
// The pulse is a class + one <style> block rather than an inline animation, so
// prefers-reduced-motion can switch it off — inline styles cannot carry media queries.

import { useLanguage } from "@/lib/i18n/LanguageProvider";
import type { UptimeBadge, UptimeStatus } from "@/lib/uptime/types";

const COLORS: Record<UptimeStatus, string> = {
  up: "var(--color-accent-green)",
  degraded: "var(--color-accent-orange)",
  down: "var(--color-accent-red)",
  unknown: "var(--color-text-muted)",
  paused: "var(--color-text-muted)",
  checker_offline: "var(--color-text-muted)",
};

export default function UptimeDot({ badge, size = 8 }: { badge: UptimeBadge | null; size?: number }) {
  const { t, language } = useLanguage();
  if (!badge) return null;

  const label = [
    t(`uptimeStatus_${badge.status}` as Parameters<typeof t>[0]),
    badge.since && ["down", "degraded", "up"].includes(badge.status)
      ? t("uptimeSince").replace("{time}", new Date(badge.since).toLocaleString(language, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }))
      : null,
    badge.status === "down" && badge.lastError ? badge.lastError : null,
    badge.uptime24h != null ? `${t("uptime24h")} · ${badge.uptime24h.toFixed(1)}%` : null,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <style>{`
        @keyframes uptime-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .uptime-dot-down { animation: uptime-dot-pulse 2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .uptime-dot-down { animation: none; } }
      `}</style>
      <span
        role="img"
        aria-label={label}
        title={label}
        className={badge.status === "down" ? "uptime-dot-down" : undefined}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          flexShrink: 0,
          display: "inline-block",
          background: COLORS[badge.status] ?? "var(--color-text-muted)",
          boxShadow: badge.status === "down" ? "0 0 0 2px rgba(255,69,58,0.25)" : undefined,
        }}
      />
    </>
  );
}
