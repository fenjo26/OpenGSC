import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MENTION_SOURCES } from "./types";

test("DEFAULT_MENTION_SOURCES has no duplicates", () => {
  assert.equal(new Set(DEFAULT_MENTION_SOURCES).size, DEFAULT_MENTION_SOURCES.length);
});
