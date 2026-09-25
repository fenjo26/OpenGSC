import assert from "node:assert/strict";
import test from "node:test";
import {
  addressesMatch, compareNapPage, contactPageLinks, extractAddress, extractBusinessName,
  extractNap, extractPhones, fillFromSite, fold, homepageUrl, jsonLdNodesOfType, namesMatch,
  parseJsonLdBlocks,
} from "./nap";
import type { LocalProfileData } from "./types";

const profile = (over: Partial<LocalProfileData> = {}): LocalProfileData => ({
  siteId: "s1",
  name: "Massage Thessaloniki",
  businessType: "DaySpa",
  street: "Egnatia 12",
  locality: "Thessaloniki",
  region: "Central Macedonia",
  postalCode: "546 22",
  country: "gr",
  phone: "+302310123456",
  email: "info@example.gr",
  lat: 40.64,
  lng: 22.94,
  hours: [{ day: "Mo", opens: "09:00", closes: "21:00" }],
  priceRange: "€€",
  sameAs: ["https://www.facebook.com/massagethess"],
  serviceAreas: ["Kalamaria", "Pylaia"],
  gbpAccount: null,
  gbpLocation: null,
  ...over,
});

// ─── name comparison ───────────────────────────────────────────────────────────

test("names match across case, accents and legal forms", () => {
  assert.ok(namesMatch("Massage Thessaloniki", "massage thessaloniki"));
  assert.ok(namesMatch("Massage Thessaloniki IKE", "Massage Thessaloniki"));
  assert.ok(namesMatch("Massage Thessaloniki", "Massage Thessaloniki Ι.Κ.Ε."));
  assert.ok(!namesMatch("Massage Thessaloniki", "Massage Athens"));
  assert.ok(!namesMatch("Massage Thessaloniki", ""));
});

// ─── address comparison ────────────────────────────────────────────────────────

test("addresses match on folded word Jaccard >= 0.7", () => {
  assert.ok(addressesMatch("Egnatia 12, Thessaloniki, 546 22", "Egnatia 12, 54622 Thessaloniki"));
  assert.ok(!addressesMatch("Egnatia 12, Thessaloniki", "Tsimiski 45, Athens, 104 31"));
  // below the 0.7 bar: half the words differ
  assert.ok(!addressesMatch("Egnatia 12 Thessaloniki", "Tsimiski 90 Thessaloniki"));
});

// ─── JSON-LD ───────────────────────────────────────────────────────────────────

const JSONLD_PAGE = `<!doctype html><html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"DaySpa","name":"Massage Thessaloniki",
 "telephone":"+30 2310 123456","email":"info@example.gr","priceRange":"€€",
 "address":{"@type":"PostalAddress","streetAddress":"Egnatia 12","addressLocality":"Thessaloniki","postalCode":"546 22","addressCountry":"GR"},
 "geo":{"@type":"GeoCoordinates","latitude":40.64,"longitude":22.94},
 "sameAs":["https://www.facebook.com/massagethess"]}
</script></head><body><footer>Call +30 2310 123456</footer></body></html>`;

test("parseJsonLdBlocks reads single blocks, arrays and @graph", () => {
  assert.equal(parseJsonLdBlocks(JSONLD_PAGE).length, 1);
  const graph = parseJsonLdBlocks(`<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"LocalBusiness"}]}</script>`);
  assert.equal(graph.length, 3); // root + 2 graph nodes
  const broken = parseJsonLdBlocks(`<script type="application/ld+json">{broken</script><script type="application/ld+json">{"@type":"LocalBusiness"}</script>`);
  assert.equal(broken.length, 1); // the broken block is skipped, not fatal
});

test("jsonLdNodesOfType matches @type case-insensitively, incl. arrays", () => {
  assert.equal(jsonLdNodesOfType(JSONLD_PAGE, "dayspa").length, 1);
  assert.equal(jsonLdNodesOfType(`<script type="application/ld+json">{"@type":["LocalBusiness","DaySpa"]}</script>`, "DaySpa").length, 1);
  assert.equal(jsonLdNodesOfType(JSONLD_PAGE, "Restaurant").length, 0);
});

// ─── extraction: address ───────────────────────────────────────────────────────

test("address comes from JSON-LD PostalAddress first", () => {
  const { address, fromJsonLd } = extractAddress(JSONLD_PAGE, profile());
  assert.equal(fromJsonLd, true);
  assert.ok(address.startsWith("Egnatia 12"));
});

test("address comes from microdata when there is no JSON-LD", () => {
  const html = `<div itemprop="address" itemscope>
    <span itemprop="streetAddress">Egnatia 12</span>,
    <span itemprop="addressLocality">Thessaloniki</span> <span itemprop="postalCode">546 22</span>
  </div>`;
  const { address } = extractAddress(html, profile());
  assert.ok(address.includes("Egnatia 12"));
  assert.ok(address.includes("546 22"));
});

test("address falls back to finding the profile's street in the text", () => {
  const html = `<html><body><footer><p>Βρείτε μας: Egnatia 12, Thessaloniki 546 22, Ελλάδα</p></footer></body></html>`;
  const { address } = extractAddress(html, profile());
  assert.ok(address.includes("Egnatia 12"));

  const none = extractAddress(`<html><body>Nothing local here.</body></html>`, profile());
  assert.equal(none.address, "");
});

