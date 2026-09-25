import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalBusinessSchema, BUSINESS_TYPES, diffSchemas, isKnownBusinessType, normaliseHours,
  validateLocalBusinessSchema,
} from "./schema";
import type { LocalProfileData } from "./types";

const profile = (): LocalProfileData => ({
  siteId: "s1",
  name: "Massage Thessaloniki",
  businessType: "DaySpa",
  street: "Egnatia 12",
  locality: "Thessaloniki",
  region: "Central Macedonia",
  postalCode: "546 22",
  country: "GR",
  phone: "+302310123456",
  email: "info@example.gr",
  lat: 40.64,
  lng: 22.94,
  hours: [
    { day: "Mo", opens: "09:00", closes: "21:00" },
    { day: "Tu", opens: "09:00", closes: "21:00" },
    { day: "Su", opens: "10:00", closes: "18:00" },
  ],
  priceRange: "€€",
  sameAs: ["https://www.facebook.com/massagethess", "https://www.instagram.com/massagethess"],
  serviceAreas: ["Kalamaria", "Pylaia"],
  gbpAccount: null,
  gbpLocation: null,
});

test("schema snapshot: full profile → LocalBusiness JSON-LD", () => {
  const json = buildLocalBusinessSchema(profile(), { url: "https://massagethess.gr/", image: "https://massagethess.gr/logo.png" });
  assert.deepEqual(json, {
    "@context": "https://schema.org",
    "@type": "DaySpa",
    name: "Massage Thessaloniki",
    url: "https://massagethess.gr/",
    telephone: "+302310123456",
    email: "info@example.gr",
    address: {
      streetAddress: "Egnatia 12",
      addressLocality: "Thessaloniki",
      addressRegion: "Central Macedonia",
      postalCode: "546 22",
      addressCountry: "GR",
    },
    geo: { "@type": "GeoCoordinates", latitude: 40.64, longitude: 22.94 },
    openingHoursSpecification: [
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Mo", opens: "09:00", closes: "21:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Tu", opens: "09:00", closes: "21:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Su", opens: "10:00", closes: "18:00" },
    ],
    priceRange: "€€",
    image: "https://massagethess.gr/logo.png",
    sameAs: ["https://www.facebook.com/massagethess", "https://www.instagram.com/massagethess"],
    areaServed: [
      { "@type": "City", name: "Kalamaria" },
      { "@type": "City", name: "Pylaia" },
    ],
  });
});

test("empty optional fields are omitted, not rendered empty", () => {
  const p = profile();
  const json = buildLocalBusinessSchema({
    ...p, phone: "", email: "", lat: null, lng: null, priceRange: "", sameAs: [], serviceAreas: [], hours: [],
    region: "", postalCode: "",
  });
  assert.ok(!("telephone" in json));
  assert.ok(!("email" in json));
  assert.ok(!("geo" in json));
  assert.ok(!("openingHoursSpecification" in json));
  assert.ok(!("priceRange" in json));
  assert.ok(!("sameAs" in json));
  assert.ok(!("areaServed" in json));
  assert.ok(!("addressRegion" in (json.address as object)));
});

test("validation: name and address are required, the rest are warnings", () => {
  const full = validateLocalBusinessSchema(buildLocalBusinessSchema(profile(), { url: "https://x.gr/" }));
  assert.deepEqual(full.required, []);
  assert.deepEqual(full.warnings, ["image"]); // everything else is present in the full profile

  const bare = validateLocalBusinessSchema({ "@context": "https://schema.org", "@type": "DaySpa", name: "" });
  assert.deepEqual(bare.required, ["name", "address"]);
  const warnings = new Set(bare.warnings);
  // no address object at all → the granular street/locality/country warnings do not apply
  for (const w of ["telephone", "url", "geo", "openingHoursSpecification", "image", "sameAs"]) {
    assert.ok(warnings.has(w), `expected warning ${w}`);
  }

  const noStreet = validateLocalBusinessSchema({
    "@context": "https://schema.org", "@type": "DaySpa", name: "X",
    address: { addressLocality: "Thessaloniki" },
  });
  assert.deepEqual(noStreet.required, []);
  const ws = new Set(noStreet.warnings);
  assert.ok(ws.has("streetAddress"));
  assert.ok(ws.has("addressCountry"));
});

test("validation flags TaxiService as not a LocalBusiness descendant", () => {
  const p = profile();
  const schema = buildLocalBusinessSchema({ ...p, businessType: "TaxiService" }, { url: "https://x.gr/" });
  const v = validateLocalBusinessSchema(schema, "TaxiService");
  assert.ok(v.warnings.includes("typeNotLocalBusiness"));
  const spa = validateLocalBusinessSchema(buildLocalBusinessSchema(profile(), { url: "https://x.gr/" }), "DaySpa");
  assert.ok(!spa.warnings.includes("typeNotLocalBusiness"));
});

test("the type list matches the brief and excludes the non-existent MassageTherapist", () => {
  assert.ok(!BUSINESS_TYPES.some(t => t.value === "MassageTherapist"));
  assert.ok(BUSINESS_TYPES.some(t => t.value === "TaxiService"));
  assert.ok(BUSINESS_TYPES.some(t => t.value === "DaySpa"));
  assert.ok(BUSINESS_TYPES.some(t => t.value === "AutoRepair"));
  assert.ok(isKnownBusinessType("DaySpa"));
  assert.ok(!isKnownBusinessType("MassageTherapist"));
});

test("normaliseHours sorts by weekday, drops garbage and lets the last row win per day", () => {
  const out = normaliseHours([
    { day: "Su", opens: "10:00", closes: "18:00" },
    { day: "Mo", opens: "bad", closes: "21:00" } as never,
    { day: "Tu", opens: "09:00", closes: "21:00" },
    { day: "Tu", opens: "10:00", closes: "22:00" },
    { day: "Xx", opens: "09:00", closes: "21:00" } as never,
  ]);
  assert.deepEqual(out, [
    { day: "Tu", opens: "10:00", closes: "22:00" },
    { day: "Su", opens: "10:00", closes: "18:00" },
  ]);
  assert.deepEqual(normaliseHours(null), []);
});

test("diffSchemas reports field-by-field agreement between site and generated markup", () => {
  const generated = buildLocalBusinessSchema(profile(), { url: "https://massagethess.gr/" });
  const site = {
    ...buildLocalBusinessSchema(profile(), {}),
    telephone: "+302310999999", // different phone
    // geo absent on the site
  } as Record<string, unknown>;
  delete site.geo;
  delete site.url;
  const diffs = diffSchemas(generated, site);
  const byField = Object.fromEntries(diffs.map(d => [d.field, d.same]));
  assert.equal(byField.name, true);
  assert.equal(byField.address, true);
  assert.equal(byField.telephone, false);
  assert.equal(byField.geo, false);   // generated has it, site doesn't
  assert.equal(byField.url, false);   // site has none
  assert.equal(byField.openingHoursSpecification, true);

  const none = diffSchemas(generated, null);
  assert.equal(none.length, 9);
  assert.ok(none.every(d => d.site === ""));
});
