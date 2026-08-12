/**
 * Who may do what inside one workspace.
 *
 * Pure by design: no Prisma, no session, no "server-only" import, so the whole permission table is
 * unit-testable and can also be imported by client components to hide controls. Hiding a control is
 * a courtesy — every capability is checked again on the server, because a hidden button is not a
 * permission system.
 *
 * The table is built around two boundaries that are easy to state and hard to argue with:
 *
 *   1. Anything that spends the owner's money needs `admin`. The app's contract is that a price is
 *      shown before a paid call; a viewer with a working Generate button breaks that contract on
 *      someone else's credit card.
 *   2. Anything that can lock the owner out or expose credentials is owner-only: API keys, Google
 *      connections, MCP tokens, the instance update button and destructive deletes.
 */

export const TEAM_ROLES = ["viewer", "editor", "admin"] as const;
export type TeamRole = typeof TEAM_ROLES[number];
/** The owner is not a membership row — it is the account that owns the data. */
export type WorkspaceRole = TeamRole | "owner";

export const MEMBER_STATUSES = ["active", "invited", "suspended"] as const;
export type MemberStatus = typeof MEMBER_STATUSES[number];

export type Capability =
  | "read"            // every dashboard, report, export and share link
  | "act"             // free actions: crawl, sync, deterministic analysis
  | "write"           // editorial content, outreach, tags, annotations
  | "spend"           // anything that bills the owner: AI, SERP, indexer submits, paid research
  | "publish"         // create a GitHub branch and pull request
  | "manageMembers"   // add, change role of, suspend and remove members
  | "manageAdmins"    // create or change an admin, and transfer ownership
  | "manageSecrets"   // API keys, Google connections, MCP tokens
  | "manageInstance"; // update button, destructive deletes

const MATRIX: Record<WorkspaceRole, readonly Capability[]> = {
  viewer: ["read"],
  editor: ["read", "act", "write"],
  admin: ["read", "act", "write", "spend", "publish", "manageMembers"],
  owner: [
    "read", "act", "write", "spend", "publish",
    "manageMembers", "manageAdmins", "manageSecrets", "manageInstance",
  ],
};

export interface Workspace {
  /** The user id that owns every row — what `userId` has always meant in this codebase. */
  ownerId: string;
  /** Who is actually making the request. Equal to ownerId when the owner is signed in. */
  actorId: string;
  role: WorkspaceRole;
}

export function isTeamRole(value: unknown): value is TeamRole {
  return TEAM_ROLES.includes(String(value) as TeamRole);
}

export function can(workspace: Pick<Workspace, "role"> | null | undefined, capability: Capability): boolean {
  if (!workspace) return false;
  return (MATRIX[workspace.role] ?? []).includes(capability);
}

export function capabilitiesOf(role: WorkspaceRole): readonly Capability[] {
  return MATRIX[role] ?? [];
}

/**
 * Whether `actor` may change `target`'s membership.
 *
 * An admin manages viewers and editors only. Without that limit two admins can suspend each other,
 * and the owner finds out afterwards. Promotion to admin therefore stays an owner decision, which
 * matches what the role grants: permission to spend the owner's money.
 */
export function canManageMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole?: WorkspaceRole,
): boolean {
  // The owner row is not a membership and can never be demoted, suspended or removed — not by an
  // admin, and not by the owner either. Transferring ownership is a separate, explicit action.
  if (targetRole === "owner" || nextRole === "owner") return false;
  if (actorRole === "owner") return true;
  if (actorRole !== "admin") return false;
  if (targetRole === "admin") return false;
  return nextRole ? nextRole !== "admin" : true;
}

/** Roles an actor is allowed to hand out when adding someone. */
export function assignableRoles(actorRole: WorkspaceRole): readonly TeamRole[] {
  if (actorRole === "owner") return TEAM_ROLES;
  if (actorRole === "admin") return TEAM_ROLES.filter(role => role !== "admin");
  return [];
}

/**
 * A suspended member keeps their row and their history but resolves to no access at all. The
 * resolver reads this on every request, which is what makes suspension immediate despite JWT
 * sessions that cannot be revoked.
 */
export function statusGrantsAccess(status: string): boolean {
  return status === "active";
}

export const PASSWORD_MIN_LENGTH = 12;

/** Returns null when acceptable, otherwise a stable reason code the UI localizes. */
export function passwordProblem(password: string, email: string): string | null {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN_LENGTH) return "password_too_short";
  const local = String(email ?? "").toLowerCase().split("@")[0];
  if (local.length >= 3 && value.toLowerCase().includes(local)) return "password_contains_email";
  if (/^(.)\1+$/.test(value)) return "password_too_simple";
  return null;
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
