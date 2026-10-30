// When a tracked keyword's rank was last found for real.
//
// The site-card GSC badge goes yellow at 48h (`GSC_SYNC_STALE_MS`). Keywords are
// checked every other day, so the same clock would paint a healthy rank yellow
// the morning after a normal check. This window is 72h. The site card does not
// use it.

import { formatLastSuccessStamp, lastSuccessState, type LastSuccessState } from "@/lib/gscSyncHealth";

/** Yellow after this. Equal to 72h is still fresh, same boundary rule as the 48h GSC badge. */
export const RANK_SUCCESS_STALE_MS = 72 * 60 * 60 * 1000;

export function rankSuccessState(
  at: Date | string | null | undefined,
  now = Date.now(),
): LastSuccessState {
  return lastSuccessState(at, now, RANK_SUCCESS_STALE_MS);
}

/** `MM-DD HH:mm` in Asia/Shanghai, the same clock as the site-card badge. */
export function rankSuccessStamp(at: Date | string): string {
  const d = at instanceof Date ? at : new Date(at);
  return formatLastSuccessStamp(d);
}

/**
 * The Positions badge uses 「最后查到」 for a known rank and 「最后检查」 for a
 * completed not-found check. Templates come from the locale files so tests can
 * pin the Chinese copy without rendering React.
 */
export function rankSuccessLabel(
  at: Date | string | null | undefined,
  templates: { at: string; never: string },
  now = Date.now(),
): { state: LastSuccessState; text: string } {
  const state = rankSuccessState(at, now);
  if (state === "never" || at == null || at === "") return { state: "never", text: templates.never };
  return { state, text: templates.at.replace("{time}", rankSuccessStamp(at)) };
}
