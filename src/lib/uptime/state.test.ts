import assert from "node:assert/strict";
import test from "node:test";
import { confirmsDown, isCheckerOffline, nextState, type MonitorState } from "./state";
import type { UptimeCheckResult } from "./types";

const ok = (status: "up" | "degraded" = "up", latencyMs = 100): UptimeCheckResult =>
  ({ ok: true, status, httpStatus: 200, latencyMs, cause: null, detail: null, finalUrl: "https://x/" });

const fail = (cause: UptimeCheckResult["cause"] = "connect"): UptimeCheckResult =>
  ({ ok: false, status: "down", httpStatus: cause === "http_status" ? 502 : null, latencyMs: null, cause, detail: null, finalUrl: null });

const S = (status: MonitorState["status"], consecutiveFails = 0, openIncidentId: string | null = null): MonitorState =>
  ({ status, consecutiveFails, openIncidentId });

// ─── nextState: the diagram ───────────────────────────────────────────────────

test("unknown ─ok→ up", () => {
  const { state, transition } = nextState(S("unknown"), ok(), 2);
  assert.deepEqual(state, S("up"));
  assert.equal(transition, "none");
});

test("unknown ─fail×N→ down: incident confirmed but NO alert (was down when monitoring started)", () => {
  // threshold 2: first fail keeps it unknown with confirm_pending
  const first = nextState(S("unknown"), fail(), 2);
  assert.deepEqual(first.state, S("unknown", 1));
  assert.equal(first.transition, "confirm_pending");
  // second fail confirms down — transition stays "none", so no went_down alert
  const second = nextState(first.state, fail(), 2);
  assert.equal(second.state.status, "down");
  assert.equal(second.transition, "none");
});

test("unknown ─fail then ok→ back to up, no incident", () => {
  const first = nextState(S("unknown"), fail(), 2);
  const second = nextState(first.state, ok(), 2);
  assert.deepEqual(second.state, S("up"));
  assert.equal(second.transition, "none");
});

test("up ─fail→ up with confirm_pending and consecutiveFails=1", () => {
  const { state, transition } = nextState(S("up"), fail(), 2);
  assert.deepEqual(state, S("up", 1));
  assert.equal(transition, "confirm_pending");
});

test("up ─fail×N→ down with went_down (the alert transition)", () => {
  const first = nextState(S("up"), fail("timeout"), 2);
  const second = nextState(first.state, fail("dns"), 2);
  assert.equal(second.state.status, "down");
  assert.equal(second.state.consecutiveFails, 2);
  assert.equal(second.transition, "went_down");
});

test("failThreshold=1: up ─fail→ down immediately, no confirm_pending", () => {
  const { state, transition } = nextState(S("up"), fail(), 1);
  assert.equal(state.status, "down");
  assert.equal(transition, "went_down");
});

test("one failure then success — no incident state is left behind", () => {
  const first = nextState(S("up"), fail(), 2);
  const second = nextState(first.state, ok(), 2);
  assert.deepEqual(second.state, S("up", 0, null));
  assert.equal(second.transition, "none");
});

test("down ─fail→ stays down, no repeated event", () => {
  const { state, transition } = nextState(S("down", 2, "inc1"), fail(), 2);
  assert.deepEqual(state, S("down", 3, "inc1"));
  assert.equal(transition, "none");
});

test("down ─ok→ recovered (alert with duration), even when the answer is slow", () => {
  const { state, transition } = nextState(S("down", 5, "inc1"), ok(), 2);
  assert.deepEqual(state, S("up", 0, null));
  assert.equal(transition, "recovered");

  const slow = nextState(S("down", 5, "inc1"), ok("degraded", 6000), 2);
  assert.equal(slow.transition, "recovered");
  assert.equal(slow.state.status, "degraded");
});

test("degraded path: up ─slow→ degraded, degraded ─fast→ undegraded, no alert on recovery to up", () => {
  const slow = nextState(S("up"), ok("degraded", 6000), 2);
  assert.deepEqual(slow.state, S("degraded"));
  assert.equal(slow.transition, "degraded");

  const still = nextState(S("degraded"), ok("degraded", 5500), 2);
  assert.equal(still.transition, "none");

  const fast = nextState(S("degraded"), ok(), 2);
  assert.deepEqual(fast.state, S("up"));
  assert.equal(fast.transition, "undegraded");
});

