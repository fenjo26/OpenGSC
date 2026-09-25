// Local SEO (N4) — shared pure types. No Prisma, no fetch: everything here is computable
// from a profile row and page HTML, which is what keeps nap.test.ts / schema.test.ts runnable
// without a database (wave-oct README §5: clean logic lives outside @/lib/prisma).

/** The profile as the UI and the pure functions see it — a plain mirror of the LocalProfile row. */
export interface LocalProfileData {
  siteId: string;
  name: string;
  businessType: string;
  street: string;
  locality: string;
  region: string;
  postalCode: string;
  /** ISO-3166 alpha-2, upper-cased; drives phone normalisation and directory suggestions. */
  country: string;
  phone: string;         // E.164 when normalised
  email: string;
  lat: number | null;
  lng: number | null;
  hours: OpeningHoursDay[]; // stored as JSON string in the DB
  priceRange: string;
  sameAs: string[];      // stored newline-separated in the DB
  serviceAreas: string[]; // stored newline-separated in the DB
  gbpAccount: string | null;   // "accounts/123"
  gbpLocation: string | null;  // "locations/456"
}

/** One day of opening hours, as schema.org wants it (day: "Mo".."Su", 24h "00:00-23:59" semantics kept raw). */
export interface OpeningHoursDay {
  day: "Mo" | "Tu" | "We" | "Th" | "Fr" | "Sa" | "Su";
  opens: string; // "09:00"
  closes: string; // "21:00"
}

export type NapField = "name" | "phone" | "address";

/** One field on one page: what the profile expects, what the page showed, and the verdict. */
export interface NapDiff {
  field: NapField;
  expected: string;
  found: string; // "" = not found on the page
  url: string;
  /** match | differs | missing — the three states the UI colours (i18n keys locNap_*). */
  status: "match" | "differs" | "missing";
}

/** What a single page's HTML yielded (extraction only — no comparison). */
export interface NapFound {
  name: string;
  phones: string[];      // normalised E.164, tel: links first
  phoneRaw: string[];    // as printed on the page, parallel to nothing — for display
  address: string;       // one best address string (JSON-LD > microdata > text search)
  jsonLdAddress: boolean;
}

export interface NapPageReport {
  url: string;
  /** unreachable pages are reported separately — a fetch failure is not an NAP problem. */
  error?: string;
  found?: NapFound;
  diffs: NapDiff[];
}

export interface NapCheckReport {
  siteId: string;
  checkedAt: string; // ISO
  pages: NapPageReport[];
  /** pages × fields summary counts for the header line. */
  counts: { match: number; differs: number; missing: number; unreachable: number };
}

export type CitationStatus = "unchecked" | "consistent" | "mismatch" | "missing" | "unreachable";

export interface CitationCheck {
  status: CitationStatus;
  found: { name?: string; phone?: string; address?: string } | null;
  diffs: NapDiff[];
  note?: string; // human hint, e.g. why a directory is "unreachable"
}

/** Directory suggestion — a registration link only, no auto-posting (brief §3). */
export interface DirectorySuggestion {
  name: string;
  url: string;
}

// ─── GBP ───────────────────────────────────────────────────────────────────────

/** Parsed GBP review row (the v4 reviews.list shape after mapping). */
export interface GbpReviewRow {
  reviewId: string;
  author: string;
  rating: number; // 1..5; 0 only while the fixture/API omits starRating
  comment: string;
  createTime: string; // RFC3339
  replyText: string | null;
}

export interface GbpAccountRow {
  name: string;        // "accounts/123"
  accountName: string; // display name
}

export interface GbpLocationRow {
  name: string;        // "locations/456" (v1 resource name)
  title: string;       // location display name
  address: string;     // single-line address, "" when absent
}

/** Verdict of one GBP HTTP call after classification — gbp_access_required is the quota-0 state. */
export type GbpCallError =
  | "gbp_access_required" // 403/429 with a quota/permission body — the pre-approval state (CONTRACT §0.4)
  | "gbp_no_token"        // OAuth not connected
  | "gbp_auth_failed"     // token refresh failed — reconnect needed
  | "gbp_not_configured"  // GOOGLE_CLIENT_ID/SECRET missing on the instance
  | "gbp_not_selected"    // connected but no account/location picked for this site
  | "gbp_not_found"
  | "gbp_error";          // anything else, message carried alongside

export interface GbpPostInput {
  siteId: string;
  summary: string;
  ctaType: string | null;   // BOOK | ORDER | LEARN_MORE | CALL | SIGN_UP
  ctaUrl: string | null;
  mediaUrl: string | null;  // public https image URL
  scheduledAt: string;      // ISO
}

/** Instance settings the /local page needs in one read. */
export interface LocalSiteEntry {
  id: string;
  url: string;
  hasProfile: boolean;
}
