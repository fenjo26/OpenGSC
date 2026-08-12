import "server-only";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import {
  assignableRoles, canManageMember, isTeamRole, normalizeEmail, passwordProblem,
  type TeamRole, type WorkspaceRole,
} from "./roles";
import { workspaceOwner, type WorkspaceContext } from "./workspace";

// Same dynamic access as `workspace.ts`: an instance mid-update may not have the table yet, and a
// hard import would take down every route instead of this one.
const memberships = () => (prisma as any).membership;

const BCRYPT_ROUNDS = 12;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export class TeamError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "TeamError";
  }
}

/**
 * A password a human can read over a call and type once. Ambiguous characters are left out because
 * the first thing that happens to this string is being dictated or pasted into a chat.
 */
export function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(18);
  const body = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
  return `${body.slice(0, 6)}-${body.slice(6, 12)}-${body.slice(12, 18)}`;
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function memberDto(row: any, ownerId: string) {
  return {
    id: row.id,
    email: row.email,
    name: row.member?.name ?? null,
    role: row.role as TeamRole,
    status: row.status,
    isOwner: false,
    invitePending: row.status === "invited",
    inviteExpiresAt: row.inviteExpiresAt,
    invitedAt: row.invitedAt,
    acceptedAt: row.acceptedAt,
    lastSeenAt: row.lastSeenAt,
    canSignIn: !!row.member?.passwordHash,
    ownerId,
  };
}

export async function listWorkspace(ws: WorkspaceContext) {
  const owner = await prisma.user.findUnique({
    where: { id: ws.ownerId },
    select: { id: true, email: true, name: true, image: true, workspaceName: true },
  });
  let rows: any[] = [];
  try {
    rows = await memberships().findMany({
      where: { ownerId: ws.ownerId },
      include: { member: { select: { name: true, passwordHash: true } } },
      orderBy: [{ role: "asc" }, { invitedAt: "asc" }],
    });
  } catch {
    return { notMigrated: true, owner: null, members: [] as any[] };
  }
  return {
    notMigrated: false,
    workspaceName: owner?.workspaceName || (owner?.name ? `${owner.name.split(" ")[0]}'s Team` : "Team"),
    owner: owner ? { id: owner.id, email: owner.email, name: owner.name, image: owner.image, role: "owner" as const } : null,
    members: rows.map(row => memberDto(row, ws.ownerId)),
  };
}

async function assertManageable(ws: WorkspaceContext, membershipId: string, nextRole?: WorkspaceRole) {
  const row = await memberships().findFirst({ where: { id: membershipId, ownerId: ws.ownerId } });
  if (!row) throw new TeamError("member_not_found", 404);
  if (!canManageMember(ws.role, row.role as TeamRole, nextRole)) throw new TeamError("forbidden", 403);
  return row;
}

export interface CreateMemberInput {
  email: unknown;
  name?: unknown;
  role?: unknown;
  /** Omit to have one generated; pass `null` to send an invite link instead. */
  password?: unknown;
  mode?: "password" | "invite";
}

/**
 * Add a person to the workspace.
 *
 * The default path is the one an agency actually uses: the admin sets a password and hands it over.
 * The account is flagged `mustChangePassword`, so the admin's copy stops working as a credential the
 * moment the member signs in. Without that, "who approved this" has no defensible answer, because
 * two people could always have been the one typing.
 */
