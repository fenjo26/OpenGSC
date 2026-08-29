import "server-only";
import { getServerSession } from "next-auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveCaptureBodies } from "@/lib/providerLog/bodies";
import { enterCallContext, type CallContext } from "@/lib/providerLog/context";
import {
  can, normalizeEmail, statusGrantsAccess, type Capability, type TeamRole, type Workspace,
} from "./roles";

/**
 * Resolving "who is asking, and whose data are they asking about".
 *
 * Every table in this schema is scoped by `userId`, and that meaning does not change here:
 * `userId` is still the owner. A member's request resolves to the owner's id plus a role, so the
 * hundreds of existing queries keep working untouched while gaining an access rule.
 *
 * Membership is read on every request rather than baked into the session. Sessions are JWTs and
 * cannot be revoked, so a cached role would keep a suspended member working until their token
 * expired — up to thirty days. One indexed lookup buys immediate suspension.
 */

// Accessed dynamically for the same reason `jobs/lifecycle.ts` does it: during a rolling update the
// generated client can briefly predate the table, and a hard import would break every route at once
// instead of degrading to "no membership found".
const memberships = () => (prisma as any).membership;

export interface WorkspaceContext extends Workspace {
  actorEmail: string;
  actorName: string | null;
  mustChangePassword: boolean;
  membershipId: string | null;
}

/**
 * The account that owns this instance's data.
 *
 * `isOwner` is the explicit marker, but instances created before the column existed have it unset,
 * so the first user by id — the rule `auth.ts` has always used — is adopted and written back once.
 * Doing this lazily avoids a data migration in an updater that only runs `prisma db push`.
 */
export async function workspaceOwner(): Promise<{ id: string; email: string | null; name: string | null } | null> {
  try {
    const marked = await prisma.user.findFirst({
      where: { isOwner: true },
      select: { id: true, email: true, name: true },
    });
    if (marked) return marked;
  } catch {
    // Column not migrated yet: fall through to the historical rule.
    return prisma.user.findFirst({ orderBy: { id: "asc" }, select: { id: true, email: true, name: true } });
  }
  const first = await prisma.user.findFirst({ orderBy: { id: "asc" }, select: { id: true, email: true, name: true } });
  if (!first) return null;
  await prisma.user.update({ where: { id: first.id }, data: { isOwner: true } }).catch(() => { /* raced with another request */ });
  return first;
}

/**
 * The header `src/proxy.ts` writes the matched path onto.
 *
 * Named in both files rather than imported from the proxy, which would drag next-auth/middleware
 * into every route bundle. workspaceCallContext.test.ts asserts the two spellings agree.
 */
export const ROUTE_HEADER = "x-opengsc-route";

/**
 * What this request is for, as the proxy recorded it — or nothing.
 *
 * The value is never read from the client: the proxy deletes any inbound copy before writing its
 * own, so what arrives here either came from the proxy or is absent. Absent is a normal state —
 * a scheduler, a script and a test all reach this code with no request around them — and it
 * costs a label, not the attribution. `headers()` throws outside a request scope rather than
 * returning empty, hence the catch.
 */
async function routeFeature(): Promise<string | null> {
  try {
    return (await headers()).get(ROUTE_HEADER) || null;
  } catch {
    return null;
  }
}

/**
 * Who is asking, whose data they may touch — and, as a side effect, whose provider calls these
 * are.
 *
 * The context is established *here* rather than in `workspaceUserId()`, one level up, because
 * this is the function every entry point shares. `requireWorkspace()` advertises itself as the
 * two-line guard idiom and seven routes already use it or call this directly; establishing the
 * context above them would have left those routes silently exempt, logging `userId: null` on the
 * day one of them grew an AI call, with nothing anywhere failing. One level down removes the
 * asymmetry instead of documenting it.
 *
 * The order is load-bearing, and is the same mechanism proved a level up. `enterWith` reaches the
 * *caller* only while this function is still running synchronously inside it — and each caller in
 * turn is still synchronous up to its own `await`, so the store propagates all the way out to the
 * route handler that makes the provider call. Enter after the first await instead and the store
 * belongs to this function's own continuation: the handler sees nothing and every row logs a null
 * user. (Checked on Node 24, which the image runs, and on 26.)
 *
 * So the context is entered empty and filled in once the answer is known. Starting it empty is
 * also the safer order: a caller who turns out to have no session leaves a context naming nobody,
 * rather than inheriting whatever the previous execution on this thread left behind — the failure
 * mode where a row confidently names the wrong user.
 *
 * The window between the two is an invariant, not a guarantee: for the length of
 * `resolveWorkspace()` the context exists and says `userId: null`. That is the honest answer —
 * nobody has been identified yet — and it is safe because no provider call can be made before
 * this function returns control. Should something ever log from inside the resolution itself, it
 * will read null rather than someone else's id, which is the direction an error should point.
 * workspaceCallContext.test.ts pins both halves.
 *
 * A fresh object per call is what keeps concurrent requests apart: the store is a reference, and
 * one shared across requests would let the last caller to resolve overwrite everybody.
 */