test("degraded ─fail×N→ down still fires went_down", () => {
  const first = nextState(S("degraded"), fail(), 2);
  assert.equal(first.state.status, "degraded");
  assert.equal(first.transition, "confirm_pending");
  const second = nextState(first.state, fail(), 2);
  assert.equal(second.state.status, "down");
  assert.equal(second.transition, "went_down");
});

test("unknown ─slow ok→ degraded without a degraded transition (no alert about a never-seen site)", () => {
  const { state, transition } = nextState(S("unknown"), ok("degraded", 9000), 2);
  assert.equal(state.status, "degraded");
  assert.equal(transition, "none");
});

test("incident duration is measured from the FIRST failed check, not the confirming one", () => {
  // The scheduler opens the incident row at the first failure (confirm_pending) and the alert's
  // duration is now − incident.startedAt. Three checks at t=0, 30s (confirm recheck), 5min:
  // startedAt must be t=0, so a 2-fail incident reports ~5 min, not the 4.5 min since the
  // confirming check. nextState signals this by emitting confirm_pending BEFORE down.
  const first = nextState(S("up"), fail(), 2);
  assert.equal(first.transition, "confirm_pending", "the first failure is visible to the scheduler, which stamps the incident there");
  const second = nextState(first.state, fail(), 2);
  assert.equal(second.transition, "went_down");
  // and the first-failure streak out of unknown also passes through confirm_pending
  const u1 = nextState(S("unknown"), fail(), 2);
  assert.equal(u1.transition, "confirm_pending");
});

test("openIncidentId survives a fail streak and is cleared by any ok", () => {
  const withId = S("up", 1, "inc9");
  const failing = nextState(withId, fail(), 3);
  assert.equal(failing.state.openIncidentId, "inc9");
  const recovered = nextState(S("down", 4, "inc9"), ok(), 3);
  assert.equal(recovered.state.openIncidentId, null);
});

// ─── isCheckerOffline ─────────────────────────────────────────────────────────

const net = { ok: false, cause: "connect" };
const netTimeout = { ok: false, cause: "timeout" };
const http = { ok: false, cause: "http_status" };
const good = { ok: true };

test("fewer than 3 monitors checked tells nothing about the checker", () => {
  assert.equal(isCheckerOffline([net, net]), false);
  assert.equal(isCheckerOffline([net]), false);
  assert.equal(isCheckerOffline([]), false);
  // at 3 the rule starts working: 3 of 3 network failures is offline
  assert.equal(isCheckerOffline([net, net, net]), true);
});

test("5 of 6 network failures → checker offline", () => {
  assert.equal(isCheckerOffline([net, net, net, netTimeout, net, good]), true);
});

test("3 of 6 network failures → not offline", () => {
  assert.equal(isCheckerOffline([net, net, net, good, good, good]), false);
});

test("HTTP 500s are not network causes", () => {
  assert.equal(isCheckerOffline([http, http, http, http, http, http]), false);
  assert.equal(isCheckerOffline([http, http, http]), false);
});

test("exactly the 80% boundary counts as offline", () => {
  assert.equal(isCheckerOffline([net, net, net, net, good]), true, "4/5 = 80%");
  assert.equal(isCheckerOffline([net, net, net, net, net, good, good, good, good, good]), false, "5/10 = 50%");
});

test("a failure without a cause does not join the offline set", () => {
  assert.equal(isCheckerOffline([{ ok: false }, { ok: false }, { ok: false }]), false);
});

// ── witness gate helper (review fix: spread-out checks defeat the ≥3 quorum) ────────────

test("confirmsDown fires only on the answer that would move a monitor INTO down", () => {
  const ok = { ok: true };
  const fail = { ok: false };
  // up + 2nd consecutive failure with threshold 2 → the confirming answer
  assert.equal(confirmsDown({ status: "up", consecutiveFails: 1 }, fail, 2), true);
  // up + first failure → only confirm_pending, nothing to hold
  assert.equal(confirmsDown({ status: "up", consecutiveFails: 0 }, fail, 2), false);
  // unknown reaching the threshold moves to down too (silently) — hold it as well
  assert.equal(confirmsDown({ status: "unknown", consecutiveFails: 1 }, fail, 2), true);
  // already down: the streak continues, nothing new is manufactured
  assert.equal(confirmsDown({ status: "down", consecutiveFails: 5 }, fail, 2), false);
  // a success never confirms down
  assert.equal(confirmsDown({ status: "up", consecutiveFails: 1 }, ok, 2), false);
  // failThreshold=1: the very first failure confirms
  assert.equal(confirmsDown({ status: "up", consecutiveFails: 0 }, fail, 1), true);
});
