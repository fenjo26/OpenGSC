// Trend radar (N5) — the Google suggest source. One endpoint, free and public:
//   https://suggestqueries.google.com/complete/search?client=firefox&hl=<lang>&gl=<gl>&q=<seed>
// Every request goes through safeFetch (README §5: the rule is absolute even though this URL
// is a constant — safeFetch also supplies the timeout, size cap and redirect handling).
//
// Google throttles autocomplete aggressively. Two protections live here:
//   - a process-wide ≥ 1 s pause between requests, enforced inside fetchSuggest so no future
//     call site can hammer Google by accident (the same trick as mentions' news pause);
//   - an "unavailable today" registry: the FIRST failed request (non-200 or a captcha page —
//     parseSuggest returning null) marks the source off for that site until the next day, and
//     both the scheduler and the run route check it before trying again. No retry hammering.
//
// The registry is in-memory by design: it guards the automatic loop's politeness within one
// server process (pm2 keeps it alive for weeks). A restart forgets it, which only means one
// extra request — a manual "Refresh" is the user's own explicit click and always retries.

import { safeFetch } from "@/lib/security/safeFetch";
import { SUGGEST_PAUSE_MS, parseSuggest } from "./logic";

const SUGGEST_ENDPOINT = "https://suggestqueries.google.com/complete/search";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 512 * 1024;

let lastFetchAt = 0;

/** Suggest refused (HTTP status, captcha page, broken body) — the source is off for today. */
export class SuggestUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SuggestUnavailableError";
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const unavailableToday = new Map<string, string>(); // siteId → ISO day the failure happened

/** Mark Google suggest as off for this site until tomorrow. */
export function markSuggestUnavailable(siteId: string): void {
  unavailableToday.set(siteId, isoDay(new Date()));
}

/** True when suggest already failed for this site today — skip it, don't hammer. */
export function suggestUnavailableToday(siteId: string): boolean {
  return unavailableToday.get(siteId) === isoDay(new Date());
}

/**
 * One autocomplete request. Throws SuggestUnavailableError on a non-200 answer or a body that
 * is not the `["seed", [...]]` JSON shape (that is what a captcha looks like with client=firefox:
 * HTTP 200, HTML payload). Network-level failures surface as safeFetch's own errors and are
 * treated by the caller the same way — one bad answer ends the source for the day.
 */
export async function fetchSuggest(query: string, lang: string, gl: string): Promise<string[]> {
  const wait = lastFetchAt + SUGGEST_PAUSE_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastFetchAt = Date.now();

  const url =
    `${SUGGEST_ENDPOINT}?client=firefox` +
    `&hl=${encodeURIComponent(lang || "en")}&gl=${encodeURIComponent((gl || "us").toLowerCase())}` +
    `&q=${encodeURIComponent(query)}`;

  let body: string;
  try {
    const res = await safeFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenGSC; +https://seogets.net.ru)" },
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_BYTES,
    });
    if (!res.ok) throw new SuggestUnavailableError(`http_${res.status}`);
    body = await res.text();
  } catch (e) {
    if (e instanceof SuggestUnavailableError) throw e;
    // safeFetch already refused the target (network, timeout, size) — same effect for us.
    throw new SuggestUnavailableError("network");
  }

  const list = parseSuggest(body);
  if (list == null) throw new SuggestUnavailableError("captcha_or_shape");
  return list;
}
