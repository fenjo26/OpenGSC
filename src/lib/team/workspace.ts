import "server-only";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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

export async function getWorkspace(): Promise<WorkspaceContext | null> {
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
  const ws = await getWorkspace();
  if (!ws || !can(ws, capability)) return null;
  return ws.ownerId;
}
