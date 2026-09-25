// Google Business Profile client (N4, brief §6). Server-only: OAuth tokens live in User.gbpToken
// and never reach the browser.
//
// The quota trap (CONTRACT §0.4) is handled HERE, once, for every caller: a project that has not
// been approved returns 403/429 with a quota message, and that becomes the state
// `gbp_access_required` — surfaced by the routes and the scheduler as data, never as a 500.
//
// Every HTTP call goes through loggedFetch (provider journal: provider "gbp", cost 0 — the API is
// free once approved; the row still proves WHAT was called and when, which is the journal's job).

import { prisma } from "@/lib/prisma";
import { loggedFetch } from "@/lib/providerLog/log";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";
import { getAlertSettings } from "@/lib/alertScheduler";
import {
  GBP_ACCESS_FORM_URL, GBP_ENDPOINTS, buildLocalPostBody, classifyGbpResponse, gbpErrorText,
  locationReadMask, parseAccounts, parseCreatedPostName, parseLocations, parseReviews,
  v4LocationName,
} from "./gbpParse";
import { getProfile, markReviewsNotified, unnotifiedReviews, upsertReviews } from "./store";
import type { GbpAccountRow, GbpCallError, GbpLocationRow, GbpReviewRow } from "./types";

export { GBP_ACCESS_FORM_URL } from "./gbpParse";

// ─── tokens ────────────────────────────────────────────────────────────────────

// ─── redirect URI (the connect/callback pair and the status card share it) ─────

/**
 * The instance's own origin as the reverse proxy saw it. `req.url` behind a proxy names the
 * internal address, so the forwarded headers win when present; the fallback is the request's
 * own origin (right for localhost and direct exposure). The URI this builds is what the doc
 * tells the operator to register in Google Cloud (docs/LOCAL-SEO.md).
 */
