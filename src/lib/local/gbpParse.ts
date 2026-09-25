// GBP wire-format parsing and error classification (N4, brief §6). Pure — fixtures in
// gbpParse.test.ts cover the whole module, which is the only way the quota-0 trap (CONTRACT
// §0.4) gets regression coverage before Google approves the project.
//
// Endpoint split, per the current Business Profile APIs docs:
//   accounts  → mybusinessaccountmanagement.googleapis.com/v1  (Account Management API)
//   locations → mybusinessbusinessinformation.googleapis.com/v1 (Business Information API)
//   media     → mybusinessbusinessinformation.googleapis.com/v1
//   reviews + localPosts → mybusiness.googleapis.com/v4        (legacy v4, still home of both)

import type { GbpAccountRow, GbpLocationRow, GbpReviewRow } from "./types";

export const GBP_SCOPES = ["https://www.googleapis.com/auth/business.manage"];

export const GBP_ENDPOINTS = {
  accounts: "https://mybusinessaccountmanagement.googleapis.com/v1",
  business: "https://mybusinessbusinessinformation.googleapis.com/v1",
  v4: "https://mybusiness.googleapis.com/v4",
} as const;

/** Where to apply for Business Profile API access — quota stays 0 until Google approves. */
export const GBP_ACCESS_FORM_URL = "https://support.google.com/business/contact/business_profile_api";

// ─── error classification ──────────────────────────────────────────────────────

interface GbpErrorBody {
  error?: { code?: number; status?: string; message?: string; errors?: { reason?: string; message?: string }[] };
}

const QUOTA_MARKERS = [
  "quota", "rate limit", "ratelimit", "access not configured", "has not been used in project",
  "is disabled", "permission denied", "permissiondenied", "access not granted", "unverified",
  "please apply", "api access", "not approved", "resource_exhausted", "unregistered",
];

/**
 * Classify one GBP HTTP response. The load-bearing case: a project that has not been approved
 * yet gets 403 PERMISSION_DENIED / 429 RESOURCE_EXHAUSTED with a quota/access message and a
 * quota of 0 — that is `gbp_access_required` (a state with an explanation and an apply link),
 * never a stack trace. Falls back through auth (bad token → reconnect) to a generic error.
 */
export function classifyGbpResponse(status: number, bodyText: string): "ok" | "gbp_access_required" | "gbp_auth_failed" | "gbp_not_found" | "gbp_error" {
  if (status >= 200 && status < 300) return "ok";
  let parsed: GbpErrorBody = {};
  try { parsed = JSON.parse(bodyText) as GbpErrorBody; } catch { /* non-JSON error page */ }
  const message = String(parsed.error?.message ?? bodyText ?? "").toLowerCase();
  const statusText = String(parsed.error?.status ?? "").toLowerCase();
  const reason = String(parsed.error?.errors?.[0]?.reason ?? "").toLowerCase();

  if (status === 404) return "gbp_not_found";
  if (status === 401) return "gbp_auth_failed";

  if (status === 403 || status === 429) {
    // 403/429 with a quota/permission body is the pre-approval state. Some other 403s (invalid
    // grant surfaced as 403 with "Request had invalid authentication credentials") are auth.
    if (message.includes("invalid authentication credentials") || reason === "authError" || statusText === "unauthenticated") {
      return "gbp_auth_failed";
    }
    return "gbp_access_required";
  }

  // 400 with a quota marker (some periods answered "Access Not Configured" as 400) reads the same.
  if (status === 400 && QUOTA_MARKERS.some(m => message.includes(m) || reason.includes(m))) {
    return "gbp_access_required";
  }
  return "gbp_error";
}

/** Human-readable one-liner for a GBP failure body, for the UI/error column. */
export function gbpErrorText(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as GbpErrorBody;
    return String(parsed.error?.message ?? bodyText).slice(0, 300);
  } catch {
    return String(bodyText ?? "").slice(0, 300);
  }
}

// ─── accounts / locations (v1) ─────────────────────────────────────────────────

export function parseAccounts(bodyText: string): GbpAccountRow[] {
  let parsed: { accounts?: { name?: string; accountName?: string }[] } = {};
  try { parsed = JSON.parse(bodyText); } catch { return []; }
  return (parsed.accounts ?? [])
    .filter(a => typeof a.name === "string" && /^accounts\/\d+$/.test(a.name))
    .map(a => ({ name: a.name as string, accountName: String(a.accountName ?? "") }));
}

