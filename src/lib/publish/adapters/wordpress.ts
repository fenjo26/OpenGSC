// WordPress adapter (P1) — REST API v2 with Basic auth over an Application Password.
//
// Outbound calls go through the security layer's guard: the GET through safeFetch (which
// resolves + pins DNS and refuses private addresses), the POST through assertSafeTarget +
// fetch — the same split /api/seo/googlebot and the notify channels use, because safeFetch
// is deliberately GET/HEAD-only ("provider API POSTs use their fixed, trusted endpoints",
// its own header says). Here the POST target is NOT fixed — it is whatever URL the operator
// typed into the connection form — so the assertSafeTarget hop is what keeps a "blog URL"
// from aiming this server at its own metadata endpoint.
//
// The transport is a seam (deps.get / deps.post) so tests exercise the adapter against a
// fake HTTP layer instead of the real one — mocking global fetch alone cannot intercept
// safeFetch (it speaks node:http directly) and assertSafeTarget would do live DNS in a unit
// test. The defaults are the guarded production paths.

import { safeFetch, assertSafeTarget, SafeFetchError } from "@/lib/security/safeFetch";
import type { BlogAdapter, BlogCreds, PublishPostInput, PublishResult, WordPressCreds } from "../types";

export interface WpResponse {
  status: number;
  ok: boolean;
  /** Parsed body when the reply is JSON; undefined otherwise. */
  json?: unknown;
  text: string;
}

export interface WpHttp {
  get(url: string, headers: Record<string, string>): Promise<WpResponse>;
  post(url: string, headers: Record<string, string>, body: string): Promise<WpResponse>;
}

const TIMEOUT_MS = 30_000;

const defaultHttp: WpHttp = {
  async get(url, headers) {
    const res = await safeFetch(url, { headers, timeoutMs: TIMEOUT_MS, maxBytes: 512 * 1024 });
    const text = await res.text();
    return { status: res.status, ok: res.ok, ...(looksLikeJson(res.headers.get("content-type"), text) ? { json: safeJson(text) } : {}), text };
  },
  async post(url, headers, body) {
    // Same SSRF guard as the GET path; the pinned-address machinery stays inside safeFetch,
    // which cannot POST — so this hop validates the target and lets fetch carry the body.
    try {
      await assertSafeTarget(url);
    } catch (e) {
      throw wpTransportError(e);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, ...(looksLikeJson(res.headers.get("content-type"), text) ? { json: safeJson(text) } : {}), text };
  },
};

