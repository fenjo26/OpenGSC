import test from "node:test";
import assert from "node:assert/strict";
import { planMissingTransitions, type ExistingInventoryRow } from "./diff";

const row = (overrides: Partial<ExistingInventoryRow> = {}): ExistingInventoryRow => ({
  id: "one", url: "https://example.com/one", sourceSitemap: "https://example.com/sitemap.xml",
  sitemapType: "standard", lastmod: null, lastmodValid: null, imageCount: 0, videoCount: 0,
  newsCount: 0, inventoryStatus: "active", missingSyncs: 0, ...overrides,
});

test("partial sitemap sync never advances disappearance state", () => {
  assert.deepEqual(planMissingTransitions([row()], new Set(), true), {
    pendingIds: [], missingIds: [], pendingMissing: 0, disappeared: 0,
  });
});

test("a URL becomes disappeared only after the second complete sync without it", () => {
  assert.deepEqual(planMissingTransitions([row()], new Set(), false), {
    pendingIds: ["one"], missingIds: [], pendingMissing: 1, disappeared: 0,
  });
  assert.deepEqual(planMissingTransitions([row({ inventoryStatus: "pending_missing", missingSyncs: 1 })], new Set(), false), {
    pendingIds: [], missingIds: ["one"], pendingMissing: 0, disappeared: 1,
  });
});
