import test from "node:test";
import assert from "node:assert/strict";
import { assessLastmodReliability, contentFingerprint } from "./metadata";

test("content fingerprint ignores markup, script and whitespace churn", () => {
  const first = contentFingerprint(`<main><h1>Hello</h1><p>World</p></main><script>window.build=1</script>`);
  const second = contentFingerprint(`<div class="new"><h1> Hello </h1>\n<p>World</p></div><script>window.build=2</script>`);
  assert.equal(first, second);
});

test("lastmod is suspicious when it changes without observed content change", () => {
  assert.equal(assessLastmodReliability({
    previousHash: "same", currentHash: "same", previousLastmod: "2026-08-11", currentLastmod: "2026-08-12",
  }), "suspicious");
  assert.equal(assessLastmodReliability({
    previousHash: "old", currentHash: "new", previousLastmod: "2026-08-11", currentLastmod: "2026-08-12",
  }), "reliable");
  assert.equal(assessLastmodReliability({
    previousHash: null, currentHash: "new", previousLastmod: null, currentLastmod: null,
  }), "unknown");
});
