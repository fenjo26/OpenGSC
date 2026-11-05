import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyResultReason } from "./resultGuard";

test("empty text is a failure", () => {
  assert.match(emptyResultReason("text", { text: "" }) ?? "", /^empty_result/);
});
test("meta block alone is a failure", () => {
  const t = "```\nTitle: X\nMeta Description: Y\nURL Slug: z\n```\n\n# H1\n";
  assert.match(emptyResultReason("text", { text: t }) ?? "", /^empty_result/);
});
test("a real article passes", () => {
  assert.equal(emptyResultReason("text", { text: "# H1\n\n" + "word ".repeat(200) }), null);
});
test("outline without sections is a failure, with sections passes", () => {
  assert.match(emptyResultReason("outline", { sections: [] }) ?? "", /^empty_result/);
  assert.equal(emptyResultReason("outline", { sections: [{ h2: "a" }] }), null);
});
test("other types are not judged", () => {
  assert.equal(emptyResultReason("analysis", null), null);
});
