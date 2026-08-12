import assert from "node:assert/strict";
import test from "node:test";
import { describeFingerprint, extractFingerprints, fingerprintStrength, flattenFingerprints } from "./fingerprints";

const HTML = `
<html><head>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-AB12CD34EF"></script>
<script>gtag('config', 'G-AB12CD34EF'); ga('create', 'UA-123456-7', 'auto');</script>
<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC1234');</script>
<script data-ad-client="ca-pub-1234567890123456"></script>
<script>ym(87654321, "init", {});</script>
<script>fbq('init', '1234567890123456');</script>
</head><body><footer>© 2019 Acme Holdings Ltd</footer></body></html>`;

test("the identifiers that actually cost money to duplicate are extracted", () => {
  const fp = extractFingerprints(HTML);
  assert.deepEqual(fp.ga4, ["G-AB12CD34EF"]);
  assert.deepEqual(fp.ua, ["UA-123456-7"]);
  assert.deepEqual(fp.gtm, ["GTM-ABC1234"]);
  assert.deepEqual(fp.adsense, ["ca-pub-1234567890123456"]);
  assert.deepEqual(fp.metrica, ["87654321"]);
  assert.deepEqual(fp.facebookPixel, ["1234567890123456"]);
  // A stale footer year is itself a signal, and it survives a template reskin.
  assert.match(fp.copyright ?? "", /2019 Acme Holdings/);
});

test("a page with no analytics produces no false identity", () => {
  const fp = extractFingerprints("<html><body><p>Just a page</p></body></html>");
  assert.deepEqual(fp.ga4, []);
  assert.deepEqual(fp.gtm, []);
  assert.equal(fp.copyright, null);
  assert.deepEqual(flattenFingerprints(fp), []);
});

test("the same id is reported once, however many times it appears", () => {
  const repeated = "G-AB12CD34EF ".repeat(20);
  assert.deepEqual(extractFingerprints(repeated).ga4, ["G-AB12CD34EF"]);
});

test("shared hosting is not evidence of shared ownership", () => {
  // An analytics property is billed to a person; a nameserver is shared by every customer of a
  // host. Conflating the two would report half the internet as one network.
  assert.equal(fingerprintStrength("ga4:g-ab12cd34ef"), "strong");
  assert.equal(fingerprintStrength("adsense:ca-pub-1"), "strong");
  assert.equal(fingerprintStrength("ns:ns1.cloudflare.com"), "weak");
  assert.equal(fingerprintStrength("ip:1.2.3.4"), "weak");
});

test("a CDN address is not an ownership signal", () => {
  // Two sites behind Cloudflare share Cloudflare, not an owner. Recording the IP would make every
  // Cloudflare site match every other one as the scan history grows.
  const fp = extractFingerprints("<html></html>");
  const behind = flattenFingerprints(fp, { ips: ["188.114.96.0"], ns: ["rudy.ns.cloudflare.com"], behindCdn: true });
  assert.deepEqual(behind, [], "a Cloudflare IP and a Cloudflare nameserver carry no ownership information");
  const direct = flattenFingerprints(fp, { ips: ["203.0.113.9"], ns: ["ns1.small-host.example"], behindCdn: false });
  assert.deepEqual(direct, ["ns:ns1.small-host.example", "ip:203.0.113.9"]);
});

test("flattened keys are lowercase, deduplicated and human-readable", () => {
  const keys = flattenFingerprints(extractFingerprints(HTML), { ns: ["NS1.Example.NET", "NS1.Example.NET"], ips: ["1.2.3.4"] });
  assert.ok(keys.includes("ga4:g-ab12cd34ef"));
  assert.ok(keys.includes("ns:ns1.example.net"));
  assert.equal(keys.filter(k => k === "ns:ns1.example.net").length, 1);
  assert.equal(describeFingerprint("gtm:gtm-abc1234"), "Google Tag Manager gtm-abc1234");
});
