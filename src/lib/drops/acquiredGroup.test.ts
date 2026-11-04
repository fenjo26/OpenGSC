import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACQUIRED_GROUP_NAMES, acquiredGroupName, isAcquiredGroupName, pickAcquiredGroup, sanitizeAcquiredGroupName,
} from "./acquiredGroup";

test("every interface language has a name", () => {
  for (const lang of ["en", "ru", "uk", "de", "es", "fr", "nl", "zh"]) {
    assert.ok(ACQUIRED_GROUP_NAMES[lang], lang);
    assert.equal(acquiredGroupName(lang), ACQUIRED_GROUP_NAMES[lang]);
  }
  assert.equal(acquiredGroupName("pt"), "Acquired");
  assert.equal(acquiredGroupName(undefined), "Acquired");
});

test("an existing group is recognised in any language and common variants", () => {
  assert.ok(isAcquiredGroupName("Куплено"));
  assert.ok(isAcquiredGroupName("  купленные "));
  assert.ok(isAcquiredGroupName("Gekauft"));
  assert.ok(isAcquiredGroupName("ACQUIRED"));
  assert.ok(!isAcquiredGroupName("Отложенные"));
});

test("switching language reuses the oldest matching group instead of making a second one", () => {
  const groups = [
    { id: "b", name: "Acquired", createdAt: "2026-11-02T00:00:00Z" },
    { id: "x", name: "Отложенные", createdAt: "2026-01-01T00:00:00Z" },
    { id: "a", name: "Куплено", createdAt: "2026-10-01T00:00:00Z" },
  ];
  assert.equal(pickAcquiredGroup(groups)?.id, "a");
  assert.equal(pickAcquiredGroup([{ id: "x", name: "Other", createdAt: new Date() }]), null);
});

test("the route only creates names from the table", () => {
  assert.equal(sanitizeAcquiredGroupName("Куплено"), "Куплено");
  assert.equal(sanitizeAcquiredGroupName("<script>"), "Acquired");
  assert.equal(sanitizeAcquiredGroupName(42), "Acquired");
});
