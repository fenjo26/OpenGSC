import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, extractHistoryContent, joinContentPath, normalizeContentPath, runContentPreflight, validateRepositoryInput } from "./types";
import { createLineDiff } from "./diff";

test("content paths cannot escape the configured publishing root", () => {
  assert.equal(joinContentPath("content/blog", "hello-world.md"), "content/blog/hello-world.md");
  assert.throws(() => normalizeContentPath("../secrets.md"), /invalid_file_path/);
  assert.throws(() => normalizeContentPath(".github/workflows/deploy.yml"), /protected_file_path|unsupported/);
  assert.throws(() => normalizeContentPath("post.ts"), /unsupported_content_extension/);
});

test("repository coordinates and approval transitions are conservative", () => {
  assert.deepEqual(validateRepositoryInput({ owner: "open-gsc", repo: "site.git", baseBranch: "main", contentRoot: "posts" }), {
    name: "open-gsc/site", owner: "open-gsc", repo: "site", baseBranch: "main", contentRoot: "posts",
  });
  assert.equal(canTransition("idea", "approved"), true);
  assert.equal(canTransition("idea", "pr_open"), false);
  assert.equal(canTransition("pr_open", "live"), false);
});

test("history content extraction supports existing generator shapes", () => {
  assert.equal(extractHistoryContent("# Draft"), "# Draft");
  assert.equal(extractHistoryContent({ text: "Article" }), "Article");
  assert.equal(extractHistoryContent({ result: { markdown: "Nested" } }), "Nested");
});

test("preflight blocks placeholders, unsafe links and invented values", () => {
  const draft = `# Price guide\n\n${"Useful text for readers. ".repeat(20)}\nTODO verify the price 99 EUR.\n[click](javascript:alert(1))`;
  const report = runContentPreflight(draft, `# Price guide\n\n${"Useful text for readers. ".repeat(20)}\nPrice 49 EUR.`);
  assert.ok(report.blockers >= 3);
  assert.equal(report.factDrift, "danger");
});

test("bounded diff exposes the changed middle", () => {
  const diff = createLineDiff("same\nold\ntail", "same\nnew\ntail");
  assert.equal(diff.commonPrefix, 1);
  assert.equal(diff.commonSuffix, 1);
  assert.deepEqual(diff.removed, ["old"]);
  assert.deepEqual(diff.added, ["new"]);
});
