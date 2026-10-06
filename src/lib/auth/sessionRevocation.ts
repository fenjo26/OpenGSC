// Whether a JWT was issued before the account's current password.
//
// Sessions are JWTs (`src/lib/auth.ts`, 30-day max age). Nothing in the token used to change
// when the password did, so a stolen cookie kept working until it expired. Comparing against
// `iat` does not fix that: the session route re-encodes the JWT on every read and `setIssuedAt()`
// slides `iat` forward, and it also extends the expiry. A cookie that was used after the password
// change looks newer than the change.
//
// Sign-in therefore stamps `pwdAt` with `User.passwordUpdatedAt` in milliseconds (0 when the
// column is null). Later requests compare that claim to the column. The column is already
// written by every password change, reset, and invite acceptance, so this needs no migration.
//
// A token with no `pwdAt` was issued before this claim existed. If the account has a recorded
// revision, the token is rejected — including one whose `iat` is already newer than the change.
// That signs password users out once, on deploy. An account that has never recorded a revision
// (Google-only, column still null) keeps its session, and the next refresh stamps `pwdAt: 0`
// so setting a password later invalidates it.

export interface PasswordRevision {
  /** Milliseconds, or null when `User.passwordUpdatedAt` is null. */
  passwordUpdatedAtMs: number | null;
}

export type PasswordLookupResult = PasswordRevision | "missing" | "error";

export function claimPwdAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * True when this token must not be treated as a session.
 *
 * `pwdAt === null` means the claim is absent (a legacy token), not that the column was null.
 * A stamped `0` means the column was null at sign-in.
 */
export function sessionRevokedByPasswordChange(
  token: { pwdAt: number | null },
  account: PasswordRevision,
): boolean {
  const current = account.passwordUpdatedAtMs ?? 0;
  if (token.pwdAt === null) {
    // No claim. A null column has nothing newer than the token. A recorded revision cannot
    // be compared with `iat` — that clock slides — so the session has to be signed again.
    return account.passwordUpdatedAtMs !== null;
  }
  return token.pwdAt !== current;
}

export async function defaultPasswordLookup(userId: string): Promise<PasswordLookupResult> {
  try {
    const { prisma } = await import("../prisma");
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordUpdatedAt: true },
    });
    if (!row) return "missing";
    const at = row.passwordUpdatedAt;
    return { passwordUpdatedAtMs: at ? at.getTime() : null };
  } catch (error) {
    console.warn("[auth] could not read passwordUpdatedAt:", error);
    return "error";
  }
}

/**
 * The gate in front of a page request. The proxy sees the raw cookie and does not run the
 * JWT callback, so a password change has to be checked here too.
 *
 * A lookup error fails open: a database blip should not turn into a redirect loop. A missing
 * user fails closed.
 */
export async function passwordSessionRevoked(
  token: { sub?: string | null; pwdAt?: unknown } | null | undefined,
  lookup: (userId: string) => Promise<PasswordLookupResult> = defaultPasswordLookup,
): Promise<boolean> {
  if (!token?.sub) return false;
  let revision: PasswordLookupResult;
  try {
    revision = await lookup(token.sub);
  } catch {
    return false;
  }
  if (revision === "error") return false;
  if (revision === "missing") return true;
  return sessionRevokedByPasswordChange({ pwdAt: claimPwdAt(token.pwdAt) }, revision);
}

/**
 * Stamp or reject inside the NextAuth `jwt` callback.
 *
 * Mutates `token.pwdAt` when the session may continue. Returns `"revoked"` when the caller
 * must not re-issue the previous claims — the callback then returns an empty token, and the
 * session route replaces the cookie instead of logging a JWT error on every poll.
 *
 * On sign-in a lookup error is `"revoked"` rather than an unstamped token. An unstamped token
 * for an account that already has a revision would be thrown out on the very next request.
 * On a later refresh a lookup error fails open, same as the proxy.
 */
export async function enforcePasswordRevision(
  token: { sub?: string; pwdAt?: unknown },
  options: { signingIn: boolean; lookup: (userId: string) => Promise<PasswordLookupResult> },
): Promise<"ok" | "revoked"> {
  if (!token.sub) return options.signingIn ? "revoked" : "ok";
  let revision: PasswordLookupResult;
  try {
    revision = await options.lookup(token.sub);
  } catch {
    revision = "error";
  }
  if (revision === "error") return options.signingIn ? "revoked" : "ok";
  if (revision === "missing") return "revoked";

  const current = revision.passwordUpdatedAtMs ?? 0;
  if (options.signingIn) {
    token.pwdAt = current;
    return "ok";
  }
  const claim = claimPwdAt(token.pwdAt);
  if (sessionRevokedByPasswordChange({ pwdAt: claim }, revision)) return "revoked";
  if (claim === null) token.pwdAt = current;
  return "ok";
}
