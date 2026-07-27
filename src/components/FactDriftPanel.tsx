"use client";

// Renders the fact-drift check for a rewritten text.
//
// Placed next to every rewrite output rather than behind a link, because the risk it covers is
// invisible by construction: a rewritten article reads perfectly whether or not the price in it is
// still correct. Invented values are ranked above dropped ones — a wrong number ships and gets
// published, a missing one usually just reads as a gap.

import { AlertTriangle, ShieldCheck, MinusCircle, PlusCircle } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { driftSeverity, type FactDrift } from "@/lib/seo/factDrift";

const COLORS = { clean: "#34c759", warn: "#ff9f0a", danger: "#ff375f" } as const;

function Chips({ items, color }: { items: string[]; color: string }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
      {items.slice(0, 30).map((x, i) => (
        <span key={`${x}-${i}`} style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "20px", color, background: `${color}1f` }}>{x}</span>
      ))}
      {items.length > 30 && <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>+{items.length - 30}</span>}
    </div>
  );
}

export default function FactDriftPanel({ drift }: { drift: FactDrift }) {
  const { t } = useLanguage();
  const sev = driftSeverity(drift);
  const color = COLORS[sev];

  const added = [...drift.numbers.added, ...drift.identifiers.added];
  const lost = [...drift.numbers.lost, ...drift.identifiers.lost];

  return (
    <div style={{ border: `1px solid ${color}55`, background: `${color}0d`, borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color }}>
        {sev === "clean" ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}
        {t((sev === "clean" ? "fdClean" : sev === "warn" ? "fdWarn" : "fdDanger") as never)}
        <span style={{ fontWeight: 500, color: "var(--color-text-secondary)", fontSize: "12px" }}>
          · {drift.numbers.kept + drift.identifiers.kept} {t("fdKept" as never)}
        </span>
      </div>

      {added.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 600, color: COLORS.danger }}>
            <PlusCircle size={13} /> {t("fdAdded" as never)}
          </div>
          <Chips items={added} color={COLORS.danger} />
        </div>
      )}

      {lost.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 600, color: COLORS.warn }}>
            <MinusCircle size={13} /> {t("fdLost" as never)}
          </div>
          <Chips items={lost} color={COLORS.warn} />
        </div>
      )}

      {/* States the limit of the check explicitly. It verifies values, not claims — implying more
          would be worse than saying nothing, because it would buy false confidence. */}
      <div style={{ fontSize: "11px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{t("fdScope" as never)}</div>
    </div>
  );
}
