// Pure parser for a pasted access log — the honest crawl measure for an activated
// asset. No server imports, no database, never throws: garbage lines are counted
// in `skipped` instead of failing the upload. Contract: docs/tasks/drops-activation/
// CONTRACT.md (T6).

import { utcMidnightDaysBetween } from "./activation";

export interface CrawlLogSummary {
  /** Every counted Googlebot hit in the log, regardless of age. */
  hitsTotal: number;
  /** Counted hits whose UTC-midnight distance from `now` is ≤ 7 days. */
  hits7d: number;
  /** Latest counted hit in the log (logs may be rotated/unordered — max, not last). */
  lastHitAt: Date | null;
  /** Lines that looked like log lines but did not parse. */
  skipped: number;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// [dd/Mon/yyyy:HH:mm:ss +zzzz] — the timestamp spelling nginx combined/common and
// Apache share. The day is allowed 1–2 digits (some formats log without padding).
const TIMESTAMP_RE =
  /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})$/;

/**
 * One access-log timestamp to a UTC Date. The log time is local to its own offset
 * (`18/Sep/2026:10:00:00 +0300` is 07:00 UTC), which is exactly the fact the 7-day
 * window must not get wrong. null when the string is not a log timestamp at all.
 */
export function parseCrawlTimestamp(raw: string): Date | null {
  const m = TIMESTAMP_RE.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const day = +m[1], year = +m[3], hh = +m[4], mm = +m[5], ss = +m[6];
  const offH = +m[8], offM = +m[9];
  // 60 seconds is a real leap second in some logs; anything beyond is not a timestamp.
  if (day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 60) return null;
  if (offH > 23 || offM > 59) return null;
  const offsetMinutes = (m[7] === "-" ? -1 : 1) * (offH * 60 + offM);
  return new Date(Date.UTC(year, month, day, hh, mm, ss) - offsetMinutes * 60_000);
}

export interface CrawlLine {
  time: Date;
  status: number;
  /** The user-agent field, when the format carries one — null for common format. */
  ua: string | null;
}

// A quoted field with nginx's two escape styles (`\"` and `\x22`) tolerated inside.
const QUOTED_RE = /"((?:[^"\\]|\\.)*)"/g;

/**
 * One access-log line, liberally: combined format parses fully; common format
 * (no quoted referer/user-agent) still yields time + status with `ua: null`, which
 * by design cannot be attributed to Googlebot — a hit without a user agent is not
 * a Googlebot hit, it is a guess. null for anything that is not a log line.
 */
export function parseCrawlLine(line: string): CrawlLine | null {
  const t = /\[([^\]]*)\]/.exec(line);
  if (!t || t.index === undefined) return null;
  const time = parseCrawlTimestamp(t[1]);
  if (!time) return null;

  const after = line.slice(t.index + t[0].length);
  const quotes = [...after.matchAll(QUOTED_RE)].map(q => ({
    start: q.index ?? 0,
    end: (q.index ?? 0) + q[0].length,
    value: q[1],
  }));

  // The status is the 3-digit token right after the quoted request field. When the
  // line carries no quotes at all, fall back to the first standalone 3-digit token —
  // still the status, because it precedes the byte count in both formats.
  let status: number | null = null;
  let requestIdx = -1;
  for (let i = 0; i < quotes.length; i++) {
    const m = /^\s+(\d{3})\b/.exec(after.slice(quotes[i].end));
    if (m) {
      status = +m[1];
      requestIdx = i;
      break;
    }
  }
  if (status === null) {
    const m = /(?:^|\s)(\d{3})(?:\s|$)/.exec(after);
    if (m) status = +m[1];
  }
  if (status === null) return null; // timestamp but no status — a truncated line

  // In combined format the user agent is the LAST quoted field after the request
  // (`"request" status bytes "referer" "ua"`); a request-only line has none.
  let ua: string | null = null;
  for (let i = quotes.length - 1; i > requestIdx; i--) {
    ua = quotes[i].value;
    break;
  }
  return { time, status, ua };
}

/**
 * Count Googlebot hits in a pasted access log. A hit is a line whose user agent
 * contains "Googlebot" (case-insensitive) with HTTP status < 400 — redirects count,
 * errors do not. The 7-day window is whole UTC midnights via `utcMidnightDaysBetween`
 * (the local-calendar version of this question already drifted a day Athens-vs-UTC;
 * see activation.ts). Unattributable lines (no user agent, like common format) are
 * not hits; unparseable lines go to `skipped`. The function is total: any input
 * yields a summary.
 */
export function parseCrawlLog(log: string, opts?: { now?: Date }): CrawlLogSummary {
  const now = opts?.now ?? new Date();
  let hitsTotal = 0;
  let hits7d = 0;
  let skipped = 0;
  let lastHitAt: Date | null = null;

  for (const raw of log.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = parseCrawlLine(line);
    if (!parsed) {
      skipped++;
      continue;
    }
    if (!parsed.ua || !parsed.ua.toLowerCase().includes("googlebot")) continue;
    if (parsed.status >= 400) continue;

    hitsTotal++;
    // Midnight-days from the hit to `now`, in [0, 7]. Written in this order because
    // utcMidnightDaysBetween(now, hit) is negative for past lines, and the bare
    // `<= 7` comparison on it cannot ever exclude an older line — the boundary has
    // to bound both sides.
    const ageDays = utcMidnightDaysBetween(parsed.time, now);
    if (ageDays >= 0 && ageDays <= 7) hits7d++;
    if (!lastHitAt || parsed.time > lastHitAt) lastHitAt = parsed.time;
  }

  return { hitsTotal, hits7d, lastHitAt, skipped };
}
