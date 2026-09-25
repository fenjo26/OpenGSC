// One HTTP check of a monitored URL (docs/tasks/wave-oct/T2-uptime.md).
//
// The network half lives in safeFetch — it is the SSRF guard as much as the HTTP client: a
// monitor URL is user input, so without it a team member could point a monitor at
// http://127.0.0.1:9091 (A-Parser) and read the internals off the response codes. This module
// only decides what the answer MEANS: which UptimeCause a failure is, and whether a successful
// answer was fast enough to still count as "up".
//
// classifyCheck is pure (no fetch) so the whole classification table is testable without a
// network; runUptimeCheck is the thin wrapper that performs the request and feeds it.

import { SafeFetchError, safeFetch, type SafeFetchErrorCode } from "@/lib/security/safeFetch";
import type { UptimeCause, UptimeCheckResult } from "./types";

/** Identifiable UA: some WAFs cut unknown agents, which surfaces as a 403 the user can then
 *  allow by adding 403 to the accepted codes (see docs/UPTIME.md). */
export const UPTIME_USER_AGENT = "OpenGSC-Uptime/1.0 (+https://opengsc.org)";

/** A monitor body is only searched for a keyword; 2 MB is plenty and keeps answers bounded. */
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
/** `lastError` on the monitor is a String? column; keep the detail useful but bounded. */
const DETAIL_MAX = 300;

// ─── acceptStatus ─────────────────────────────────────────────────────────────

/**
 * Parse an accept-status spec: comma-separated single codes ("401") and inclusive ranges
 * ("200-399"), e.g. "200-399,401". Spaces and garbage are tolerated (ignored); an empty or
 * entirely invalid spec means the default 200-399. A range written backwards is ignored, not
 * swapped — a typo like "399-200" silently meaning the opposite of what it says is worse than
 * the spec falling back to the default the UI shows.
 */
export function parseAcceptStatus(spec: string): (code: number) => boolean {
  const accepted = new Set<number>();
  for (const part of String(spec ?? "").split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from <= to) for (let code = from; code <= to; code++) accepted.add(code);
      continue;
    }
    const single = /^(\d{3})$/.exec(piece);
    if (single) accepted.add(Number(single[1]));
  }
  if (accepted.size === 0) for (let code = 200; code <= 399; code++) accepted.add(code);
  return (code: number) => accepted.has(code);
}

// ─── error → cause table ──────────────────────────────────────────────────────

/**
 * SafeFetchError codes carry no TLS/connect distinction (safeFetch funnels every socket-level
 * failure into `network_error` with the Node error as `cause`), so the table has two halves:
 * the code map for what safeFetch already knows, and a message scan of the cause chain for the
 * rest. Codes (`ECONNREFUSED` …) are matched case-sensitively as Node emits them; TLS is
 * recognised by its `ERR_TLS`/`ERR_SSL`/certificate prefixes.
 */
const CAUSE_BY_CODE: Partial<Record<SafeFetchErrorCode, UptimeCause>> = {
  request_timeout: "timeout",
  dns_failed: "dns",
  too_many_redirects: "redirect_loop",
  private_address: "blocked_target",
  invalid_url: "other",
  unsupported_protocol: "other",
  credentials_not_allowed: "other",
  response_too_large: "other", // the host answered; the check just could not be completed
  network_error: "connect",    // refined by the cause-chain scan below
};

const TLS_HINTS = /(ERR_TLS|ERR_SSL|SSL_|TLS_|certificate|CERT_|EPROTO|wrong version number)/i;
const DNS_HINTS = /(EAI_AGAIN|EAI_FAIL|ENOTFOUND|getaddrinfo)/i;

