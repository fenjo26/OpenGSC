// N8 — schedule math and recipient parsing. Pure module, unit-tested without a database.
//
// The scheduler ticks hourly and sends every report with nextSendAt <= now. This module is
// the single definition of "when is the next send":
//   • weekly  — sendDay is an ISO weekday, 1 (Monday) .. 7 (Sunday);
//   • monthly — sendDay is a day of month, 1..28. The 29th..31st are deliberately NOT
//     representable: February would turn a "30th" report into a March report, and a
//     schedule that silently jumps months is worse than one that asks for the 28th.
// Both fire at 09:00 UTC — a fixed, documented hour so the operator can reason about it.

export type ReportSchedule = "off" | "weekly" | "monthly";

export const REPORT_SCHEDULES: ReportSchedule[] = ["off", "weekly", "monthly"];

/** Fixed send hour, UTC. */
export const SEND_HOUR_UTC = 9;

export const MAX_RECIPIENTS = 20;

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;.]+\.[^\s@,;]{2,}$/;

/** Parse the comma-separated recipients field. Duplicates removed, order kept. */
export function parseRecipients(raw: unknown): { to: string[]; invalid: string[] } {
  const parts = String(raw ?? "").split(/[,;\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<string>();
  const to: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (!EMAIL_RE.test(p)) { invalid.push(p); continue; }
    if (seen.has(p)) continue;
    seen.add(p);
    if (to.length < MAX_RECIPIENTS) to.push(p);
  }
  return { to, invalid };
}

/** ISO weekday 1..7 of a date (1 = Monday), from the UTC calendar day. */
function isoWeekday(d: Date): number {
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/**
 * The next send moment strictly after `from` (default: now). `off` → null — a manual-only
 * report never enters the due list. Days that are already in the past at 09:00 UTC roll to
 * the next week/month, which is also what re-scheduling after a send uses.
 */
export function nextSendAt(schedule: ReportSchedule, sendDay: number, from: Date = new Date()): Date | null {
  if (schedule !== "weekly" && schedule !== "monthly") return null;
  const day = Math.round(Number(sendDay));

  // Candidate iterator: walk day by day from the current UTC date. A month can only be one
  // calendar month ahead of the target day in the worst case (~62 iterations), a week at
  // most 7 — no arithmetic shortcuts that break on month/year edges.
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), SEND_HOUR_UTC, 0, 0, 0));
  for (let i = 0; i < 70; i++) {
    const matches = schedule === "weekly"
      ? isoWeekday(cursor) === day
      : cursor.getUTCDate() === day;
    if (matches && cursor.getTime() > from.getTime()) return cursor;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null; // unreachable for the 1..28 / 1..7 domains; guards a corrupt sendDay
}

/** Validate a schedule/sendDay pair coming from the API. */
export function validSendDay(schedule: ReportSchedule, sendDay: unknown): number {
  const n = Math.round(Number(sendDay));
  if (schedule === "weekly") return n >= 1 && n <= 7 ? n : 1;
  if (schedule === "monthly") return n >= 1 && n <= 28 ? n : 1;
  return 1;
}
