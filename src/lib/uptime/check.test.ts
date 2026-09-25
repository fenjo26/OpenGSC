import assert from "node:assert/strict";
import test from "node:test";
import { SafeFetchError } from "@/lib/security/safeFetch";
import { classifyCheck, causeFromError, parseAcceptStatus } from "./check";

// ─── parseAcceptStatus ────────────────────────────────────────────────────────

test("parseAcceptStatus: ranges, singles, spaces, garbage, empty", () => {
  const accept = parseAcceptStatus("200-399,401");
  assert.equal(accept(200), true);
  assert.equal(accept(399), true);
  assert.equal(accept(401), true);
  assert.equal(accept(400), false);
  assert.equal(accept(500), false);

  // spaces are tolerated everywhere
  const spaced = parseAcceptStatus(" 200 - 399 , 404 , 301 ");
  assert.equal(spaced(250), true);
  assert.equal(spaced(404), true);
  assert.equal(spaced(301), true);
  assert.equal(spaced(403), false);

  // garbage parts are ignored, valid ones survive
  const messy = parseAcceptStatus("abc, 200, x-y, 503");
  assert.equal(messy(200), true);
  assert.equal(messy(503), true);
  assert.equal(messy(201), false);

  // empty → the 200-399 default
  const empty = parseAcceptStatus("");
  assert.equal(empty(200), true);
  assert.equal(empty(399), true);
  assert.equal(empty(404), false);
  assert.equal(empty(199), false);

  // only garbage → the same default, not "nothing is accepted"
  const garbage = parseAcceptStatus("nope, ,, - , 12, 1234");
  assert.equal(garbage(204), true);
  assert.equal(garbage(400), false);

  // a backwards range is ignored rather than swapped
  const backwards = parseAcceptStatus("399-200");
  assert.equal(backwards(250), true, "falls back to the 200-399 default");
  assert.equal(backwards(500), false);

  // two-digit codes are not silently accepted as statuses
  const short = parseAcceptStatus("200-299,40");
  assert.equal(short(40), false);
});

// ─── classifyCheck: error causes ──────────────────────────────────────────────

const MON = { acceptStatus: "200-399", slowMs: 5000 };

function classifyError(error: unknown) {
  return classifyCheck({ httpStatus: null, latencyMs: null, error, bodyHasKeyword: null }, MON);
}

test("classifyCheck: SafeFetchError codes map onto UptimeCause", () => {
  assert.deepEqual(
    { ...classifyError(new SafeFetchError("request_timeout", "The request timed out.")) },
    { ok: false, status: "down", httpStatus: null, latencyMs: null, cause: "timeout", detail: "The request timed out.", finalUrl: null },
  );
  assert.equal(classifyError(new SafeFetchError("dns_failed", "no resolve")).cause, "dns");
  assert.equal(classifyError(new SafeFetchError("too_many_redirects", "loop")).cause, "redirect_loop");
  assert.equal(classifyError(new SafeFetchError("private_address", "127.0.0.1")).cause, "blocked_target");
  assert.equal(classifyError(new SafeFetchError("invalid_url", "not a url")).cause, "other");
  assert.equal(classifyError(new SafeFetchError("response_too_large", "2MB+")).cause, "other");
});

test("classifyCheck: network_error is split into tls / dns / connect by the cause chain", () => {
  const tls = new SafeFetchError("network_error", "The target could not be reached.", {
    cause: new Error("unable to verify the first certificate (ERR_TLS_CERT_ALTNAME_INVALID)"),
  });
  assert.equal(classifyError(tls).cause, "tls");

  const dns = new SafeFetchError("network_error", "The target could not be reached.", {
    cause: Object.assign(new Error("getaddrinfo EAI_AGAIN example.com"), { code: "EAI_AGAIN" }),
  });
  assert.equal(classifyError(dns).cause, "dns");

  const connect = new SafeFetchError("network_error", "The target could not be reached.", {
    cause: Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), { code: "ECONNREFUSED" }),
  });
  assert.equal(classifyError(connect).cause, "connect");

  // no recognizable hint → the generic network bucket
  const plain = new SafeFetchError("network_error", "The target could not be reached.");
  assert.equal(classifyError(plain).cause, "connect");
});