function walkErrors(error: unknown, visit: (e: Error) => boolean): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (visit(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The UptimeCause of a failed check, plus a short human-readable detail (bounded). */
export function causeFromError(error: unknown): { cause: UptimeCause; detail: string } {
  if (!(error instanceof Error)) {
    return { cause: "other", detail: String(error).slice(0, DETAIL_MAX) };
  }
  const detail = (error.message || error.name).slice(0, DETAIL_MAX);
  if (error instanceof SafeFetchError) {
    const code = error.code as SafeFetchErrorCode;
    const mapped = CAUSE_BY_CODE[code] ?? "other";
    if (mapped !== "connect") return { cause: mapped, detail };
    // `network_error` is safeFetch's catch-all: TLS vs DNS vs connect lives in the cause chain.
    if (walkErrors(error, e => TLS_HINTS.test(e.message))) return { cause: "tls", detail };
    if (walkErrors(error, e => DNS_HINTS.test(e.message))) return { cause: "dns", detail };
    return { cause: "connect", detail };
  }
  // Not a SafeFetchError: an unexpected local failure (out of memory, a bug). "other", never
  // "connect" — an internal error must not join the checker-offline network set.
  return { cause: "other", detail };
}

// ─── classification ───────────────────────────────────────────────────────────

/**
 * Pure classifier. `error` wins over everything (no HTTP answer at all); then the status must
 * be inside `acceptStatus`; then a configured keyword must be present (`bodyHasKeyword ===
 * false` → keyword_missing; `null` = no keyword configured or body not read); a check that
 * passes all of that but took longer than `slowMs` is still ok — it is just "degraded".
 */
export function classifyCheck(
  input: { httpStatus: number | null; latencyMs: number | null; error: unknown; bodyHasKeyword: boolean | null },
  monitor: { acceptStatus: string; slowMs: number },
): UptimeCheckResult {
  if (input.error != null) {
    const { cause, detail } = causeFromError(input.error);
    return { ok: false, status: "down", httpStatus: null, latencyMs: input.latencyMs, cause, detail, finalUrl: null };
  }
  const httpStatus = input.httpStatus;
  if (httpStatus == null) {
    // Defensive: no error and no status cannot happen via safeFetch, but a null here must not
    // turn into a green dot.
    return { ok: false, status: "down", httpStatus: null, latencyMs: input.latencyMs, cause: "other", detail: "no response", finalUrl: null };
  }
  if (!parseAcceptStatus(monitor.acceptStatus)(httpStatus)) {
    return { ok: false, status: "down", httpStatus, latencyMs: input.latencyMs, cause: "http_status", detail: `HTTP ${httpStatus}`, finalUrl: null };
  }
  if (input.bodyHasKeyword === false) {
    return { ok: false, status: "down", httpStatus, latencyMs: input.latencyMs, cause: "keyword_missing", detail: null, finalUrl: null };
  }
  const slow = input.latencyMs != null && monitor.slowMs > 0 && input.latencyMs > monitor.slowMs;
  return { ok: true, status: slow ? "degraded" : "up", httpStatus, latencyMs: input.latencyMs, cause: null, detail: null, finalUrl: null };
}

/**
 * Perform the check. Latency is measured from the start of the request to the END of the body
 * read: safeFetch buffers the whole body before its promise resolves, so a headers-received
 * split is not available. The keyword search needs the body anyway, and "slow" semantics
 * (slowMs) are defined over the user-visible load, so end-of-body is the honest number here.
 */
export async function runUptimeCheck(
  monitor: { url: string; timeoutMs: number; acceptStatus: string; keyword: string; slowMs: number },
): Promise<UptimeCheckResult> {
  const startedAt = Date.now();
  try {
    const res = await safeFetch(monitor.url, {
      method: "GET",
      redirect: "follow",
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: monitor.timeoutMs,
      maxBytes: MAX_BODY_BYTES,
      headers: { "user-agent": UPTIME_USER_AGENT },
    });
    // Case-insensitive over the decoded text — the same string the browser would show.
    let bodyHasKeyword: boolean | null = null;
    if (monitor.keyword) {
      bodyHasKeyword = (await res.text()).toLowerCase().includes(monitor.keyword.toLowerCase());
    }
    return classifyCheck(
      { httpStatus: res.status, latencyMs: Date.now() - startedAt, error: null, bodyHasKeyword },
      monitor,
    );
  } catch (error) {
    return classifyCheck(
      { httpStatus: null, latencyMs: Date.now() - startedAt, error, bodyHasKeyword: null },
      monitor,
    );
  }
}

// ─── witness gate ───────────────────────────────────────────────────────────────

/** Endpoints asked before any monitor may move INTO "down": the most reliably reachable hosts
 *  there are. safeFetch resolves on ANY http status (it throws only when the network path
 *  fails), so a fulfilled request — even a 3xx/5xx — proves the checker still has an uplink. */
export const WITNESS_URLS = [
  "https://www.google.com/generate_204",
  "https://www.cloudflare.com/cdn-cgi/trace",
] as const;

/** True when at least one witness answered — i.e. the server's own network works. Probed at
 *  most once per tick and only when a down-confirmation is actually pending (scheduler.ts). */
export async function witnessesReachable(timeoutMs = 5_000): Promise<boolean> {
  const answers = await Promise.allSettled(
    WITNESS_URLS.map(url => safeFetch(url, { method: "GET", timeoutMs, maxBytes: 10_000 })),
  );
  return answers.some(a => a.status === "fulfilled");
}