function looksLikeJson(contentType: string | null, text: string): boolean {
  if (contentType && /json/i.test(contentType)) return true;
  // Some WP setups answer the REST route without a content-type; sniff instead of guessing.
  const head = text.slice(0, 64).trim();
  return head.startsWith("{") || head.startsWith("[");
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** A guard/network failure reads better as its cause than as "fetch failed". */
function wpTransportError(e: unknown): Error {
  if (e instanceof SafeFetchError) {
    if (e.code === "private_address") return new Error("The site URL resolves to a private/local address — not allowed.");
    if (e.code === "dns_failed") return new Error("The site URL could not be resolved (DNS).");
    if (e.code === "request_timeout") return new Error("The site did not answer in time.");
    return new Error(`Could not reach the site: ${e.message}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Accept what an operator pastes: "example.com", "https://example.com/",
 * "https://example.com/wp-json"… → "https://example.com". A bare host gets https:// because
 * application passwords only ever travel over TLS we initiate; never silently downgrade.
 * Trailing slashes are stripped so endpoint joining never produces "//wp/v2/…".
 */
export function normalizeWpBase(input: string): string {
  let v = String(input || "").trim();
  if (!v) return "";
  // /wp-json is the documented prefix WP advertises; the REST namespace hangs off the root.
  v = v.replace(/\/wp-json.*$/i, "");
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v.replace(/\/+$/, "");
}

function basicAuth(creds: WordPressCreds): Record<string, string> {
  // Application passwords contain spaces ("abcd efgh …"); WP wants them verbatim in the
  // Basic header, and curl-style users often paste them with surrounding spaces.
  const token = Buffer.from(`${creds.username.trim()}:${creds.appPassword.trim()}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}`, accept: "application/json" };
}

/** WP error envelope {code, message} → an honest Error; anything else keeps status + body. */
function wpError(res: WpResponse, what: string): Error {
  const env = res.json as { code?: unknown; message?: unknown } | undefined;
  const code = env && typeof env.code === "string" ? env.code : "";
  const message = env && typeof env.message === "string" ? env.message : "";
  const detail = [code, message].filter(Boolean).join(": ") || `${res.status} ${res.text.slice(0, 200)}`;
  if (res.status === 401 || res.status === 403) {
    return new Error(`${what} failed: authentication rejected (${detail}). Check the username and application password.`);
  }
  if (res.status === 404) {
    return new Error(`${what} failed: REST API not found at this URL (${detail}). Is it a WordPress site with the REST API enabled?`);
  }
  return new Error(`${what} failed: ${detail}`);
}

function parseCreds(creds: BlogCreds): WordPressCreds {
  if (!creds || typeof (creds as WordPressCreds).username !== "string" || typeof (creds as WordPressCreds).appPassword !== "string"
    || !(creds as WordPressCreds).username || !(creds as WordPressCreds).appPassword) {
    throw new Error("Connection is missing its WordPress username / application password — re-enter the credentials.");
  }
  return creds as WordPressCreds;
}

async function wpVerify(creds: BlogCreds, siteIdentifier: string, http: WpHttp): Promise<void> {
  const parsed = parseCreds(creds);
  const base = normalizeWpBase(siteIdentifier);
  if (!base) throw new Error("Site URL is empty.");
  let res: WpResponse;
  try {
    res = await http.get(`${base}/wp-json/wp/v2/users/me?context=edit`, basicAuth(parsed));
  } catch (e) {
    throw wpTransportError(e);
  }
  if (!res.ok) throw wpError(res, "Verification");
  // A 200 whose body is not the user object means the URL answered something that is not the
  // REST API (a static front page, a proxy) — reporting success here would defer the
  // failure to publish time, which is the expensive moment to learn about it.
  const user = res.json as { id?: unknown; name?: unknown } | undefined;
  if (!user || typeof user !== "object" || user.id === undefined) {
    throw new Error(`Verification failed: the URL answered 200 but not with REST API user data — is this a WordPress REST endpoint? (${res.text.slice(0, 120)})`);
  }
}

async function wpPublish(creds: BlogCreds, siteIdentifier: string, post: PublishPostInput, http: WpHttp): Promise<PublishResult> {
  const parsed = parseCreds(creds);
  const base = normalizeWpBase(siteIdentifier);
  if (!base) throw new Error("Site URL is empty.");
  let res: WpResponse;
  try {
    res = await http.post(
      `${base}/wp-json/wp/v2/posts`,
      basicAuth(parsed),
      JSON.stringify({ title: post.title, content: post.html, status: "publish" }),
    );
  } catch (e) {
    throw wpTransportError(e);
  }
  if (!res.ok) throw wpError(res, "Publishing");
  const created = res.json as { id?: unknown; link?: unknown } | undefined;
  const remoteId = created && (typeof created.id === "number" || typeof created.id === "string") ? String(created.id) : "";
  const remoteUrl = created && typeof created.link === "string" ? created.link : "";
  if (!remoteId || !remoteUrl) {
    // The loop closes on remoteUrl; a post we cannot link back to is a post we cannot track.
    throw new Error(`Publishing failed: WordPress answered 200 without a post id/link (${res.text.slice(0, 200)})`);
  }
  return { remoteId, remoteUrl };
}

/** The adapter the registry hands out. Tests build their own with `wordpressAdapter(fakeHttp)`. */
export function wordpressAdapter(http: WpHttp = defaultHttp): BlogAdapter {
  return {
    platform: "wordpress",
    verify: (creds, siteIdentifier) => wpVerify(creds, siteIdentifier, http),
    publish: (creds, siteIdentifier, post) => wpPublish(creds, siteIdentifier, post, http),
  };
}
