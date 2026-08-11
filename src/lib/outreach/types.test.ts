import test from "node:test";
import assert from "node:assert/strict";
import { isHttpUrl, normalizeProspectDomain, outreachErrorKey, OUTREACH_STAGE_SET } from "./types";

test("normalizeProspectDomain produces the same key for URL and host variants", () => {
  assert.equal(normalizeProspectDomain("https://WWW.Example.com/path?q=1"), "example.com");
  assert.equal(normalizeProspectDomain("www.example.com/another/path"), "example.com");
  assert.equal(normalizeProspectDomain("example.com."), "example.com");
});

test("isHttpUrl accepts only explicit HTTP(S) URLs", () => {
  assert.equal(isHttpUrl("https://example.com/contact"), true);
  assert.equal(isHttpUrl("http://example.com"), true);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("example.com/contact"), false);
});

test("outreach stages are a closed workflow", () => {
  assert.equal(OUTREACH_STAGE_SET.has("discovered"), true);
  assert.equal(OUTREACH_STAGE_SET.has("won"), true);
  assert.equal(OUTREACH_STAGE_SET.has("emailed_automatically"), false);
});

test("API error codes map to stable localization keys", () => {
  assert.equal(outreachErrorKey("invalid_contact_email"), "outreachErrorInvalidEmail");
  assert.equal(outreachErrorKey("campaign_not_found"), "outreachErrorNotFound");
  assert.equal(outreachErrorKey("unexpected provider detail"), "outreachErrorGeneric");
});
