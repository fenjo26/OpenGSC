// Google algorithm updates for chart annotations.
//
// The list below used to be the only source, and hand-maintained lists rot: this one stopped at
// March 2026, so on any recent window the chart drew nothing and the toggle looked broken.
//
// Google publishes the same data as JSON at status.search.google.com/incidents.json — undocumented
// but stable, and it is what the Search Status Dashboard itself renders. `/api/gsc/algo-updates`
// fetches it and falls back to this list when the network is unavailable, so the feature degrades
// to "slightly stale" rather than to "empty".
//
// Colors: core = orange, spam = purple, discover = green, other = blue.

export type AlgoUpdateType = "core" | "spam" | "discover" | "other";

export interface AlgoUpdate {
  date: string;  // start date, ISO YYYY-MM-DD
  /** Last day of the rollout, ISO. A core update takes weeks; the day it was announced is not
   *  the day it finished moving rankings, so the chart shades the whole window rather than
   *  drawing a single line and implying an instant event. */
  end?: string;
  name: string;  // short label shown on the chart
  type: AlgoUpdateType;
  duration?: string;
}

export const ALGO_UPDATE_COLORS: Record<AlgoUpdateType, string> = {
  core: "#F59E0B",
  spam: "#8B5CF6",
  discover: "#10B981",
  other: "#3B82F6",
};

export const ALGO_UPDATES: AlgoUpdate[] = [
  { date: "2023-08-22", name: "Aug 2023 Core",     type: "core", duration: "16 days" },
  { date: "2023-10-04", name: "Oct 2023 Spam",     type: "spam", duration: "16 days" },
  { date: "2023-10-05", name: "Oct 2023 Core",     type: "core", duration: "14 days" },
  { date: "2023-11-02", name: "Nov 2023 Core",     type: "core", duration: "26 days" },
  { date: "2023-11-08", name: "Nov 2023 Reviews",  type: "other", duration: "29 days" },
  { date: "2024-03-05", name: "Mar 2024 Core",     type: "core", duration: "45 days" },
  { date: "2024-03-05", name: "Mar 2024 Spam",     type: "spam", duration: "15 days" },
  { date: "2024-06-20", name: "Jun 2024 Spam",     type: "spam", duration: "7 days" },
  { date: "2024-08-15", name: "Aug 2024 Core",     type: "core", duration: "19 days" },
  { date: "2024-11-11", name: "Nov 2024 Core",     type: "core", duration: "24 days" },
  { date: "2024-12-12", name: "Dec 2024 Core",     type: "core", duration: "6 days" },
  { date: "2024-12-19", name: "Dec 2024 Spam",     type: "spam", duration: "8 days" },
  { date: "2025-03-13", name: "Mar 2025 Core",     type: "core", duration: "14 days" },
  { date: "2025-06-30", name: "Jun 2025 Core",     type: "core", duration: "16 days" },
  { date: "2025-08-26", name: "Aug 2025 Spam",     type: "spam", duration: "18 days" },
  { date: "2025-12-11", name: "Dec 2025 Core",     type: "core", duration: "12 days" },
  { date: "2026-02-10", name: "Feb 2026 Discover", type: "discover", duration: "8 days" },
  { date: "2026-03-27", name: "Mar 2026 Core",     type: "core", duration: "12 days" },
  { date: "2026-03-27", name: "Mar 2026 Spam",     type: "spam", duration: "9 days" },
];

