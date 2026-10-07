import test from "node:test";
import assert from "node:assert/strict";
import { parseWindowMs, parseConnectionType, respinAllowedFor, CONNECTION_TYPES } from "./store";

// The store's pure decision helpers — the parts every surface (route, MCP, scheduler)
// inherits. Importing store.ts builds the prisma client without running a query, same as
// the providerLog tests that import log.ts; nothing here touches the database.

test("parseWindowMs: null when immediate, ms when set, error on conflict or non-positive", () => {
  assert.equal(parseWindowMs({}), null);
  assert.equal(parseWindowMs({ windowHours: 6 }), 6 * 3_600_000);
  assert.equal(parseWindowMs({ windowDays: 2 }), 2 * 86_400_000);
  assert.throws(() => parseWindowMs({ windowHours: 6, windowDays: 2 }), /window_conflict/);
  assert.throws(() => parseWindowMs({ windowHours: -1 }), /window_invalid/);
  assert.throws(() => parseWindowMs({ windowDays: 0 }), /window_invalid/, "explicit zero is a bug, not 'immediate'");
});

test("parseConnectionType accepts exactly the three vocabulary values, fails closed otherwise", () => {
  assert.equal(parseConnectionType("own_satellite"), "own_satellite");
  assert.equal(parseConnectionType("money_site"), "money_site");
  assert.equal(parseConnectionType("external_platform"), "external_platform");
  assert.throws(() => parseConnectionType("web20_farm"), /unknown_connection_type/);
  assert.throws(() => parseConnectionType(""), /unknown_connection_type/);
  assert.deepEqual([...CONNECTION_TYPES], ["own_satellite", "money_site", "external_platform"]);
});

test("respinAllowedFor is a whitelist: ONLY external_platform, so a future type cannot inherit it", () => {
  assert.equal(respinAllowedFor("external_platform"), true);
  assert.equal(respinAllowedFor("own_satellite"), false);
  assert.equal(respinAllowedFor("money_site"), false);
  assert.equal(respinAllowedFor("something_new"), false, "unknown types fail closed");
});
