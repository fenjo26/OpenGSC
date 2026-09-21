// 5-field cron matcher — minute hour day-of-month month day-of-week, evaluated in UTC.
// Owned rather than pulled in as a dependency: the grammar is small, and having it here
// keeps the /audits scheduler's whole schedule vocabulary unit-testable in one place.
//
// Supported per field: `*`, `*/n`, `a`, `a-b`, `a-b/n`, `a/n` (from a to the field max,
// step n — vixie-cron semantics), and comma-separated lists of those. Day-of-week is
// 0–7 with both 0 and 7 meaning Sunday. Standard cron OR rule: when both day-of-month
// and day-of-week are restricted (not `*`), a day matching either is enough.
//
// Granularity note: the audit scheduler ticks every 15 minutes, so fire times are
// detected with that granularity — an expression like `*/5 * * * *` still yields at
// most one order per site per tick, which is the honest ceiling for a minutes-long
// crawl anyway.

const FIELD_RANGES: readonly [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week (7 = Sunday too)
];

type CronField = "all" | number[];

function parseField(part: string, idx: number): CronField {
  const [min, max] = FIELD_RANGES[idx];
  if (part === "*") return "all";
  const values = new Set<number>();
  for (const token of part.split(",")) {
    const m = /^(?:(\d+)-(\d+)|(\*|\d+))(?:\/(\d+))?$/.exec(token);
    if (!m) throw new Error(`cannot parse "${token}" (field ${idx + 1})`);
    const step = m[4] ? parseInt(m[4], 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`step must be ≥ 1 in "${token}" (field ${idx + 1})`);
    let lo: number, hi: number;
    if (m[1] !== undefined) {
      lo = parseInt(m[1], 10);
      hi = parseInt(m[2], 10);
    } else if (m[3] === "*") {
      lo = min; hi = max;
    } else {
      lo = parseInt(m[3], 10);
      hi = m[4] ? max : lo; // "a/n" runs from a to the field max
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`"${token}" is out of range ${min}-${max} (field ${idx + 1})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** null = valid; otherwise a human-readable reason. */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`;
  }
  try {
    fields.forEach((f, i) => parseField(f, i));
    return null;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const sets: CronField[] = [];
  try {
    for (let i = 0; i < 5; i++) sets.push(parseField(fields[i]!, i));
  } catch {
    return false;
  }
  const [mi, hr, dom, mo, dow] = sets;
  const has = (f: CronField | undefined, v: number) => f === undefined || f === "all" ? true : f.includes(v);
  if (!has(mi, at.getUTCMinutes())) return false;
  if (!has(hr, at.getUTCHours())) return false;
  if (!has(mo, at.getUTCMonth() + 1)) return false;
  const domOk = has(dom, at.getUTCDate());
  // 7 and 0 both mean Sunday; normalise so a dow list containing either matches both spellings.
  const dowVals = dow === undefined || dow === "all" ? null : (dow.includes(7) ? [...dow.filter(v => v !== 7), 0] : dow);
  const dowOk = dowVals === null ? true : dowVals.includes(at.getUTCDay());
  const domRestricted = dom !== undefined && dom !== "all";
  const dowRestricted = dow !== undefined && dow !== "all";
  return domRestricted && dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
}

/**
 * The latest matching minute at or before `now`, found by walking back minute by minute.
 * The scan cap bounds the walk: the scheduler ticks every 15 min, so a 60-minute window
 * catches every fire the ticks could have seen, and a fire older than the window is
 * downtime — deliberately missed rather than stacked.
 */
export function latestFireAtOrBefore(expr: string, now: Date, scanMinutes = 60): Date | null {
  const floor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes());
  for (let i = 0; i <= scanMinutes; i++) {
    const at = new Date(floor - i * 60_000);
    if (cronMatches(expr, at)) return at;
  }
  return null;
}