const LOCATION_READ_MASK = "title,storefrontAddress,phone,websiteUri";

/** readMask for locations.list — exported for the client to reuse verbatim. */
export function locationReadMask(): string {
  return LOCATION_READ_MASK;
}

export function parseLocations(bodyText: string): GbpLocationRow[] {
  let parsed: { locations?: unknown[] } = {};
  try { parsed = JSON.parse(bodyText); } catch { return []; }
  return (parsed.locations ?? []).map(raw => {
    const loc = raw as {
      name?: string; title?: string; storefrontAddress?: {
        addressLines?: string[]; administrativeArea?: string; locality?: string; postalCode?: string;
      };
    };
    if (typeof loc.name !== "string" || !/^locations\/[\w-]+$/.test(loc.name)) return null;
    const a = loc.storefrontAddress;
    const address = a
      ? [...(a.addressLines ?? []), a.locality, a.postalCode].filter(x => typeof x === "string" && x).join(", ")
      : "";
    return { name: loc.name, title: String(loc.title ?? ""), address };
  }).filter((x): x is GbpLocationRow => x != null);
}

// ─── reviews (v4) ──────────────────────────────────────────────────────────────

const STAR_RATINGS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function parseReviews(bodyText: string): GbpReviewRow[] {
  let parsed: { reviews?: unknown[] } = {};
  try { parsed = JSON.parse(bodyText); } catch { return []; }
  return (parsed.reviews ?? []).map(raw => {
    const r = raw as {
      reviewId?: string; reviewer?: { displayName?: string }; starRating?: string;
      comment?: string; createTime?: string; reviewReply?: { comment?: string };
    };
    if (!r.reviewId) return null;
    const rating = STAR_RATINGS[String(r.starRating ?? "").toUpperCase()] ?? 0;
    return {
      reviewId: String(r.reviewId),
      author: String(r.reviewer?.displayName ?? ""),
      rating,
      comment: String(r.comment ?? ""),
      createTime: String(r.createTime ?? ""),
      replyText: typeof r.reviewReply?.comment === "string" ? r.reviewReply.comment : null,
    };
  }).filter((x): x is GbpReviewRow => x != null);
}

// ─── local posts (v4) ──────────────────────────────────────────────────────────

export const POST_CTA_TYPES = ["BOOK", "ORDER", "LEARN_MORE", "CALL", "SIGN_UP"] as const;
export type PostCtaType = typeof POST_CTA_TYPES[number];

export function isPostCtaType(value: unknown): value is PostCtaType {
  return typeof value === "string" && (POST_CTA_TYPES as readonly string[]).includes(value);
}

/** Body for localPosts.create. `CALL` must carry NO url (Google rejects a url on CALL). */
export function buildLocalPostBody(input: { summary: string; ctaType: string | null; ctaUrl: string | null; mediaUrl: string | null; languageCode?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    topicType: "STANDARD",
    languageCode: input.languageCode || "en",
    summary: input.summary,
  };
  if (input.ctaType && isPostCtaType(input.ctaType)) {
    if (input.ctaType === "CALL") {
      body.callToAction = { actionType: "CALL" };
    } else if (input.ctaUrl) {
      body.callToAction = { actionType: input.ctaType, url: input.ctaUrl };
    }
  }
  if (input.mediaUrl && /^https:\/\//i.test(input.mediaUrl)) {
    body.media = [{ mediaFormat: "PHOTO", sourceUrl: input.mediaUrl }];
  }
  return body;
}

/** Resource name of the created post ("accounts/…/locations/…/localPosts/…") or null. */
export function parseCreatedPostName(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { name?: string };
    return typeof parsed.name === "string" && parsed.name.includes("localPosts/") ? parsed.name : null;
  } catch {
    return null;
  }
}

/** v4 wants accounts/{a}/locations/{l}; the profile stores v1's locations/{l}. */
export function v4LocationName(gbpAccount: string, gbpLocation: string): string {
  const locationId = gbpLocation.split("/").pop() ?? gbpLocation;
  return `${gbpAccount}/locations/${locationId}`;
}