// ─── extraction: phones ────────────────────────────────────────────────────────

test("tel: links win over text matches and everything normalises to E.164", () => {
  const html = `<a href="tel:+302311999888">call us</a> · printed: 2310 123456 · mobile +30 697 000 1111`;
  const phones = extractPhones(html, "gr");
  assert.deepEqual(phones, ["+302311999888", "+302310123456", "+306970001111"]);
});

test("five-digit runs (postal codes, prices) are not phones", () => {
  const html = `<p>Price 29900 · postal code 54622</p>`;
  assert.deepEqual(extractPhones(html, "gr"), []);
});

// ─── extraction: business name ─────────────────────────────────────────────────

test("business name: JSON-LD name beats og:site_name beats <title>", () => {
  assert.equal(extractBusinessName(JSONLD_PAGE), "Massage Thessaloniki");
  assert.equal(extractBusinessName(`<meta property="og:site_name" content="Massage Thess">`), "Massage Thess");
  assert.equal(extractBusinessName(`<title>Massage Thessaloniki | Αναζήτηση</title>`), "Massage Thessaloniki");
});

// ─── full page compare ─────────────────────────────────────────────────────────

test("compareNapPage marks match/differs/missing per field", () => {
  const found = extractNap(JSONLD_PAGE, "gr");
  const diffs = compareNapPage(profile(), "https://example.gr/", found);
  assert.equal(diffs.length, 3);
  const byField = Object.fromEntries(diffs.map(d => [d.field, d.status]));
  assert.equal(byField.name, "match");
  assert.equal(byField.phone, "match");
  assert.equal(byField.address, "match");

  const wrongPhone = profile({ phone: "+302310999999" });
  const differing = Object.fromEntries(compareNapPage(wrongPhone, "u", found).map(d => [d.field, d.status]));
  assert.equal(differing.phone, "differs");

  const foundNone = extractNap(`<html><body>Menu only</body></html>`, "gr");
  const missing = Object.fromEntries(compareNapPage(profile(), "u", foundNone).map(d => [d.field, d.status]));
  assert.equal(missing.name, "missing");
  assert.equal(missing.phone, "missing");
  assert.equal(missing.address, "missing");
});

// ─── contact page discovery ────────────────────────────────────────────────────

test("contactPageLinks finds contact pages in en/de/el/ru and caps at 10, same origin", () => {
  const html = `<nav>
    <a href="/contact">Contact</a>
    <a href="/kontakt">Kontakt</a>
    <a href="/el/epikoinonia">Επικοινωνία</a>
    <a href="/about">about us</a>
    <a href="https://other.example.com/contact">foreign</a>
    <a href="mailto:x@example.gr">mail</a>
  </nav>`;
  const links = contactPageLinks(html, "https://example.gr/");
  assert.equal(links.length, 4);
  assert.ok(links.includes("https://example.gr/contact"));
  assert.ok(links.includes("https://example.gr/el/epikoinonia"));
  assert.ok(!links.includes("https://other.example.com/contact"));

  const many = Array.from({ length: 15 }, (_, i) => `<a href="/contact-${i}">contact</a>`).join("");
  assert.equal(contactPageLinks(many, "https://example.gr/").length, 10);
});

// ─── homepage url ──────────────────────────────────────────────────────────────

test("homepageUrl understands both DB spellings", () => {
  assert.equal(homepageUrl("example.gr"), "https://example.gr");
  assert.equal(homepageUrl("sc-domain:example.gr"), "https://example.gr");
  assert.equal(homepageUrl("https://example.gr/"), "https://example.gr/");
  assert.equal(homepageUrl(""), "");
});

// ─── fill from site ────────────────────────────────────────────────────────────

test("fillFromSite harvests the profile fields from homepage JSON-LD", () => {
  const draft = fillFromSite(JSONLD_PAGE, "gr");
  assert.equal(draft.name, "Massage Thessaloniki");
  assert.equal(draft.businessType, "DaySpa");
  assert.equal(draft.phone, "+302310123456");
  assert.equal(draft.street, "Egnatia 12");
  assert.equal(draft.locality, "Thessaloniki");
  assert.equal(draft.postalCode, "546 22");
  assert.equal(draft.country, "GR");
  assert.equal(draft.lat, 40.64);
  assert.equal(draft.lng, 22.94);
  assert.deepEqual(draft.sameAs, ["https://www.facebook.com/massagethess"]);
});

test("fillFromSite without JSON-LD still picks the first phone from the page", () => {
  const draft = fillFromSite(`<a href="tel:+306970001111">call</a>`, "gr");
  assert.equal(draft.phone, "+306970001111");
  assert.equal(draft.name, undefined); // nothing to harvest — the user fills it by hand
});

// ─── fold ──────────────────────────────────────────────────────────────────────

test("fold strips case, accents and punctuation", () => {
  assert.equal(fold("Επικοινωνία!"), "επικοινωνια");
  assert.equal(fold("Thessaloníki-546"), "thessaloniki 546");
});
