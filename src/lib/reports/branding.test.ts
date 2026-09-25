import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BRANDING, LOGO_MAX_BYTES, parseBranding } from "./branding";

// bytes = the DECODED size of the image: base64 grows it by 4/3, so the payload needs
// ceil(bytes * 4 / 3) characters ("A" carries no padding, keeping the maths exact at the
// ceiling boundary).
const pngLogo = (bytes: number): string => {
  const b64 = "A".repeat(Math.ceil(bytes * 4 / 3));
  return `data:image/png;base64,${b64}`;
};

test("logo over 200 KiB is rejected and named, not truncated", () => {
  const { branding, issues } = parseBranding({ logoDataUrl: pngLogo(LOGO_MAX_BYTES + 100) });
  assert.deepEqual(issues, ["logo_too_large"]);
  assert.equal(branding.logoDataUrl, "");
});

test("logo at exactly the ceiling passes", () => {
  const { branding, issues } = parseBranding({ logoDataUrl: pngLogo(LOGO_MAX_BYTES) });
  assert.deepEqual(issues, []);
  assert.ok(branding.logoDataUrl.startsWith("data:image/png;base64,"));
});

test("logo of an unusable MIME type is rejected", () => {
  const { branding, issues } = parseBranding({ logoDataUrl: "data:image/webp;base64,AAAA" });
  assert.ok(issues.includes("logo_bad_format"));
  assert.equal(branding.logoDataUrl, "");
  const gif = parseBranding({ logoDataUrl: "data:image/gif;base64,AAAA" });
  assert.ok(gif.issues.includes("logo_bad_format"));
});

test("accent colour must be a hex literal; anything else falls back with a named issue", () => {
  const { branding, issues } = parseBranding({ accentColor: "red" });
  assert.ok(issues.includes("color_bad_format"));
  assert.equal(branding.accentColor, DEFAULT_BRANDING.accentColor);
  assert.equal(parseBranding({ accentColor: "#0ea5e9" }).issues.length, 0);
});

test("website must be http(s) and is normalised; junk is dropped with an issue", () => {
  assert.equal(parseBranding({ website: "https://agency.example.com" }).branding.website, "https://agency.example.com/");
  assert.ok(parseBranding({ website: "javascript:alert(1)" }).issues.includes("website_bad_format"));
  assert.ok(parseBranding({ website: "not a url" }).issues.includes("website_bad_format"));
  assert.equal(parseBranding({}).branding.website, "");
});

test("empty input is the neutral white-label default, powered-by off", () => {
  const { branding, issues } = parseBranding(null);
  assert.deepEqual(issues, []);
  assert.deepEqual(branding, DEFAULT_BRANDING);
  assert.equal(branding.showPoweredBy, false);
  assert.equal(parseBranding({ showPoweredBy: true }).branding.showPoweredBy, true);
});

test("footer is capped at 300 chars and says so", () => {
  const { branding, issues } = parseBranding({ footer: "x".repeat(301) });
  assert.deepEqual(issues, ["footer_too_long"]);
  assert.equal(branding.footer.length, 300);
});