// Chart X axes use "MMM d" labels — convert an ISO date to the same format.
export function algoDateLabel(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Updates that fall inside an ISO date window (inclusive).
export function algoUpdatesInRange(startIso: string, endIso: string): AlgoUpdate[] {
  return ALGO_UPDATES.filter(u => u.date >= startIso && u.date <= endIso);
}

/**
 * The X value a marker must carry to actually appear on the chart.
 *
 * Recharts places a `ReferenceLine` on a category axis by matching its `x` against the exact
 * label string of an existing data point. A computed label is not enough: Search Console has
 * gaps, so the day an update rolled out often has no row at all, and a marker pointing at a
 * label that is not in the data is dropped without any error. That is the other half of why
 * this feature looked broken even for updates that were in the list.
 *
 * Snapping to the first point on or after the update keeps the marker on the chart and places
 * it where the effect would start showing anyway. Updates past the end of the window return
 * null and are not drawn.
 */
export function snapToChartLabel(
  chart: { date: string; dateIso: string }[],
  updateIso: string,
): string | null {
  if (!chart.length) return null;
  const hit = chart.find(p => p.dateIso >= updateIso);
  return hit ? hit.date : null;
}

/**
 * The last chart point on or before a date — the closing edge of a rollout band.
 *
 * Deliberately the mirror of {@link snapToChartLabel}: the start snaps forward and the end snaps
 * backward, so a band can only ever shrink to fit the data it has, never spill past it.
 */
export function snapBackToChartLabel(
  chart: { date: string; dateIso: string }[],
  updateIso: string,
): string | null {
  if (!chart.length) return null;
  for (let i = chart.length - 1; i >= 0; i--) {
    if (chart[i].dateIso <= updateIso) return chart[i].date;
  }
  return null;
}

/** Days in a "16 days" string, for the built-in entries that predate storing an end date. */
function durationDays(duration?: string): number | null {
  const m = /^(\d+)\s*days?$/i.exec(duration ?? "");
  return m ? parseInt(m[1], 10) : null;
}

/** End date of an update, derived from `duration` when the entry has no explicit `end`. */
export function updateEnd(u: AlgoUpdate): string | null {
  if (u.end) return u.end;
  const days = durationDays(u.duration);
  if (days == null) return null;
  return new Date(Date.parse(`${u.date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Rollout length in days, whichever way the entry records it. */
export function updateDays(u: AlgoUpdate): number | null {
  const fromDuration = durationDays(u.duration);
  if (fromDuration != null) return fromDuration;
  if (!u.end) return null;
  return Math.max(1, Math.round((Date.parse(u.end) - Date.parse(u.date)) / 86_400_000));
}

/**
 * Chart label for an update: the name, plus the rollout length when it is known.
 *
 * The length goes in the start label rather than on a second one at the closing edge. A shaded
 * band with a name at its left edge does not say what the shading means, but "Jun 2026 Spam · 2d"
 * does — and a second label would collide with the next update's whenever two land close
 * together, which core and spam updates regularly do.
 */
export function algoChartLabel(u: AlgoUpdate): string {
  const days = updateDays(u);
  return days ? `${u.name} · ${days}d` : u.name;
}

/** Days on each side of a rollout used to judge its effect, and the minimum worth judging on. */
const IMPACT_WINDOW = 14;

/**
 * The floor was 5, which silently discarded the verdict whenever two updates landed within a
 * fortnight — and Google ships core and spam updates close together often enough that the most
 * interesting cases were the ones going unanswered. Three days is thin but it is a real signal,
 * and the alternative was showing nothing at all.
 *
 * What makes the lower floor safe is that thinness is now visible rather than implied: anything
 * measured on less than {@link IMPACT_CONFIDENT_DAYS} is marked approximate on the chart, and the
 * exact window is spelled out on hover.
 */
const IMPACT_MIN_DAYS = 3;

/** Below this on either side, the figure is shown as approximate. */
const IMPACT_CONFIDENT_DAYS = 7;

/**
 * Change in average daily clicks across a rollout: the number that answers "did this help or
 * hurt", which is the reason to mark updates on a chart at all.
 *
 * Measured from before the rollout started to after it finished, skipping the rollout itself.
 * During a two-week core update rankings are mid-flight, and including those days averages the
 * old state and the new one together into something that describes neither.
 *
 * Returns null rather than a number whenever the answer would be unreliable: fewer than
 * {@link IMPACT_MIN_DAYS} days on either side of the window, or no clicks before to divide by.
 * A percentage computed from two days of data looks exactly as authoritative as one computed
 * from two weeks, which is why it is better not to show it.
 *
 * This is correlation. Traffic moves for reasons that have nothing to do with Google shipping
 * something — seasonality, a redirect someone deployed, a competitor — and the figure only says
 * what happened around the update, never that the update caused it.
 */
export interface AlgoImpactPoint {
  dateIso: string;
  clicks?: number;
  impressions?: number;
  position?: number;
}

export interface AlgoImpact {
  /** Percent change in average daily clicks. */
  clicks: number | null;
  /** Percent change in average daily impressions. */
  impressions: number | null;
  /** Change in CTR, in percentage points — a move from 1.4% to 1.1% is −0.3pp, not −21%. */
  ctrPp: number | null;
  /** Change in average position, reported as before − after so a positive number means improved. */
  position: number | null;
  /** How many days each side actually got, once neighbouring rollouts were excluded. */
  beforeDays: number;
  afterDays: number;
  /** False when either side is short enough that the figure should be read as approximate. */
  confident: boolean;
}

export type AlgoImpactResult =
  | ({ ok: true } & AlgoImpact)
  /** `adjacent` means another rollout sat too close to leave a clean window — a different fact
   *  from "this site has no data", and worth saying differently. */
  | { ok: false; reason: "insufficient" | "adjacent" };

/**
 * Neighbouring rollouts, so one update's window cannot run into another's.
 *
 * Without this the measurement lies in a specific and confident way: Google shipped a spam update
 * on 24 March 2026 and a core update on the 27th, so the "after" window of the first covers the
 * whole of the second. Whatever the core update did to the site would be reported as the spam
 * update's doing, with a number that looks exactly as solid as a real one.
 */
export interface AlgoNeighbours {
  /** End of the previous rollout — nothing before this belongs to the current one. */
  prevEndIso?: string;
  /** Start of the next rollout — nothing after this does either. */
  nextStartIso?: string;
}

export function algoImpact(
  chart: AlgoImpactPoint[],
  startIso: string,
  endIso: string,
  neighbours: AlgoNeighbours = {},
): AlgoImpactResult {
  const { prevEndIso, nextStartIso } = neighbours;

  // Clipped at the neighbours first, then trimmed to the window length. Order matters: trimming
  // first would take 14 days and then throw most of them away, leaving a window shorter than the
  // data allows.
  const beforeAll = chart.filter(p => p.dateIso < startIso && (!prevEndIso || p.dateIso > prevEndIso));
  const afterAll = chart.filter(p => p.dateIso > endIso && (!nextStartIso || p.dateIso < nextStartIso));

  const before = beforeAll.slice(-IMPACT_WINDOW);
  const after = afterAll.slice(0, IMPACT_WINDOW);

  if (before.length < IMPACT_MIN_DAYS || after.length < IMPACT_MIN_DAYS) {
    // Distinguish "no room between two updates" from "no data at all": the first can never be
    // fixed by waiting, and telling the user to wait would be wrong.
    const clipped =
      (prevEndIso && chart.some(p => p.dateIso < startIso && p.dateIso <= prevEndIso)) ||
      (nextStartIso && chart.some(p => p.dateIso > endIso && p.dateIso >= nextStartIso));
    return { ok: false, reason: clipped ? "adjacent" : "insufficient" };
  }

  // Averages, not sums: the two windows are often different lengths near the edge of the period,
  // and comparing their totals would report the difference in length as a change in traffic.
  const avg = (rows: AlgoImpactPoint[], pick: (p: AlgoImpactPoint) => number | undefined) => {
    const vals = rows.map(pick).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };

  const pct = (b: number | null, a: number | null) =>
    b != null && a != null && b > 0 ? Math.round(((a - b) / b) * 100) : null;

  const bc = avg(before, p => p.clicks), ac = avg(after, p => p.clicks);
  const bi = avg(before, p => p.impressions), ai = avg(after, p => p.impressions);
  const bp = avg(before, p => p.position), ap = avg(after, p => p.position);

  // CTR is recomputed from the two averages rather than averaged day by day: a day with three
  // impressions and one click is a 33% CTR, and letting it weigh the same as a day with three
  // thousand impressions produces a number no report would agree with.
  const bctr = bc != null && bi != null && bi > 0 ? (bc / bi) * 100 : null;
  const actr = ac != null && ai != null && ai > 0 ? (ac / ai) * 100 : null;

  return {
    ok: true,
    clicks: pct(bc, ac),
    impressions: pct(bi, ai),
    ctrPp: bctr != null && actr != null ? +(actr - bctr).toFixed(2) : null,
    // Position improves as the number falls, so the delta is inverted to match every other
    // metric here: positive is good.
    position: bp != null && ap != null ? +(bp - ap).toFixed(1) : null,
    beforeDays: before.length,
    afterDays: after.length,
    confident: before.length >= IMPACT_CONFIDENT_DAYS && after.length >= IMPACT_CONFIDENT_DAYS,
  };
}

/**
 * Neighbour dates for every update in a list, so each one can be measured in isolation.
 *
 * Takes the full list rather than only the updates visible on a chart: an update just outside the
 * period still contaminates the window of the one inside it, and filtering first would silently
 * restore the very problem this exists to prevent.
 */
export function withNeighbours(updates: AlgoUpdate[]): (AlgoUpdate & AlgoNeighbours)[] {
  const sorted = [...updates].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((u, i) => {
    // Scan backwards for the latest end among *all* earlier updates, not just the previous one:
    // rollouts overlap, and a long core update can still be running when two later ones start.
    let prevEndIso: string | undefined;
    for (let j = 0; j < i; j++) {
      const e = updateEnd(sorted[j]) ?? sorted[j].date;
      if (!prevEndIso || e > prevEndIso) prevEndIso = e;
    }
    return { ...u, prevEndIso, nextStartIso: sorted[i + 1]?.date };
  });
}

// ─── Google Search Status Dashboard ────────────────────────────────────────────

/** One incident as published at status.search.google.com/incidents.json. */
export interface GoogleIncident {
  begin?: string;
  end?: string;
  external_desc?: string;
  service_name?: string;
  status_impact?: string;
}

/**
 * Turn the status feed into chart markers.
 *
 * Only ranking announcements are kept. The same feed also carries serving outages ("Serving was
 * experiencing an issue"), and while those do move traffic, they are incidents rather than
 * algorithm updates — putting them behind a button labelled "algorithm updates" would make the
 * chart say something it does not mean.
 */
export function mapIncidentsToUpdates(incidents: GoogleIncident[]): AlgoUpdate[] {
  const out: AlgoUpdate[] = [];

  for (const inc of incidents) {
    const desc = (inc.external_desc ?? "").trim();
    const begin = (inc.begin ?? "").slice(0, 10);
    if (!desc || !/^\d{4}-\d{2}-\d{2}$/.test(begin)) continue;
    if (inc.status_impact !== "SERVICE_INFORMATION") continue;

    const lower = desc.toLowerCase();
    const type: AlgoUpdateType =
      lower.includes("discover") ? "discover"
      : lower.includes("spam") ? "spam"
      : lower.includes("core") ? "core"
      : "other";

    // "June 2026 spam update" reads as "Jun 2026 Spam" on a chart that has ~40px per label.
    const name = desc
      .replace(/\s+update$/i, "")
      .replace(/^(\w{3})\w*/, (_m, m3) => m3.charAt(0).toUpperCase() + m3.slice(1))
      .replace(/\b(core|spam|discover)\b/i, s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());

    const endIso = (inc.end ?? "").slice(0, 10);
    const hasEnd = /^\d{4}-\d{2}-\d{2}$/.test(endIso) && endIso >= begin;
    const duration = hasEnd
      ? `${Math.max(1, Math.round((Date.parse(endIso) - Date.parse(begin)) / 86_400_000))} days`
      : undefined;

    out.push({ date: begin, end: hasEnd ? endIso : undefined, name, type, duration });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}
