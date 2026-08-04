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
    const duration = /^\d{4}-\d{2}-\d{2}$/.test(endIso)
      ? `${Math.max(1, Math.round((Date.parse(endIso) - Date.parse(begin)) / 86_400_000))} days`
      : undefined;

    out.push({ date: begin, name, type, duration });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}
