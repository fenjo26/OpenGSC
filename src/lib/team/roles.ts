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
 *
 * On top of the fixed table sits a per-member override layer (issue #39): the owner may add or
 * remove individual capabilities on a member row within the fences below. The fences are what keep
 * the two boundaries non-negotiable — no override ever grants an owner-only capability or takes
 * away `read`, and everything outside them is the owner's call.
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

/**
 * What one member row may add to or subtract from its role. The fences are the two boundaries from
 * the header, kept hard on purpose:
 *
 *   - `read` cannot be revoked — a membership that cannot see the workspace is not a membership;
 *     suspend the person instead.
 *   - the owner-only capabilities cannot be granted at all, so no combination of overrides ever
 *     hands out credentials, the update button or the right to promote admins.
 *   - `manageMembers` cannot be granted below admin, because `canManageMember` is role-hierarchy,
 *     not capability, and a granted-but-dead switch is a lie told in a settings screen.
 */
/** Every capability a switch could exist for — the UI iterates this to render one row per item. */
export const TUNABLE_CAPABILITIES: readonly Capability[] = [
  "act", "write", "spend", "publish", "manageMembers",
];

const GRANTABLE: Record<TeamRole, readonly Capability[]> = {
  viewer: ["act", "write", "spend", "publish"],
  editor: ["spend", "publish"],
  admin: [],
};
// Taking back is uniform across roles: anything inside the tunable set — granted by an override or
// carried by the role itself — can be removed. The fence is the set, not per-role revoke lists.
const REVOKABLE: Record<TeamRole, readonly Capability[]> = {
  viewer: TUNABLE_CAPABILITIES,
  editor: TUNABLE_CAPABILITIES,
  admin: TUNABLE_CAPABILITIES,
};

/** Per-member deviation from the role matrix, as stored on the Membership row (JSON). */
export interface CapabilityDelta {
  add: Capability[];
  remove: Capability[];
}

export interface Workspace {
  /** The user id that owns every row — what `userId` has always meant in this codebase. */
  ownerId: string;
  /** Who is actually making the request. Equal to ownerId when the owner is signed in. */
  actorId: string;
  role: WorkspaceRole;
  /**
   * The capabilities this actor actually has, matrix plus overrides. Absent on contexts built from
   * a role alone (older callers, tests) — then `can()` falls back to the pure matrix.
   */
  capabilities?: readonly Capability[];
}

export function isTeamRole(value: unknown): value is TeamRole {
  return TEAM_ROLES.includes(String(value) as TeamRole);
}

export function can(workspace: Pick<Workspace, "role" | "capabilities"> | null | undefined, capability: Capability): boolean {
  if (!workspace) return false;
  return (workspace.capabilities ?? MATRIX[workspace.role] ?? []).includes(capability);
}

export function capabilitiesOf(role: WorkspaceRole): readonly Capability[] {
  return MATRIX[role] ?? [];
}

/**
 * Read a stored delta without trusting it. Anything that is not a `{add, remove}` shape of known
 * capabilities is dropped field by field rather than rejected, because this also runs on rows a
 * rolling update wrote before the fences existed — a stale override must degrade to a no-op, not
 * lock a member out of their session.
 */
export function sanitizeDelta(role: TeamRole, delta: { add?: unknown; remove?: unknown } | null | undefined): CapabilityDelta {
  const keep = (list: unknown, allowed: readonly Capability[]) =>
    Array.isArray(list)
      ? [...new Set(list.map(String).filter((cap): cap is Capability => allowed.includes(cap as Capability)))]
      : [];
  return {
    add: keep(delta?.add, GRANTABLE[role] ?? []),
    remove: keep(delta?.remove, REVOKABLE[role] ?? []),
  };
}

/** A raw column value (JSON string, object, junk) into a delta, or null when there is nothing. */
export function parseCapabilityDelta(raw: unknown): { add?: unknown; remove?: unknown } | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as { add?: unknown; remove?: unknown };
  return { add: obj.add, remove: obj.remove };
}

/**
 * What a member may actually do: their role's matrix, plus what the owner added, minus what the
 * owner removed. The delta is re-sanitized against the current role on every read, so a role
 * change that left a stale override behind can never widen or corrupt the result.
 */
export function effectiveCapabilities(role: WorkspaceRole, rawDelta: unknown): readonly Capability[] {
  if (role === "owner") return MATRIX.owner;
  const base = new Set(MATRIX[role] ?? []);
  const delta = sanitizeDelta(role, parseCapabilityDelta(rawDelta));
  for (const cap of delta.add) base.add(cap);
  for (const cap of delta.remove) base.delete(cap);
  return [...base];
}

/**
 * The delta that turns a role's defaults into `desired`. Returns null when they already match, so
 * "no customization" stays the absence of a row rather than a stored `{add:[],remove:[]}`.
 */
export function deltaFor(role: TeamRole, desired: readonly Capability[]): CapabilityDelta | null {
  const base = MATRIX[role] ?? [];
  const add = GRANTABLE[role].filter(cap => !base.includes(cap) && desired.includes(cap));
  const remove = REVOKABLE[role].filter(cap => base.includes(cap) && !desired.includes(cap));
  return add.length || remove.length ? { add, remove } : null;
}

/**
 * Whether a switch exists for this capability on this member right now. The owner-only three and
 * `read` never have one; the rest depends on the fences and on which side of its default the
 * capability currently sits (a granted switch must stay flippable in both directions).
 */
export function toggleableFor(role: TeamRole, capability: Capability, has: boolean): boolean {
  return has ? REVOKABLE[role].includes(capability) : GRANTABLE[role].includes(capability);
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
