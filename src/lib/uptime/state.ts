// The monitor state machine (docs/tasks/wave-oct/T2-uptime.md) — pure, no database.
//
//   unknown ─ok→ up
//   unknown ─fail×N→ down   (incident open, but NO "went_down" alert — it was already lying
//                            there when monitoring started; CONTRACT §0.4)
//   up ─fail→ up            (consecutiveFails=1, transition "confirm_pending": the scheduler
//                            re-checks after UPTIME_CONFIRM_RECHECK_MS)
//   up ─fail×N→ down        (transition "went_down" → alert)
//   down ─ok→ up            (transition "recovered" → alert with duration)
//   up ─slow→ degraded      ("degraded"; alert only when notifyDegraded)
//   degraded ─fast→ up      ("undegraded", no alert)
//
// N = failThreshold. Only the TRANSITION is an event: a monitor that reaches "down" out of
// "unknown" gets no alert, which is what the "none" transition below encodes.
//
// openIncidentId is carried, never minted here: a pure function cannot invent database ids.
// The rule it follows: an id survives any non-ok path and any ok path that keeps an unconfirmed
// streak alive is unnecessary — an ok check always ends the streak, so ok clears the id (the
// scheduler deletes an unconfirmed incident / closes a confirmed one).

import { UPTIME_OFFLINE_RATIO } from "./types";
import type { UptimeCheckResult, UptimeStatus } from "./types";

export interface MonitorState { status: UptimeStatus; consecutiveFails: number; openIncidentId: string | null }

export type Transition = "none" | "confirm_pending" | "went_down" | "recovered" | "degraded" | "undegraded";

/** Statuses a failed check can interrupt; "paused" and "checker_offline" never reach a check. */
const LIVE: readonly UptimeStatus[] = ["up", "degraded"];

export function nextState(
  prev: MonitorState,
  result: UptimeCheckResult,
  failThreshold: number,
): { state: MonitorState; transition: Transition } {
  const threshold = Math.max(1, Math.floor(failThreshold));

  if (!result.ok) {
    const fails = prev.consecutiveFails + 1;
    if (prev.status === "down") {
      // Still down: no new event, the incident keeps counting.
      return { state: { status: "down", consecutiveFails: fails, openIncidentId: prev.openIncidentId }, transition: "none" };
    }
    if (fails >= threshold) {
      // Confirmed down. "went_down" (→ alert) only from a status that said the site was up;
      // out of "unknown" the site was down before monitoring began — the incident is recorded,
      // the alert is not.
      const wasLive = LIVE.includes(prev.status);
      return {
        state: { status: "down", consecutiveFails: fails, openIncidentId: prev.openIncidentId },
        transition: wasLive ? "went_down" : "none",
      };
    }
    // First failure(s) below the threshold: the status does not move yet, the scheduler gets a
    // "confirm_pending" and re-checks after UPTIME_CONFIRM_RECHECK_MS. From "unknown" the
    // monitor stays gray — one failed check of a never-checked site proves nothing.
    return {
      state: { status: prev.status, consecutiveFails: fails, openIncidentId: prev.openIncidentId },
      transition: "confirm_pending",
    };
  }

  // ── ok ──
  if (prev.status === "down") {
    // The site answered — that is a recovery, even if the answer is slow (the new status then
    // says degraded, and a fresh slow-alert cycle can start from there).
    return {
      state: { status: result.status === "degraded" ? "degraded" : "up", consecutiveFails: 0, openIncidentId: null },
      transition: "recovered",
    };
  }
  if (prev.status === "degraded") {
    return result.status === "degraded"
      ? { state: { status: "degraded", consecutiveFails: 0, openIncidentId: prev.openIncidentId }, transition: "none" }
      : { state: { status: "up", consecutiveFails: 0, openIncidentId: prev.openIncidentId }, transition: "undegraded" };
  }
  if (prev.status === "up") {
    return result.status === "degraded"
      ? { state: { status: "degraded", consecutiveFails: 0, openIncidentId: prev.openIncidentId }, transition: "degraded" }
      : { state: { status: "up", consecutiveFails: 0, openIncidentId: prev.openIncidentId }, transition: "none" };
  }
  // unknown / paused / checker_offline → ok: first good answer. No "degraded" transition out of
  // unknown — an alert about a site the monitor had never seen up would be noise, and the
  // "was-not-watched-yet" grace matches the down side above.
  return {
    state: { status: result.status === "degraded" ? "degraded" : "up", consecutiveFails: 0, openIncidentId: null },
    transition: "none",
  };
}

/** Failure causes that mean "the checker could not reach the network", not "the site is down".
 *  http_status is deliberately absent: a 500 from every site means the sites are broken or a
 *  proxy is intercepting — not that this server lost its uplink. */
export const CHECKER_OFFLINE_CAUSES: readonly string[] = ["timeout", "dns", "connect"];

/**
 * True when a whole tick smells like the VPS's own network died: at least 3 monitors checked
 * and ≥ UPTIME_OFFLINE_RATIO of them failed with a network cause (timeout/dns/connect).
 *
 * The contract spells the input as `{ ok: boolean }[]`; the brief's rule (and tests) need the
 * CAUSE of each failure to keep HTTP 500s out of the set, so the field is optional here — a
 * caller passing only `{ ok }` still compiles, and a failure without a cause does not join the
 * offline set (an unknown reason is not proof of a network problem).
 */
export function isCheckerOffline(results: { ok: boolean; cause?: string | null }[]): boolean {
  if (results.length < 3) return false; // 2 of 2 tells nothing about the checker
  const networkFails = results.filter(
    r => !r.ok && typeof r.cause === "string" && (CHECKER_OFFLINE_CAUSES as readonly string[]).includes(r.cause),
  ).length;
  return networkFails / results.length >= UPTIME_OFFLINE_RATIO;
}
