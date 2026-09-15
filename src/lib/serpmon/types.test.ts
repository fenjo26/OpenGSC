import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PLATFORM_HOSTS, MOVE_THRESHOLDS, SERPMON_DEPTHS,
  STORM_BASELINE_RUNS, STORM_MIN_BASELINE,
} from "./types";

test("SERPMON_DEPTHS ascend and end at 100", () => {
  for (let i = 1; i < SERPMON_DEPTHS.length; i++) {
    assert.ok(SERPMON_DEPTHS[i] > SERPMON_DEPTHS[i - 1], `depth ${SERPMON_DEPTHS[i]} > ${SERPMON_DEPTHS[i - 1]}`);
  }
  assert.equal(SERPMON_DEPTHS[SERPMON_DEPTHS.length - 1], 100);
});

test("MOVE_THRESHOLDS bands ascend by upTo and the last one covers 100", () => {
  for (let i = 1; i < MOVE_THRESHOLDS.length; i++) {
    assert.ok(MOVE_THRESHOLDS[i].upTo > MOVE_THRESHOLDS[i - 1].upTo);
  }
  assert.ok(MOVE_THRESHOLDS[MOVE_THRESHOLDS.length - 1].upTo >= 100);
});

test("DEFAULT_PLATFORM_HOSTS are bare lower-case hosts without duplicates", () => {
  const seen = new Set<string>();
  for (const host of DEFAULT_PLATFORM_HOSTS) {
    assert.equal(host, host.toLowerCase(), `${host} is lower-case`);
    assert.ok(!host.startsWith("www."), `${host} has no www.`);
    assert.ok(!host.includes("://") && !host.includes("/") && !host.includes(" "), `${host} is a bare host`);
    assert.ok(!seen.has(host), `${host} appears once`);
    seen.add(host);
  }
});

test("storm baseline needs fewer runs than the baseline window keeps", () => {
  assert.ok(STORM_MIN_BASELINE <= STORM_BASELINE_RUNS);
});
