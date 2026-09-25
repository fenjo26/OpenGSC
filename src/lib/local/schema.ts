// LocalBusiness JSON-LD generator + validation (N4, brief §4). Pure: profile in, schema.org
// object out. Google's LocalBusiness requirements drive validation — required fields are errors,
// recommended ones warnings (https://developers.google.com/search/docs/appearance/structured-data/local-business).

import type { LocalProfileData, OpeningHoursDay } from "./types";

/**
 * schema.org types offered in the profile form. Verified against schema.org:
 * MassageTherapist does NOT exist there (404) and is therefore NOT in the list, per the brief.
 */
export const BUSINESS_TYPES: { value: string; localBusiness: boolean }[] = [
  { value: "LocalBusiness", localBusiness: true },
  { value: "TaxiService", localBusiness: false }, // Intangible > Service, not a LocalBusiness subtype — warned, still allowed (transfers)
  { value: "DaySpa", localBusiness: true },
  { value: "HealthAndBeautyBusiness", localBusiness: true },
  { value: "TravelAgency", localBusiness: true },
  { value: "Restaurant", localBusiness: true },
  { value: "Hotel", localBusiness: true },
  { value: "Dentist", localBusiness: true },
  { value: "LegalService", localBusiness: true },
  { value: "Plumber", localBusiness: true },
  { value: "AutoRepair", localBusiness: true },
];

export const DEFAULT_BUSINESS_TYPE = "LocalBusiness";

export function isKnownBusinessType(value: string): boolean {
  return BUSINESS_TYPES.some(t => t.value === value);
}

const DAY_ORDER: Record<OpeningHoursDay["day"], number> = { Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6 };

/** schema.org LocalBusiness JSON-LD built from the profile. Extra context (site url, logo) is
 *  passed in because the DB row has no such fields — the logo comes from the site's og:image. */
export function buildLocalBusinessSchema(
  p: LocalProfileData,
  opts: { url?: string; image?: string } = {},
): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": p.businessType || DEFAULT_BUSINESS_TYPE,
    name: p.name,
  };
  if (opts.url) schema.url = opts.url;
  if (p.phone) schema.telephone = p.phone;
  if (p.email) schema.email = p.email;

  const address: Record<string, string> = {};
  if (p.street) address.streetAddress = p.street;
  if (p.locality) address.addressLocality = p.locality;
  if (p.region) address.addressRegion = p.region;
  if (p.postalCode) address.postalCode = p.postalCode;
  if (p.country) address.addressCountry = p.country;
  if (Object.keys(address).length) schema.address = address;

  if (p.lat != null && p.lng != null) {
    schema.geo = { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng };
  }

  const hours = normaliseHours(p.hours);
  if (hours.length) {
    schema.openingHoursSpecification = hours.map(h => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: h.day,
      opens: h.opens,
      closes: h.closes,
    }));
  }

  if (p.priceRange) schema.priceRange = p.priceRange;
  if (opts.image) schema.image = opts.image;
  if (p.sameAs.length) schema.sameAs = [...p.sameAs];

  const areas = p.serviceAreas.filter(a => a.trim());
  if (areas.length) {
    schema.areaServed = areas.map(a => ({ "@type": "City", name: a.trim() }));
  }
  return schema;
}

/** Sorted, de-duplicated, well-formed hours (opens/closes HH:MM); garbage rows dropped. */
export function normaliseHours(hours: OpeningHoursDay[] | null | undefined): OpeningHoursDay[] {
  if (!Array.isArray(hours)) return [];
  const timeOk = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const byDay = new Map<OpeningHoursDay["day"], OpeningHoursDay>();
  for (const h of hours) {
    if (!h || typeof h !== "object") continue;
    const day = h.day as OpeningHoursDay["day"];
    if (!(day in DAY_ORDER)) continue;
    if (!timeOk(h.opens) || !timeOk(h.closes)) continue;
    byDay.set(day, { day, opens: h.opens, closes: h.closes }); // later row for a day wins
  }
  return [...byDay.values()].sort((a, b) => DAY_ORDER[a.day] - DAY_ORDER[b.day]);
}

// ─── validation (Google's LocalBusiness requirements) ──────────────────────────