export async function getWorkspace(): Promise<WorkspaceContext | null> {
  const ctx: CallContext = { userId: null, feature: null, captureBodies: false };
  enterCallContext(ctx);

  const ws = await resolveWorkspace();
  if (ws) {
    ctx.userId = ws.ownerId;
    // Both resolved here, once, while there is still an `await` to spend: the logger is
    // synchronous and cannot read a settings snapshot from inside a provider call. The owner's
    // setting is the one that governs — a member's calls spend the owner's money and land in the
    // owner's log, so it is the owner's decision whether the payloads are kept.
    const [feature, captureBodies] = await Promise.all([routeFeature(), resolveCaptureBodies(ws.ownerId)]);
    ctx.feature = feature;
    ctx.captureBodies = captureBodies;
  }
  return ws;
}

/** The resolution itself, unchanged — split out only so the context can be entered before it. */
async function resolveWorkspace(): Promise<WorkspaceContext | null> {
  const session = await getServerSession(authOptions);
  const actorId = (session?.user as any)?.id as string | undefined;
  if (!actorId) return null;

  const [actor, owner] = await Promise.all([
    prisma.user.findUnique({
      where: { id: actorId },
      select: { id: true, email: true, name: true, isOwner: true, mustChangePassword: true },
    }).catch(() => null),
    workspaceOwner(),
  ]);
  if (!actor || !owner) return null;

  if (actor.id === owner.id) {
    return {
      ownerId: owner.id, actorId: actor.id, role: "owner",
      actorEmail: actor.email ?? "", actorName: actor.name ?? null,
      mustChangePassword: false, membershipId: null,
    };
  }

  let membership: any = null;
  try {
    membership = await memberships().findFirst({
      where: { ownerId: owner.id, OR: [{ userId: actor.id }, { email: normalizeEmail(actor.email) }] },
      select: { id: true, role: true, status: true, userId: true },
    });
  } catch {
    // No Membership table yet — an un-migrated instance has no members by definition.
    return null;
  }
  if (!membership || !statusGrantsAccess(membership.status)) return null;

  // First request after accepting: bind the row to the account that signed in.
  if (!membership.userId) {
    await memberships().update({ where: { id: membership.id }, data: { userId: actor.id, acceptedAt: new Date() } }).catch(() => {});
  }
  memberships().update({ where: { id: membership.id }, data: { lastSeenAt: new Date() } }).catch(() => {});

  return {
    ownerId: owner.id,
    actorId: actor.id,
    role: (membership.role as TeamRole) ?? "viewer",
    actorEmail: actor.email ?? "",
    actorName: actor.name ?? null,
    mustChangePassword: !!actor.mustChangePassword,
    membershipId: membership.id,
  };
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** 403, with the capability named so a UI can explain the refusal instead of guessing. */
export function forbidden(capability: Capability) {
  return NextResponse.json({ error: "forbidden", capability }, { status: 403 });
}

/**
 * The shape most route handlers want: either a workspace that may do `capability`, or the response
 * to return. Keeps the guard to two lines at the top of a handler.
 */
export async function requireWorkspace(capability: Capability = "read"): Promise<
  { ok: true; ws: WorkspaceContext } | { ok: false; response: NextResponse }
> {
  const ws = await getWorkspace();
  if (!ws) return { ok: false, response: unauthorized() };
  if (!can(ws, capability)) return { ok: false, response: forbidden(capability) };
  return { ok: true, ws };
}

/**
 * The owner id for data queries, or null when the caller may not act.
 *
 * This is the drop-in for `const userId = (session?.user as any)?.id` in handlers whose body never
 * needs to know who the actor is — the large majority of them.
 */
export async function workspaceUserId(capability: Capability = "read"): Promise<string | null> {
  // No context work here: getWorkspace() has already established it for every caller, including
  // requireWorkspace() and the routes that call getWorkspace() directly.
  const ws = await getWorkspace();
  if (!ws || !can(ws, capability)) return null;
  return ws.ownerId;
}
