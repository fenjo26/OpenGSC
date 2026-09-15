"use client";

// One chip per HOST. The server already deduplicated a host's URLs into a single HostChange
// (the screenshot from the reference post showed "−pba.betsson.bet.ar" nine times in a row
// because it compared URLs — that bug stays dead here), so the row renders changes verbatim:
//   enter → green "+host #to" · exit → red "−host" (tooltip: dropped, was #from)
//   up    → green "↑host from→to" · down → red "↓host from→to", and "×N" when the host holds
// more than one URL in the snapshot. Platform/ignored hosts are stored server-side with
// hidden: true — they render only when "Show platforms" is on, dimmed. Clicking a chip puts
// the host into the Market tab's domain filter.

import { useState } from "react";
import type { HostChange } from "@/lib/serpmon/types";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { trOf, type Tr } from "./shared";

/** Colour semantics of a change: enter/up are gains (green), exit/down are losses (red). */
function chipColor(kind: HostChange["kind"]): string {
  return kind === "enter" || kind === "up" ? "var(--color-success)" : "var(--color-danger)";
}

function chipLabel(c: HostChange): string {
  if (c.kind === "enter") return `+${c.host} #${c.to}`;
  if (c.kind === "exit") return `−${c.host}`;
  return `${c.kind === "up" ? "↑" : "↓"}${c.host} ${c.from}→${c.to}`;
}

function chipTitle(c: HostChange, tr: Tr): string {
  let title: string;
  if (c.kind === "enter") title = tr("serpmonChangeEnter").replace("{to}", String(c.to));
  else if (c.kind === "exit") title = tr("serpmonChangeExit").replace("{from}", String(c.from));
  else title = tr("serpmonChangeMove").replace("{from}", String(c.from)).replace("{to}", String(c.to));
  if (c.urls > 1) title += `\n${tr("serpmonUrlsCount").replace("{n}", String(c.urls))}`;
  return title;
}

export function ChangeChip({ change, dim, onHostClick }: {
  change: HostChange;
  /** Platform host shown because "Show platforms" is on — visually muted. */
  dim: boolean;
  onHostClick?: (host: string) => void;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onHostClick?.(change.host); }}
      title={chipTitle(change, tr)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        maxWidth: 230, padding: "1px 7px", borderRadius: 6, fontSize: 11, lineHeight: 1.6,
        border: `1px solid ${chipColor(change.kind)}`, color: chipColor(change.kind),
        background: "transparent", opacity: dim ? 0.5 : 1, cursor: "pointer",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0,
      }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{chipLabel(change)}</span>
      {change.urls > 1 && <span style={{ opacity: 0.75 }}>×{change.urls}</span>}
    </button>
  );
}

/** The chips cell of one keyword row: hidden hosts filtered until "Show platforms" is on,
 *  more than 20 visible chips collapse behind an "ещё N" expander. Failed/partial rows never
 *  reach this component — the tab shows their problem line instead. */
export function ChangeChips({ changes, showPlatforms, onHostClick }: {
  changes: HostChange[];
  showPlatforms: boolean;
  onHostClick?: (host: string) => void;
}) {
  const { t } = useLanguage();
  const tr = trOf(t);
  const [expanded, setExpanded] = useState(false);
  const visible = changes.filter(c => showPlatforms || !c.hidden);
  // A shake can legitimately bring 10+ hosts in at once — 20 covers a real churn wave without
  // letting a pathological row run for a hundred chips; everything past that is one click away.
  const LIMIT = 20;
  const shown = expanded ? visible : visible.slice(0, LIMIT);
  if (!visible.length) return null;
  return (
    <span onClick={e => e.stopPropagation()} style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {shown.map((c, i) => (
        <ChangeChip key={`${c.host}-${c.kind}-${i}`} change={c} dim={c.hidden} onHostClick={onHostClick} />
      ))}
      {visible.length > LIMIT && !expanded && (
        <button
          onClick={e => { e.stopPropagation(); setExpanded(true); }}
          title={tr("serpmonMoreCount").replace("{n}", String(visible.length - LIMIT))}
          style={{
            padding: "1px 7px", borderRadius: 6, fontSize: 11, cursor: "pointer",
            border: "1px dashed var(--color-border)", color: "var(--color-text-secondary)",
            background: "transparent", whiteSpace: "nowrap",
          }}>
          {tr("serpmonMoreCount").replace("{n}", String(visible.length - LIMIT))}
        </button>
      )}
    </span>
  );
}