export function reqOrigin(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") || host?.startsWith("127.") ? "http" : undefined);
  if (host && proto) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

/** The OAuth redirect URI for THIS instance — one spelling everywhere it is used or shown. */
export function gbpRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/local/gbp/callback`;
}

interface GbpToken {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
}

export function gbpConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function readToken(userId: string): Promise<GbpToken | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { gbpToken: true } }).catch(() => null);
  if (!user?.gbpToken) return null;
  try {
    const parsed = JSON.parse(user.gbpToken) as GbpToken;
    return parsed.refresh_token || parsed.access_token ? parsed : null;
  } catch {
    return null;
  }
}

async function writeToken(userId: string, token: GbpToken): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { gbpToken: JSON.stringify(token) } });
}

/** OAuth authorize URL for the connect route (scope is business.manage only — brief §6). */
export function gbpAuthorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/business.manage",
    access_type: "offline",
    prompt: "consent", // force a refresh_token out of Google on every connect
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange the OAuth code for tokens and persist them on the user. False = exchange refused. */
export async function gbpExchangeCode(userId: string, code: string, redirectUri: string): Promise<boolean> {
  if (!gbpConfigured()) return false;
  const { res, call } = await loggedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  }, { provider: "gbp" });
  const text = await res.text();
  call.finish({ status: res.status, responseBody: text.slice(0, 4_096) });
  if (!res.ok) return false;
  try {
    const grant = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!grant.access_token) return false;
    await writeToken(userId, {
      refresh_token: grant.refresh_token,
      access_token: grant.access_token,
      expires_at: Date.now() + (grant.expires_in ?? 3600) * 1000,
      scope: grant.scope,
    });
    return true;
  } catch {
    return false;
  }
}

export async function gbpConnected(userId: string): Promise<boolean> {
  return !!(await readToken(userId));
}

export async function gbpDisconnect(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { gbpToken: null } }).catch(() => {});
}

// ─── the state machine the GBP tab renders ────────────────────────────────────

export interface GbpStatus {
  /** gbp_not_configured | gbp_no_token | gbp_auth_failed | gbp_access_required | gbp_error | ok */
  state: "gbp_not_configured" | "gbp_no_token" | "gbp_auth_failed" | "gbp_access_required" | "gbp_error" | "ok";
  /** true when a Google account is linked (token present), regardless of quota. */
  connected: boolean;
  /** The pre-approval explanation card needs the apply link — always present for the client. */
  applyUrl: string;
  accounts?: GbpAccountRow[];
  message?: string;
}

/**
 * Everything the GBP tab needs in one call. Local reads only, UNLESS a token exists — then one
 * accounts.list call runs, because quota-0 (CONTRACT §0.4) is only visible by trying. That call
 * is free and lands in the journal; its classified failure is the state, never a throw.
 */
export async function gbpStatus(userId: string): Promise<GbpStatus> {
  const applyUrl = GBP_ACCESS_FORM_URL;
  if (!gbpConfigured()) return { state: "gbp_not_configured", connected: false, applyUrl };
  if (!(await readToken(userId))) return { state: "gbp_no_token", connected: false, applyUrl };

  const res = await listAccounts(userId);
  if (!res.ok) {
    return {
      state: res.error === "gbp_auth_failed" ? "gbp_auth_failed" : res.error === "gbp_access_required" ? "gbp_access_required" : "gbp_error" as GbpStatus["state"],
      connected: true,
      applyUrl,
      message: res.message,
    };
  }
  return { state: "ok", connected: true, applyUrl, accounts: res.data ?? [] };
}

// ─── authenticated calls ───────────────────────────────────────────────────────

export interface GbpCallResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: GbpCallError;
  message?: string;
}

/** A valid access token, refreshed when stale. The token value itself never leaves this module. */
async function getAccessToken(userId: string): Promise<string | "gbp_no_token" | "gbp_auth_failed"> {
  if (!gbpConfigured()) return "gbp_no_token";
  const stored = await readToken(userId);
  if (!stored) return "gbp_no_token";

  const stillLive = stored.access_token && stored.expires_at && stored.expires_at > Date.now() + 60_000;
  if (stillLive) return stored.access_token as string;
  if (!stored.refresh_token) return "gbp_auth_failed"; // expired access token without a refresh — reconnect

  const { res, call } = await loggedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  }, { provider: "gbp" });
  const text = await res.text();
  call.finish({ status: res.status, responseBody: text.slice(0, 4_096) });
  if (!res.ok) return "gbp_auth_failed";
  try {
    const grant = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!grant.access_token) return "gbp_auth_failed";
    await writeToken(userId, {
      ...stored,
      access_token: grant.access_token,
      expires_at: Date.now() + (grant.expires_in ?? 3600) * 1000,
    });
    return grant.access_token;
  } catch {
    return "gbp_auth_failed";
  }
}

async function gbpGet<T>(userId: string, url: string): Promise<GbpCallResult<T>> {
  return gbpRequest<T>(userId, "GET", url);
}

async function gbpSend<T>(userId: string, method: "POST" | "PUT", url: string, body: unknown): Promise<GbpCallResult<T>> {
  return gbpRequest<T>(userId, method, url, body);
}

/** One authenticated GBP call: Bearer token (refreshed when stale), journal row, classified error. */
async function gbpRequest<T>(
  userId: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
): Promise<GbpCallResult<T>> {
  const token = await getAccessToken(userId);
  if (token === "gbp_no_token") return { ok: false, status: 0, data: null, error: "gbp_no_token" };
  if (token === "gbp_auth_failed") return { ok: false, status: 0, data: null, error: "gbp_auth_failed" };

  const init: RequestInit = {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const { res, call } = await loggedFetch(url, init, { provider: "gbp" });
  const text = await res.text();
  call.finish({ status: res.status, responseBody: text.slice(0, 8_192) });

  const verdict = classifyGbpResponse(res.status, text);
  if (verdict === "ok") {
    try {
      return { ok: true, status: res.status, data: (text ? JSON.parse(text) : {}) as T };
    } catch {
      return { ok: false, status: res.status, data: null, error: "gbp_error", message: "Invalid JSON from the Business Profile API" };
    }
  }
  return { ok: false, status: res.status, data: null, error: verdict, message: gbpErrorText(text) };
}

// ─── accounts & locations (v1: Account Management + Business Information) ──────

export async function listAccounts(userId: string): Promise<GbpCallResult<GbpAccountRow[]>> {
  const res = await gbpGet<{ accounts?: unknown }>(userId, `${GBP_ENDPOINTS.accounts}/accounts`);
  if (!res.ok) return res as GbpCallResult<GbpAccountRow[]>;
  return { ok: true, status: res.status, data: parseAccounts(JSON.stringify(res.data ?? {})) };
}

export async function listLocations(userId: string, account: string): Promise<GbpCallResult<GbpLocationRow[]>> {
  const url = `${GBP_ENDPOINTS.business}/${account}/locations?readMask=${encodeURIComponent(locationReadMask())}`;
  const res = await gbpGet<{ locations?: unknown }>(userId, url);
  if (!res.ok) return res as GbpCallResult<GbpLocationRow[]>;
  return { ok: true, status: res.status, data: parseLocations(JSON.stringify(res.data ?? {})) };
}

// ─── reviews (v4) ──────────────────────────────────────────────────────────────

export async function fetchReviews(userId: string, gbpAccount: string, gbpLocation: string): Promise<GbpCallResult<GbpReviewRow[]>> {
  const parent = v4LocationName(gbpAccount, gbpLocation);
  const res = await gbpGet<{ reviews?: unknown }>(userId, `${GBP_ENDPOINTS.v4}/${parent}/reviews?pageSize=50`);
  if (!res.ok) return res as GbpCallResult<GbpReviewRow[]>;
  return { ok: true, status: res.status, data: parseReviews(JSON.stringify(res.data ?? {})) };
}

export interface ReviewSyncResult {
  ok: boolean;
  error?: GbpCallError;
  message?: string;
  inserted?: number;
  updated?: number;
  notified?: number;
}

/**
 * Full reviews sync for one site: fetch → upsert → notify about rows that are new since the last
 * sync. The FIRST import (site had no stored reviews) stays silent — a backfill of two years of
 * reviews is not a notification (brief §6).
 */
export async function syncGbpReviews(userId: string, siteDbId: string, opts: { notify?: boolean } = {}): Promise<ReviewSyncResult> {
  const profile = await getProfile(userId, siteDbId);
  if (!profile) return { ok: false, error: "gbp_not_selected" };
  if (!profile.gbpAccount || !profile.gbpLocation) return { ok: false, error: "gbp_not_selected" };

  const hadReviews = await prisma.gbpReview.count({ where: { siteId: siteDbId } }).catch(() => 0);
  const res = await fetchReviews(userId, profile.gbpAccount, profile.gbpLocation);
  if (!res.ok) return { ok: false, error: res.error, message: res.message };

  const rows = res.data ?? [];
  const { inserted, updated } = await upsertReviews(siteDbId, rows);

  let notified = 0;
  if ((opts.notify ?? true) && hadReviews > 0 && inserted > 0) {
    notified = await notifyNewReviews(userId, siteDbId);
  } else if ((opts.notify ?? true) && hadReviews === 0 && inserted > 0) {
    // First import: mark the backlog as seen so the next sync only notifies about true newcomers.
    const fresh = await unnotifiedReviews(siteDbId, 200);
    await markReviewsNotified(siteDbId, fresh.map(r => r.id));
  }
  return { ok: true, inserted, updated, notified };
}

/** Notify about stored-but-unnotified reviews (oldest first, capped), then stamp notifiedAt. */
async function notifyNewReviews(userId: string, siteDbId: string): Promise<number> {
  const pending = await unnotifiedReviews(siteDbId, 8);
  if (!pending.length) return 0;
  const site = await prisma.site.findUnique({ where: { id: siteDbId }, select: { url: true } });
  const siteLabel = site?.url || siteDbId;
  try {
    const alertSettings = await getAlertSettings(userId);
    const L = NOTIFY_L[normalizeLang(alertSettings.lang)];
    for (const r of pending) {
      const text = L.gbpReviewMsg(siteLabel, r.author || "?", r.rating, (r.comment || "").slice(0, 300));
      await notifyUser(userId, text, { event: "local", title: L.gbpReviewTitle(siteLabel, r.rating) });
    }
  } catch (e) {
    console.warn(`[local-cron] review notify for site ${siteDbId} failed:`, e);
  }
  await markReviewsNotified(siteDbId, pending.map(r => r.id));
  return pending.length;
}

/** Reply to a review from the UI: PUT reply, then mirror the reply in the local row. */
export async function replyReview(
  userId: string, gbpAccount: string, gbpLocation: string, reviewId: string, comment: string,
): Promise<GbpCallResult<{ reply: { comment: string } }>> {
  const parent = v4LocationName(gbpAccount, gbpLocation);
  return gbpSend<{ reply: { comment: string } }>(userId, "PUT", `${GBP_ENDPOINTS.v4}/${parent}/reviews/${encodeURIComponent(reviewId)}/reply`, { comment });
}

// ─── local posts (v4) ──────────────────────────────────────────────────────────

/** Publish one due post to the location. Returns ok + the API's resource name, or the
 *  classified GBP error (gbp_access_required included — the pre-approval state). */
export async function publishPost(
  userId: string,
  post: { summary: string; ctaType: string | null; ctaUrl: string | null; mediaUrl: string | null },
  gbpAccount: string,
  gbpLocation: string,
): Promise<{ ok: boolean; gbpName?: string; error?: GbpCallError; message?: string }> {
  const parent = v4LocationName(gbpAccount, gbpLocation);
  const body = buildLocalPostBody({ summary: post.summary, ctaType: post.ctaType, ctaUrl: post.ctaUrl, mediaUrl: post.mediaUrl });
  const res = await gbpSend<{ name?: string }>(userId, "POST", `${GBP_ENDPOINTS.v4}/${parent}/localPosts`, body);
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  const gbpName = parseCreatedPostName(JSON.stringify(res.data ?? {}));
  if (!gbpName) return { ok: false, error: "gbp_error", message: "The API accepted the post but returned no resource name" };
  return { ok: true, gbpName };
}

// ─── photos (v1 media) ─────────────────────────────────────────────────────────

export async function listPhotos(userId: string, gbpAccount: string, gbpLocation: string): Promise<GbpCallResult<{ name: string; sourceUrl?: string }[]>> {
  const locationId = gbpLocation.split("/").pop() ?? gbpLocation;
  const res = await gbpGet<{ mediaItems?: { name: string; sourceUrl?: string }[] }>(userId, `${GBP_ENDPOINTS.business}/locations/${locationId}/media?pageSize=50`);
  if (!res.ok) return res as GbpCallResult<{ name: string; sourceUrl?: string }[]>;
  return { ok: true, status: res.status, data: res.data?.mediaItems ?? [] };
}

/** Add a photo by its public https URL (brief §6: upload happens from a public URL, no file pipe). */
export async function addPhoto(userId: string, gbpAccount: string, gbpLocation: string, sourceUrl: string): Promise<GbpCallResult<{ name: string }>> {
  const locationId = gbpLocation.split("/").pop() ?? gbpLocation;
  return gbpSend<{ name: string }>(userId, "POST", `${GBP_ENDPOINTS.business}/locations/${locationId}/media`, {
    mediaFormat: "PHOTO",
    sourceUrl,
  });
}
