// Phone normalisation to E.164 for the NAP check (N4). Pure — no Prisma, no fetch.
//
// Local SEO lives and dies on the exact same phone digits everywhere, but sites print the same
// number as "+30 2310 123456", "2310-123456" and "00302310123456". The comparison therefore runs
// on normalised E.164 digits, never on the printed string.

/** ISO-3166 alpha-2 → ITU calling code. Covers the countries the instance's sites run on plus
 *  the EU neighbourhood; unknown countries fall back to no country code (see normalizeToE164). */
export const CALLING_CODES: Record<string, string> = {
  gr: "30", cy: "357", de: "49", fr: "33", es: "34", it: "39", pt: "351",
  nl: "31", be: "32", lu: "352", at: "43", ch: "41", pl: "48", cz: "420",
  sk: "421", hu: "36", ro: "40", bg: "359", hr: "385", si: "386", rs: "381",
  mk: "389", al: "355", ba: "387", me: "382", ua: "380", tr: "90", gb: "44",
  ie: "353", se: "46", no: "47", dk: "45", fi: "358", ee: "372", lv: "371",
  lt: "370", is: "354", mt: "356", ru: "7", by: "375", md: "373", ge: "995",
  am: "374", az: "994", kz: "7", us: "1", ca: "1", mx: "52", br: "55",
  ar: "54", cl: "56", co: "57", au: "61", nz: "64", jp: "81", kr: "82",
  cn: "86", in: "91", id: "62", th: "66", vn: "84", ph: "63", my: "60",
  sg: "65", hk: "852", tw: "886", il: "972", ae: "971", sa: "966", qa: "974",
  eg: "20", za: "27", ng: "234", ke: "254",
};

/** Digits only, as E.164 comparison sees them. "+30 2310 123456" → "302310123456". */
export function e164Digits(value: string): string {
  return (value || "").replace(/\D+/g, "");
}

/** Plausible length gate — anything under 6 or over 15 digits is not a phone number. */
function plausible(digits: string): boolean {
  return digits.length >= 6 && digits.length <= 15;
}

/**
 * Normalise one printed phone number to E.164 (`+<digits>`), using the profile's country when
 * the number carries no code of its own. Returns null when nothing plausible remains.
 *
 * Accepted inputs: "+30 2310 123456", "00302310123456" (international prefix), "2310-123456",
 * "(2310) 12 34 56", Greek-style "2310 123456". A leading "00" is stripped as the international
 * prefix BEFORE digit-length checks, so 0030… never reads as a 14-digit national number.
 */
export function normalizeToE164(raw: string, country = ""): string | null {
  let value = (raw || "").trim();
  if (!value) return null;
  // tel: scheme may still be attached when a caller passed a link by accident.
  value = value.replace(/^tel:/i, "").replace(/[\s().\-\/–—]/g, "");
  if (!value) return null;

  let digits = e164Digits(value);

  if (value.startsWith("00")) {
    // International prefix: drop it, the rest already includes the country code.
    digits = digits.replace(/^00/, "");
  } else if (value.startsWith("+")) {
    // Already E.164-shaped — keep digits as they are.
  } else {
    // National format: no code given, so the profile's country supplies it — but only when the
    // number does not already start with that code (a site printing "30 2310…" half-normalised).
    const code = CALLING_CODES[(country || "").toLowerCase()] ?? "";
    if (code) {
      if (!digits.startsWith(code)) {
        // Trunk prefix: national numbers printed with a leading 0 ("020 7946 0958") lose it in
        // E.164 ("442079460958"). One 0 only — a code-less number that is all zeros is garbage.
        if (digits.startsWith("0")) digits = digits.slice(1);
        // A national part under 6 digits is a postal code or a price, not a phone number.
        if (digits.length < 6) return null;
        digits = code + digits;
      }
    }
    // No country known and no "+" — nothing to anchor the number to; treat as-is when plausible.
  }

  if (!plausible(digits)) return null;
  return `+${digits}`;
}

/**
 * All phone-like strings a page fragment yields, normalised. Used on the tiny bits of HTML the
 * NAP extractor holds (a footer, a JSON-LD telephone field) — the full-page regex lives in nap.ts.
 */
export function normalizeAll(raws: string[], country = ""): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    const norm = normalizeToE164(raw, country);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/** Two E.164 values agree when their digits are identical — formatting is not a diff. */
export function phonesMatch(a: string, b: string): boolean {
  const da = e164Digits(a);
  const db = e164Digits(b);
  return !!da && !!db && da === db;
}
