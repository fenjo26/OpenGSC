import assert from "node:assert/strict";
import test from "node:test";
import { estimateSerpQueryCost, SERP_QUERY_COST_USD, usdToUnits } from "./price";

test("ten quoted fragments on Serper are priced from the published per-query rate", () => {
  const est = estimateSerpQueryCost("serper", 10);
  assert.equal(est.free, false);
  assert.equal(est.unknownPrice, false);
  assert.ok(Math.abs((est.costUsd ?? 0) - 10 * (SERP_QUERY_COST_USD.serper ?? 0)) < 1e-9);
});

test("A-Parser is free (self-hosted), with a null cost — never $0.00", () => {
  const est = estimateSerpQueryCost("aparser", 10);
  assert.equal(est.free, true);
  assert.equal(est.costUsd, null, "null ≠ 0: no per-request bill, not a zero bill");
  assert.equal(est.unknownPrice, false);
});

test("a provider missing from the table is unknown, not free, not zero", () => {
  const est = estimateSerpQueryCost("somethingnew", 10);
  assert.equal(est.free, false);
  assert.equal(est.costUsd, null);
  assert.equal(est.unknownPrice, true, "the UI must show 'price unknown', never '$0.00'");
});

test("zero queries cost zero and say so as a number, not as free", () => {
  const est = estimateSerpQueryCost("serper", 0);
  assert.equal(est.costUsd, 0);
  assert.equal(est.free, false);
});

test("units follow the fixed milli-dollar rate the demand routes use", () => {
  assert.equal(usdToUnits(0.003), 3);
  assert.equal(usdToUnits(0.0001), 1, "a fraction of a unit still reserves one");
});
