// N11 — the server half of /api/ext/** auth: Bearer User.extToken → user + role + CORS headers.
//
// The pipeline every /api/ext route runs (except /api/ext/token, which is session-guarded):
//   1. Bearer token from the Authorization header — header only, no query-parameter fallback
//      (unlike /api/mcp, whose Claude Desktop workaround is documented there): a token in a URL
//      lands in nginx logs, and an extension can always send headers.
//   2. DB lookup on the unique column, then a constant-time compare (src/lib/ext/token.ts).
//   3. workspaceUserId logic, copied from /api/mcp: the token belongs to a person, the person
//      has a role, and the extension acts with that role's ceiling — a viewer's extension
//      cannot queue inspections just because it holds a token.
//   4. CORS decision by extension id (src/lib/ext/origin.ts): no match → 403.
//   5. Rate limit, 60/min per token (src/lib/ext/rateLimit.ts) → 429.
//
// Everything decision-shaped is pure and unit-tested in its own module; this file is the glue
// that needs a database and a Request.

import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { rawQuery } from "@/lib/db/raw";
import { workspaceOwner } from "@/lib/team/owner";
import { can, statusGrantsAccess, type Capability, type WorkspaceRole } from "@/lib/team/roles";
import { checkExtToken, EXT_TOKEN_PREFIX, isExtTokenFormat, tokenKey } from "./token";
import { corsDecision, corsHeaders } from "./origin";
import { EXT_RATE_LIMIT_PER_MIN, SlidingWindowRateLimiter } from "./rateLimit";

export { EXT_TOKEN_PREFIX, isExtTokenFormat };

/** A new extension token — same shape as the MCP token, different prefix so the two are never
 *  confused in a log or a support conversation. */
export function newExtToken(): string {
  return EXT_TOKEN_PREFIX + randomBytes(24).toString("hex");
}

/** "Table/column not migrated yet" for the ext surface: User.extToken/extAllowedIds columns or
 *  any table a route touches may be missing on an instance that pulled the code but hasn't run
 *  `prisma db push`. Same convention as drops/store.ts schemaMissing(). */
export function extTablesMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /(User|Site|DailyMetric|SitemapUrl|PageInspection|SiteAudit|SiteAuditPage|TrackedKeyword|OutreachProspect|OutreachStageEvent|Membership).*(?:does not exist|no such table|no such column)/i.test(String(value?.message ?? ""))
  );
}

interface ExtUserRow {
  id: string;
  extToken: string | null;
  extAllowedIds: string | null;
}

async function userByToken(token: string): Promise<ExtUserRow | null | "not_migrated"> {
  try {
    const rows: ExtUserRow[] = await rawQuery(
      `SELECT id, extToken, extAllowedIds FROM "User" WHERE extToken = ? LIMIT 1`, token.trim(),
    );
    return rows?.[0] ?? null;
  } catch {
    return "not_migrated"; // extToken column missing — prisma db push not run yet
  }
}

/** The same resolution /api/mcp performs for mcpToken: token → person → owner + role. */
async function tokenWorkspace(actorId: string): Promise<{ ownerId: string; role: WorkspaceRole } | null> {
  const owner = await workspaceOwner();
  if (!owner) return null;
  if (owner.id === actorId) return { ownerId: owner.id, role: "owner" };
  try {
    const rows: { role?: unknown; status?: unknown }[] = await rawQuery(
      `SELECT role, status FROM "Membership" WHERE ownerId = ? AND userId = ? LIMIT 1`,
      owner.id, actorId,
    );
    const row = rows?.[0];
    if (!row || !statusGrantsAccess(String(row.status))) return null;
    return { ownerId: owner.id, role: String(row.role) as WorkspaceRole };
  } catch {
    return null; // no Membership table yet: only the owner can hold a working token
  }
}

const limiter = new SlidingWindowRateLimiter(EXT_RATE_LIMIT_PER_MIN, 60_000);

export interface ExtAuthOk {
  /** The workspace owner whose data the extension reads (a member's extension reads the
   *  owner's data — there is no other data on the instance). */
  userId: string;
  role: WorkspaceRole;
  /** CORS headers to copy onto this request's response. */
  cors: Record<string, string>;
}

export type ExtAuthResult =
  | { ok: true; auth: ExtAuthOk }
  | { ok: false; response: NextResponse };

/**
 * The complete guard for one /api/ext request. Returns a ready-made error response on failure
 * (with CORS headers attached where a cross-origin client needs to read the error), so a route
 * is three lines: `const a = await extAuth(req, "read"); if (!a.ok) return a.response;`.
 *
 * Order matters and follows the brief: no token → 401; token but origin not on the allowlist →
 * 403; both fine but over 60/min → 429. The capability check happens after auth so the 401/403
 * answers don't leak which routes exist to an unauthenticated caller.
 */
export async function extAuth(req: Request, capability: Capability): Promise<ExtAuthResult> {
  const origin = req.headers.get("origin");

  const bearer = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  if (!bearer) {
    return { ok: false, response: NextResponse.json({ error: "missing_token" }, { status: 401 }) };
  }
  if (!isExtTokenFormat(bearer)) {
    return { ok: false, response: NextResponse.json({ error: "invalid_token" }, { status: 401 }) };
  }

  const row = await userByToken(bearer);
  if (row === "not_migrated") {
    return { ok: false, response: NextResponse.json({ error: "not_migrated" }, { status: 401 }) };
  }
  const check = checkExtToken(bearer, row?.extToken ?? null);
  if (!check.ok || !row) {
    // missing / wrong / revoked all answer the same 401: which one it was is nobody's business.
    return { ok: false, response: NextResponse.json({ error: "invalid_token" }, { status: 401 }) };
  }

  const cors = corsDecision(origin, row.extAllowedIds);
  if (!cors.allow) {
    return { ok: false, response: NextResponse.json({ error: "origin_not_allowed" }, { status: 403 }) };
  }

  const now = Date.now();
  limiter.prune(now);
  const verdict = limiter.hit(tokenKey(bearer), now);
  if (!verdict.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "rate_limited", retryAfterMs: verdict.retryAfterMs },
        { status: 429, headers: { ...corsHeaders(String(origin)), "Retry-After": String(Math.ceil(verdict.retryAfterMs / 1000)) } },
      ),
    };
  }

  const workspace = await tokenWorkspace(row.id);
  if (!workspace || !can({ role: workspace.role }, capability)) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }

  return { ok: true, auth: { userId: workspace.ownerId, role: workspace.role, cors: corsHeaders(String(origin)) } };
}

/**
 * The OPTIONS preflight answer. A preflight carries no Authorization header by definition, so
 * the only check possible is that the origin is syntactically an extension's: pass it, and the
 * actual request still runs the full token + allowlist + rate-limit guard. Passing preflight
 * grants nothing — it just keeps the console readable while the real request 401/403/429s.
 */
export function extPreflight(req: Request): NextResponse {
  const origin = req.headers.get("origin");
  const cors = corsDecision(origin, null); // no allowlist yet — id syntax only
  if (cors.reason === "no_origin" || cors.reason === "not_extension") {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(String(origin)),
  });
}
