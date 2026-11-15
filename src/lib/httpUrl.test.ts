import { test } from "node:test";
import assert from "node:assert/strict";
import { isHttpUrl } from "./httpUrl";

test("isHttpUrl: absolute http(s) URLs are linkable", () => {
  assert.equal(isHttpUrl("https://albokl.com/articles/x/"), true);
  assert.equal(isHttpUrl("http://albokl.com"), true);
  assert.equal(isHttpUrl("HTTPS://albokl.com"), true);
});

test("isHttpUrl: query strings and paths are not linkable", () => {
  assert.equal(isHttpUrl("تحليل السائل المنوي عند الرجل"), false);
  assert.equal(isHttpUrl("/articles/relative-path"), false);
  assert.equal(isHttpUrl(""), false);
  assert.equal(isHttpUrl("ftp://example.com/x"), false);
});
