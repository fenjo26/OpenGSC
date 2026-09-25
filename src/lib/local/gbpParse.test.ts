import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalPostBody, classifyGbpResponse, GBP_ACCESS_FORM_URL, parseAccounts, parseCreatedPostName,
  parseLocations, parseReviews, v4LocationName,
} from "./gbpParse";

// ─── fixtures: shapes as the Business Profile APIs return them today ───────────

const REVIEWS_BODY = JSON.stringify({
  reviews: [
    {
      name: "accounts/1084945895/locations/8380826489978468174/reviews/AIe9BEx0kN62-PnG8-2Um2NMx1a",
      reviewId: "AIe9BEx0kN62-PnG8-2Um2NMx1a",
      reviewer: { displayName: "Maria P." },
      starRating: "FIVE",
      comment: "Best massage in Thessaloniki, will come back!",
      createTime: "2026-11-02T10:15:03Z",
      reviewReply: { comment: "Thank you Maria!", updateTime: "2026-11-03T08:00:00Z" },
    },
    {
      reviewId: "AIe9BEx-no-rating",
      reviewer: { displayName: "Nikos" },
      comment: "",
      createTime: "2026-11-01T18:44:11Z",
    },
    { reviewer: { displayName: "no id — dropped" } },
  ],
  totalReviewCount: 2,
  averageRating: 5,
});

const POSTS_BODY = JSON.stringify({ name: "accounts/1084945895/locations/8380826489978468174/localPosts/AbFpOyKv90vZs8CF3p1SBS" });

const QUOTA_403_BODY = JSON.stringify({
  error: {
    code: 403,
    message: "Business Profile API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/mybusinessbusinessinformation.googleapis.com/overview then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.",
    status: "PERMISSION_DENIED",
  },
});

const RATE_429_BODY = JSON.stringify({
  error: { code: 429, message: "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute' of service 'mybusiness.googleapis.com'.", status: "RESOURCE_EXHAUSTED" },
});

const AUTH_401_BODY = JSON.stringify({ error: { code: 401, message: "Request had invalid credentials.", status: "UNAUTHENTICATED" } });

// ─── the CONTRACT §0.4 trap: quota 0 before approval ──────────────────────────

test("a 403 quota/permission answer classifies as gbp_access_required, not an error", () => {
  assert.equal(classifyGbpResponse(403, QUOTA_403_BODY), "gbp_access_required");
});

test("a 429 RESOURCE_EXHAUSTED answer also classifies as gbp_access_required", () => {
  assert.equal(classifyGbpResponse(429, RATE_429_BODY), "gbp_access_required");
});

test("a 400 'Access Not Configured' body reads the same as 403/429", () => {
  assert.equal(classifyGbpResponse(400, QUOTA_403_BODY), "gbp_access_required");
});

test("401 is auth (reconnect), 404 is not-found, 2xx is ok", () => {
  assert.equal(classifyGbpResponse(401, AUTH_401_BODY), "gbp_auth_failed");
  assert.equal(classifyGbpResponse(404, "{}"), "gbp_not_found");
  assert.equal(classifyGbpResponse(200, "{}"), "ok");
  assert.equal(classifyGbpResponse(500, "oops"), "gbp_error");
});

test("the apply link is the Google Business Profile API access form", () => {
  assert.equal(GBP_ACCESS_FORM_URL, "https://support.google.com/business/contact/business_profile_api");
});

// ─── reviews ───────────────────────────────────────────────────────────────────

test("parseReviews maps the v4 review list, keeps rating 0 when starRating is absent", () => {
  const rows = parseReviews(REVIEWS_BODY);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    reviewId: "AIe9BEx0kN62-PnG8-2Um2NMx1a",
    author: "Maria P.",
    rating: 5,
    comment: "Best massage in Thessaloniki, will come back!",
    createTime: "2026-11-02T10:15:03Z",
    replyText: "Thank you Maria!",
  });
  assert.equal(rows[1].rating, 0);
  assert.equal(rows[1].replyText, null);
});

test("parseReviews survives malformed JSON and an empty list", () => {
  assert.deepEqual(parseReviews("not json"), []);
  assert.deepEqual(parseReviews("{}"), []);
});

// ─── posts ─────────────────────────────────────────────────────────────────────

test("buildLocalPostBody builds a v4 localPost with CTA and photo media", () => {
  assert.deepEqual(buildLocalPostBody({ summary: "November offer", ctaType: "BOOK", ctaUrl: "https://massagethess.gr/offer", mediaUrl: "https://massagethess.gr/offer.jpg" }), {
    topicType: "STANDARD",
    languageCode: "en",
    summary: "November offer",
    callToAction: { actionType: "BOOK", url: "https://massagethess.gr/offer" },
    media: [{ mediaFormat: "PHOTO", sourceUrl: "https://massagethess.gr/offer.jpg" }],
  });
});

test("CALL carries no url, an unknown CTA is dropped, non-https media is dropped", () => {
  assert.deepEqual(buildLocalPostBody({ summary: "Call us", ctaType: "CALL", ctaUrl: "https://x.gr", mediaUrl: null }).callToAction, { actionType: "CALL" });
  const noCta = buildLocalPostBody({ summary: "s", ctaType: "RESERVE", ctaUrl: "https://x.gr", mediaUrl: null });
  assert.ok(!("callToAction" in noCta));
  const httpMedia = buildLocalPostBody({ summary: "s", ctaType: null, ctaUrl: null, mediaUrl: "http://x.gr/i.jpg" });
  assert.ok(!("media" in httpMedia));
});

test("parseCreatedPostName pulls the resource name out of the create response", () => {
  assert.equal(parseCreatedPostName(POSTS_BODY), "accounts/1084945895/locations/8380826489978468174/localPosts/AbFpOyKv90vZs8CF3p1SBS");
  assert.equal(parseCreatedPostName("{}"), null);
  assert.equal(parseCreatedPostName("garbage"), null);
});

// ─── accounts / locations ──────────────────────────────────────────────────────

test("parseAccounts keeps only well-formed account resources", () => {
  const rows = parseAccounts(JSON.stringify({
    accounts: [
      { name: "accounts/1084945895", accountName: "Massage Thess" },
      { name: "accounts/abc", accountName: "bad id" },
      { accountName: "no name" },
    ],
  }));
  assert.deepEqual(rows, [{ name: "accounts/1084945895", accountName: "Massage Thess" }]);
});

test("parseLocations flattens the storefront address into one line", () => {
  const rows = parseLocations(JSON.stringify({
    locations: [
      {
        name: "locations/8380826489978468174",
        title: "Massage Thessaloniki",
        storefrontAddress: { addressLines: ["Egnatia 12"], locality: "Thessaloniki", postalCode: "546 22" },
      },
      { name: "locations/good", title: "ok" },
      { title: "no name" },
    ],
  }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Massage Thessaloniki");
  assert.ok(rows[0].address.includes("Egnatia 12"));
  assert.ok(rows[0].address.includes("546 22"));
  assert.equal(rows[1].address, "");
});

test("v4LocationName composes the v4 path from v1 account/location names", () => {
  assert.equal(v4LocationName("accounts/1084945895", "locations/8380826489978468174"), "accounts/1084945895/locations/8380826489978468174");
});