export async function createMember(ws: WorkspaceContext, input: CreateMemberInput) {
  const email = normalizeEmail(input.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new TeamError("invalid_email");

  const role = (isTeamRole(input.role) ? input.role : "viewer") as TeamRole;
  if (!assignableRoles(ws.role).includes(role)) throw new TeamError("forbidden", 403);

  const owner = await workspaceOwner();
  if (owner?.email && normalizeEmail(owner.email) === email) throw new TeamError("email_is_owner");

  const existingMembership = await memberships().findFirst({ where: { ownerId: ws.ownerId, email } });
  if (existingMembership) throw new TeamError("member_exists", 409);

  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
  // An email already attached to a Google login in this instance is not a member candidate: that
  // account has its own identity and its own Search Console connection.
  if (existingUser && !existingUser.passwordHash) throw new TeamError("email_in_use", 409);

  const mode = input.mode === "invite" ? "invite" : "password";
  let password: string | null = null;
  let inviteToken: string | null = null;
  let userId: string | null = existingUser?.id ?? null;

  if (mode === "password") {
    password = typeof input.password === "string" && input.password ? input.password : generatePassword();
    const problem = passwordProblem(password, email);
    if (problem) throw new TeamError(problem);
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const name = String(input.name ?? "").trim().slice(0, 120) || email.split("@")[0];
    const user = existingUser
      ? await prisma.user.update({ where: { id: existingUser.id }, data: { passwordHash, mustChangePassword: true, passwordUpdatedAt: new Date() }, select: { id: true } })
      : await prisma.user.create({ data: { email, name, passwordHash, mustChangePassword: true, passwordUpdatedAt: new Date() }, select: { id: true } });
    userId = user.id;
  } else {
    inviteToken = randomBytes(32).toString("base64url");
  }

  const membership = await memberships().create({
    data: {
      ownerId: ws.ownerId,
      userId,
      email,
      role,
      status: mode === "password" ? "active" : "invited",
      invitedById: ws.actorId,
      acceptedAt: mode === "password" ? new Date() : null,
      inviteHash: inviteToken ? hashInviteToken(inviteToken) : null,
      inviteExpiresAt: inviteToken ? new Date(Date.now() + INVITE_TTL_MS) : null,
    },
    include: { member: { select: { name: true, passwordHash: true } } },
  });

  // The password and the token are returned exactly once, at creation. Nothing stores them in a
  // readable form, so a lost one is reset rather than looked up.
  return { member: memberDto(membership, ws.ownerId), password, inviteToken };
}

export async function updateMember(ws: WorkspaceContext, membershipId: string, patch: { role?: unknown; status?: unknown }) {
  const nextRole = patch.role === undefined ? undefined : (isTeamRole(patch.role) ? patch.role : null);
  if (nextRole === null) throw new TeamError("invalid_role");
  const row = await assertManageable(ws, membershipId, nextRole ?? undefined);

  const data: Record<string, unknown> = {};
  if (nextRole) data.role = nextRole;
  if (patch.status !== undefined) {
    const status = String(patch.status);
    if (!["active", "suspended"].includes(status)) throw new TeamError("invalid_status");
    // Reactivating someone who never accepted an invite would grant access to an account that does
    // not exist yet, so the invited state is preserved instead.
    data.status = status === "active" && !row.userId ? "invited" : status;
  }
  if (!Object.keys(data).length) throw new TeamError("nothing_to_update");

  const updated = await memberships().update({
    where: { id: membershipId },
    data,
    include: { member: { select: { name: true, passwordHash: true } } },
  });
  return memberDto(updated, ws.ownerId);
}

export async function removeMember(ws: WorkspaceContext, membershipId: string) {
  const row = await assertManageable(ws, membershipId);
  await memberships().delete({ where: { id: membershipId } });
  // The login is disabled, but the user row stays: content, jobs and audit events reference it, and
  // deleting it would rewrite history to say nobody did that work.
  if (row.userId) {
    await prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash: null, mustChangePassword: false },
    }).catch(() => {});
  }
  return { removed: true };
}

export async function resetMemberPassword(ws: WorkspaceContext, membershipId: string) {
  const row = await assertManageable(ws, membershipId);
  if (!row.userId) throw new TeamError("member_not_accepted");
  const password = generatePassword();
  await prisma.user.update({
    where: { id: row.userId },
    data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), mustChangePassword: true, passwordUpdatedAt: new Date() },
  });
  return { password };
}

