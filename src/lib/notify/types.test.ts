import assert from "node:assert/strict";
import test from "node:test";
import { NOTIFY_EVENTS } from "./types";

test("NOTIFY_EVENTS has no \"test\" and no duplicates", () => {
  assert.ok(!NOTIFY_EVENTS.includes("test" as never));
  assert.equal(new Set(NOTIFY_EVENTS).size, NOTIFY_EVENTS.length);
});
