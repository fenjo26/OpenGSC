// The Google disavow file builder (N2) — pure, database-free.
//
// Two invariants worth writing down:
//
//  1. Nothing here decides anything. Marking a link for disavow is the operator's decision,
//     stored on the row (`disavow`); this module only renders the marked set into the format
//     https://search.google.com/search-console/disavow-links accepts. No "toxic → disavow"
//     shortcut exists anywhere in this module on purpose (brief §3, CONTRACT §0.1).
//  2. Domain level by default, URLs where the operator was selective: disavowing `domain:x`
//     kills EVERY link from x, so it is only correct for donors whose marked rows are all of
//     the donor's rows in the profile. A partial selection must fall back to per-URL lines,
//     and the explicit "urls" mode is the operator's way to force that everywhere.

export type DisavowMode = "domain" | "urls";

/** One marked link, a slice of SiteBacklink. */
export interface DisavowLink {
  id: string;
  urlFrom: string;
  domainFrom: string;
  disavow: boolean;
  disavowNote: string;
  toxLevel: string;
  /** parsed toxSignals, may be empty */
  toxSignals: string[];
}

/** Donors aggregated for the file: `marked` are the disavowed links, `total` every link of the
 *  donor in the profile (decides domain- vs URL-level). */
export interface DisavowDonor {
  domain: string;
  marked: DisavowLink[];
  total: number;
}

export interface DisavowFileOptions {
  mode?: DisavowMode;
  /** for the header line; defaults to now */
  now?: Date;
}

const LEVEL_RANK: Record<string, number> = { toxic: 3, suspicious: 2, unknown: 1, clean: 0 };

/** The reason line for one donor: the operator's note wins, otherwise the tox signals —
 *  "toxic · pharma, anchor_adult · 14 links" is the shape (brief §3). */
export function disavowReason(marked: DisavowLink[]): { level: string; reason: string } {
  let level = "";
  let rank = -1;
  const signals: string[] = [];
  const notes: string[] = [];
  for (const link of marked) {
    // "unknown" is "never classified", not a verdict — it must not label the line.
    const r = LEVEL_RANK[link.toxLevel] ?? 0;
    if (r > rank && link.toxLevel !== "unknown") {
      rank = r;
      level = link.toxLevel;
    }
    for (const s of link.toxSignals) {
      if (!signals.includes(s)) signals.push(s);
    }
    const note = (link.disavowNote ?? "").trim();
    if (note && !notes.includes(note)) notes.push(note);
  }
  if (!level) level = "manual"; // operator marked rows that were never classified
  const reason = notes.join("; ") || (signals.length ? signals.join(", ") : "manual");
  return { level, reason };
}

/** `disavow-example.com-2026-11-02.txt` — the attachment name of GET /api/backlinks/disavow. */
export function disavowFileName(host: string, now: Date = new Date()): string {
  const clean = (host || "site").toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "site";
  return `disavow-${clean}-${now.toISOString().slice(0, 10)}.txt`;
}

/** Normalize a donor domain for the `domain:` line: no scheme, no www, lowercase, no path. */
export function disavowDomain(domain: string): string {
  return (domain ?? "").toLowerCase().trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

/** Normalize one URL line: trimmed; kept exactly as stored otherwise (Google wants the URL as
 *  crawled; our urlFrom is the URL the provider crawled). */
export function disavowUrl(url: string): string {
  return (url ?? "").trim();
}

/**
 * Render the file. An empty selection still produces the two header lines — an empty file is a
 * valid upload that clears a previous disavow, so the header alone is the honest artifact
 * (and the UI can preview it before anything is marked).
 */
export function buildDisavowFile(host: string, donors: DisavowDonor[], opts: DisavowFileOptions = {}): string {
  const mode = opts.mode === "urls" ? "urls" : "domain";
  const now = opts.now ?? new Date();
  const lines: string[] = [
    `# OpenGSC disavow file for ${host} — generated ${now.toISOString().slice(0, 10)}`,
    "# Upload: https://search.google.com/search-console/disavow-links",
  ];

  // Deterministic order: worst reason first, then by domain, so re-running a recalc does not
  // reshuffle the file the operator already reviewed.
  const withMarked = donors
    .map((d) => ({ ...d, marked: d.marked.filter((l) => l.disavow) }))
    .filter((d) => d.marked.length > 0 && disavowDomain(d.domain))
    .sort((a, b) => {
      const ra = disavowReason(a.marked);
      const rb = disavowReason(b.marked);
      const byLevel = (LEVEL_RANK[rb.level] ?? 0) - (LEVEL_RANK[ra.level] ?? 0);
      if (byLevel !== 0) return byLevel;
      return disavowDomain(a.domain).localeCompare(disavowDomain(b.domain));
    });

  for (const donor of withMarked) {
    const { level, reason } = disavowReason(donor.marked);
    // domain-level only when the operator marked EVERY link of the donor (or forced URLs).
    const fullyMarked = donor.marked.length >= donor.total;
    const asDomain = mode === "domain" && fullyMarked;
    lines.push(`# ${level} · ${reason} · ${donor.marked.length} link(s)`);
    if (asDomain) {
      lines.push(`domain:${disavowDomain(donor.domain)}`);
    } else {
      const urls = donor.marked.map((l) => disavowUrl(l.urlFrom)).filter(Boolean);
      for (const url of urls.sort()) lines.push(url);
    }
  }

  return `${lines.join("\n")}\n`;
}