/** Accepting an invite is the only team endpoint reachable without a session. */
export async function acceptInvite(token: string, name: string, password: string) {
  const row = await memberships().findFirst({
    where: { inviteHash: hashInviteToken(String(token ?? "")), status: "invited" },
  }).catch(() => null);
  if (!row) throw new TeamError("invite_not_found", 404);
  if (row.inviteExpiresAt && new Date(row.inviteExpiresAt).getTime() < Date.now()) throw new TeamError("invite_expired", 410);

  const problem = passwordProblem(password, row.email);
  if (problem) throw new TeamError(problem);

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const displayName = String(name ?? "").trim().slice(0, 120) || row.email.split("@")[0];
  const existing = await prisma.user.findUnique({ where: { email: row.email }, select: { id: true } });
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date(), name: displayName }, select: { id: true } })
    : await prisma.user.create({ data: { email: row.email, name: displayName, passwordHash, passwordUpdatedAt: new Date() }, select: { id: true } });

  await memberships().update({
    where: { id: row.id },
    data: { userId: user.id, status: "active", acceptedAt: new Date(), inviteHash: null, inviteExpiresAt: null },
  });
  return { email: row.email };
}

/** Changing your own password. Also the exit from `mustChangePassword`. */
export async function changeOwnPassword(actorId: string, currentPassword: string, nextPassword: string) {
  const user = await prisma.user.findUnique({
    where: { id: actorId },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) throw new TeamError("member_not_found", 404);
  // An owner who has only ever signed in with Google has no password yet. The session already
  // proves who they are, so demanding a current password would be asking for something that does
  // not exist — and would leave the Google-only bootstrap state impossible to leave from the UI.
  if (user.passwordHash) {
    const valid = await bcrypt.compare(String(currentPassword ?? ""), user.passwordHash).catch(() => false);
    if (!valid) throw new TeamError("current_password_invalid", 403);
  }
  const problem = passwordProblem(String(nextPassword ?? ""), user.email ?? "");
  if (problem) throw new TeamError(problem);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(String(nextPassword), BCRYPT_ROUNDS),
      mustChangePassword: false,
      passwordUpdatedAt: new Date(),
    },
  });
  return { changed: true };
}

/**
 * Hand the workspace to an admin. Owner-only, and deliberately a distinct action rather than a role
 * change: without it the only way to survive the owner leaving the agency is editing the database.
 */
export async function transferOwnership(ws: WorkspaceContext, membershipId: string) {
  if (ws.role !== "owner") throw new TeamError("forbidden", 403);
  const row = await memberships().findFirst({ where: { id: membershipId, ownerId: ws.ownerId } });
  if (!row) throw new TeamError("member_not_found", 404);
  if (row.role !== "admin" || row.status !== "active" || !row.userId) throw new TeamError("transfer_requires_active_admin");

  const previousOwner = await prisma.user.findUnique({ where: { id: ws.ownerId }, select: { email: true, name: true } });
  await prisma.$transaction([
    prisma.user.update({ where: { id: ws.ownerId }, data: { isOwner: false } }),
    prisma.user.update({ where: { id: row.userId }, data: { isOwner: true } }),
    // Every membership row points at the workspace, so they all move to the new owner, and the
    // previous owner becomes an admin of the workspace they used to own.
    memberships().updateMany({ where: { ownerId: ws.ownerId }, data: { ownerId: row.userId } }),
    memberships().update({ where: { id: membershipId }, data: { role: "admin", status: "suspended" } }),
    memberships().create({
      data: {
        ownerId: row.userId, userId: ws.ownerId, email: normalizeEmail(previousOwner?.email),
        role: "admin", status: "active", invitedById: ws.actorId, acceptedAt: new Date(),
      },
    }),
  ]);
  // The new owner's own membership row is redundant — ownership comes from owning the data — and is
  // removed after the swap so the members list does not show them twice.
  await memberships().delete({ where: { id: membershipId } }).catch(() => {});
  return { ownerId: row.userId };
}