export interface SchemaValidation {
  /** Field codes of REQUIRED properties Google asks for (name, street/address, locality…). */
  required: string[];
  /** Recommended-missing codes → UI warnings, not blockers. */
  warnings: string[];
}

/**
 * Required by Google: `name` and a postal address (street + locality at minimum; the full
 * address is strongly recommended and missing parts surface as warnings). `telephone` is the
 * third pillar of NAP — recommended. `geo`, `openingHoursSpecification`, `url`, `image`,
 * `priceRange`, `sameAs` and `areaServed` are recommended extras with their own warnings.
 */
export function validateLocalBusinessSchema(
  schema: Record<string, unknown>,
  typeValue?: string,
): SchemaValidation {
  const required: string[] = [];
  const warnings: string[] = [];

  if (!String(schema.name ?? "").trim()) required.push("name");

  const address = schema.address as Record<string, unknown> | undefined;
  const streetOk = !!address && typeof address.streetAddress === "string" && !!address.streetAddress.trim();
  const localityOk = !!address && typeof address.addressLocality === "string" && !!address.addressLocality.trim();
  const hasAddress = !!address && (streetOk || localityOk);
  if (!hasAddress) required.push("address");
  else {
    if (!streetOk) warnings.push("streetAddress");
    if (!localityOk) warnings.push("addressLocality");
    if (!address || typeof address.addressCountry !== "string" || !address.addressCountry.trim()) warnings.push("addressCountry");
  }

  if (!String(schema.telephone ?? "").trim()) warnings.push("telephone");
  if (schema.url == null) warnings.push("url");
  if (schema.geo == null) warnings.push("geo");
  if (!Array.isArray(schema.openingHoursSpecification) || schema.openingHoursSpecification.length === 0) warnings.push("openingHoursSpecification");
  if (schema.image == null) warnings.push("image");
  if (!Array.isArray(schema.sameAs) || schema.sameAs.length === 0) warnings.push("sameAs");

  const type = String(typeValue ?? schema["@type"] ?? "");
  if (type === "TaxiService") {
    // Not a LocalBusiness descendant (Service > TaxiService) — Google's LocalBusiness rich
    // result will not fire. Kept in the list because transfers need it; the user should know.
    warnings.push("typeNotLocalBusiness");
  }
  return { required, warnings };
}

// ─── compare with the site's own JSON-LD (brief §4) ────────────────────────────

export interface SchemaFieldDiff {
  field: string;
  generated: string; // '' = absent
  site: string;      // '' = absent
  same: boolean;
}

/** Flatten the handful of scalar/one-line fields that matter into comparable strings. */
function comparable(schema: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : JSON.stringify(v));
  out.name = s(schema.name);
  out.telephone = s(schema.telephone);
  out.email = s(schema.email);
  out.priceRange = s(schema.priceRange);
  out.url = s(schema.url);
  out.image = s(Array.isArray(schema.image) ? schema.image[0] : schema.image);
  const addr = schema.address as Record<string, unknown> | undefined;
  out.address = addr
    ? [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode, addr.addressCountry].map(s).filter(Boolean).join(", ")
    : "";
  const geo = schema.geo as Record<string, unknown> | undefined;
  out.geo = geo ? `${s(geo.latitude)},${s(geo.longitude)}` : "";
  const hours = Array.isArray(schema.openingHoursSpecification)
    ? (schema.openingHoursSpecification as { dayOfWeek?: unknown; opens?: unknown; closes?: unknown }[])
        .map(h => `${s(h.dayOfWeek)} ${s(h.opens)}-${s(h.closes)}`).sort().join("; ")
    : "";
  out.openingHoursSpecification = hours;
  return out;
}

/** Field-by-field diff of the generated schema vs the LocalBusiness found on the site. */
export function diffSchemas(
  generated: Record<string, unknown>,
  site: Record<string, unknown> | null,
): SchemaFieldDiff[] {
  const g = comparable(generated);
  const s = site ? comparable(site) : {};
  const fields = ["name", "address", "telephone", "email", "geo", "openingHoursSpecification", "priceRange", "url", "image"];
  return fields.map(field => ({
    field,
    generated: g[field] ?? "",
    site: s[field] ?? "",
    same: g[field] === s[field],
  }));
}
