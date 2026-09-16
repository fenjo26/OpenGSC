// SERP Monitor — refill the positions A-Parser mis-resolved, from the keyword's previous take.
// Pure module: no server-only imports.
//
// The mapper drops a row whose link A-Parser shifted onto it (see shiftedGotoRows) but keeps its
// position and title. Left empty, that slot turns the host that really sits there into a fake
// "exit" — seen live: two of four exits of one run were exactly such holes. Google's titles are
// stable from day to day, so when the previous take had a row with the very same title, that
// row's URL is the one that belongs in the hole. Anything less certain stays empty.

import type { SerpRow } from "./types";

export interface Hole { position: number; title: string }

function norm(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function fillHolesFromPrevious(
  rows: readonly SerpRow[],
  holes: readonly Hole[],
  prevRows: readonly SerpRow[],
): { rows: SerpRow[]; filled: number[]; open: number[] } {
  if (!holes.length) return { rows: [...rows], filled: [], open: [] };
  // Title → previous row, only for titles that appeared once (an ambiguous title proves nothing).
  const byTitle = new Map<string, SerpRow | null>();
  for (const r of prevRows) {
    const key = norm(r.title ?? "");
    if (!key) continue;
    byTitle.set(key, byTitle.has(key) ? null : r);
  }
  const taken = new Set(rows.map(r => r.url));
  const usedPositions = new Set(rows.map(r => r.position));
  const out = [...rows];
  const filled: number[] = [];
  const open: number[] = [];
  for (const h of holes) {
    const match = byTitle.get(norm(h.title));
    if (!match || taken.has(match.url) || usedPositions.has(h.position)) {
      open.push(h.position);
      continue;
    }
    out.push({ position: h.position, url: match.url, host: match.host, title: match.title });
    taken.add(match.url);
    usedPositions.add(h.position);
    filled.push(h.position);
  }
  out.sort((a, b) => a.position - b.position);
  return { rows: out, filled, open };
}