test("classifyCheck: a non-safeFetch error is never a network cause", () => {
  assert.equal(classifyError(new Error("out of memory")).cause, "other");
  assert.equal(classifyError("a string").cause, "other");
});

// ─── classifyCheck: statuses, keyword, degraded ───────────────────────────────

test("classifyCheck: accepted status with no keyword is up", () => {
  const r = classifyCheck({ httpStatus: 204, latencyMs: 120, error: null, bodyHasKeyword: null }, MON);
  assert.deepEqual({ ok: r.ok, status: r.status, cause: r.cause }, { ok: true, status: "up", cause: null });
});

test("classifyCheck: status outside acceptStatus is http_status", () => {
  const r = classifyCheck({ httpStatus: 502, latencyMs: 90, error: null, bodyHasKeyword: null }, MON);
  assert.deepEqual({ ok: r.ok, status: r.status, cause: r.cause, httpStatus: r.httpStatus, detail: r.detail },
    { ok: false, status: "down", cause: "http_status", httpStatus: 502, detail: "HTTP 502" });
});

test("classifyCheck: an extra accepted code (401) passes", () => {
  const r = classifyCheck({ httpStatus: 401, latencyMs: 90, error: null, bodyHasKeyword: null }, { ...MON, acceptStatus: "200-399,401" });
  assert.equal(r.ok, true);
});

test("classifyCheck: missing keyword is keyword_missing; null means unchecked", () => {
  const missing = classifyCheck({ httpStatus: 200, latencyMs: 90, error: null, bodyHasKeyword: false }, MON);
  assert.deepEqual({ ok: missing.ok, cause: missing.cause }, { ok: false, cause: "keyword_missing" });
  // no keyword configured (null) → not a failure
  const none = classifyCheck({ httpStatus: 200, latencyMs: 90, error: null, bodyHasKeyword: null }, MON);
  assert.equal(none.ok, true);
  // keyword present → fine
  const present = classifyCheck({ httpStatus: 200, latencyMs: 90, error: null, bodyHasKeyword: true }, MON);
  assert.equal(present.ok, true);
});

test("classifyCheck: slow but successful answer is degraded and still ok", () => {
  const r = classifyCheck({ httpStatus: 200, latencyMs: 5300, error: null, bodyHasKeyword: null }, MON);
  assert.deepEqual({ ok: r.ok, status: r.status }, { ok: true, status: "degraded" });
  const atLimit = classifyCheck({ httpStatus: 200, latencyMs: 5000, error: null, bodyHasKeyword: null }, MON);
  assert.equal(atLimit.status, "up", "slowMs is a strict > boundary");
});

test("classifyCheck: an error outranks everything, latency survives", () => {
  const r = classifyCheck({ httpStatus: 200, latencyMs: 15_000, error: new SafeFetchError("request_timeout", "timed out"), bodyHasKeyword: true }, MON);
  assert.deepEqual({ ok: r.ok, status: r.status, cause: r.cause, httpStatus: r.httpStatus, latencyMs: r.latencyMs },
    { ok: false, status: "down", cause: "timeout", httpStatus: null, latencyMs: 15_000 });
});

test("classifyCheck: no error but no status does not become a green dot", () => {
  const r = classifyCheck({ httpStatus: null, latencyMs: null, error: null, bodyHasKeyword: null }, MON);
  assert.deepEqual({ ok: r.ok, cause: r.cause }, { ok: false, cause: "other" });
});

test("causeFromError bounds the detail to 300 chars", () => {
  const { detail } = causeFromError(new SafeFetchError("network_error", "x".repeat(500)));
  assert.ok(detail.length <= 300);
});
