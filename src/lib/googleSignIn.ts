/**
 * Who may come through the Google door, and what happens when they do.
 *
 * Google OAuth does two different jobs in OpenGSC, and they must not be confused:
 *
 *   1. Bootstrap — on an instance with no owner yet, the first Google sign-in creates the owner.
 *   2. Data connection — an owner who is already signed in attaches Google accounts whose Search
 *      Console and Analytics data the dashboard reads (Settings → Google accounts).
 *
 * Signing in *as the owner* through Google is a third use, and it is only a fallback: it stays open
 * while the owner has no password (otherwise they would have no way in at all) and closes the moment
 * one is set — which is what the "set a password" prompt in Settings has always promised. An
 * operator who lost that password reopens it with OPENGSC_ALLOW_GOOGLE_LOGIN=true.
 *
 * The rule lives here, free of Prisma and NextAuth, because it is the security boundary of the
 * login page and deserves tests that do not need a database. `auth.ts` gathers the facts and acts
 * on the decision; the public `/api/auth/login-options` route asks `googleLoginOpen` so that the
 * page never offers a door the server will refuse.
 */

export type GoogleSignInDenial =
  /** Not the owner's Google account, and nobody signed in as the owner asked to connect it. */
  | "owner_only"
  /** The owner's own account, but the owner has a password: Google is a data connection now. */
  | "use_password"
  /** A fresh instance restricted by OPENGSC_OWNER_EMAIL, and this address is not on the list. */
  | "bootstrap_email";

export type GoogleSignInDecision =
  /** No owner exists: the adapter creates this user, who becomes the owner. */
  | { kind: "bootstrap" }
  /** The owner, signed in, is connecting (or re-authorising) a Google account. */
  | { kind: "link" }
  /** The owner signing in with their own, already connected Google account. */
  | { kind: "login" }
  | { kind: "deny"; reason: GoogleSignInDenial };

export interface GoogleSignInFacts {
  owner: { email: string | null; hasPassword: boolean } | null;
  /** The request carries a valid session cookie belonging to the owner. */
  ownerSession: boolean;
  /** This Google account is already connected to the instance. */
  accountLinked: boolean;
  /** The address Google reports for the account, and whether Google has verified it. */
  email: string | null;
  emailVerified: boolean | undefined;
  /** Parsed OPENGSC_OWNER_EMAIL; empty means "no restriction", the historical behaviour. */
  bootstrapEmails: string[];
  /** OPENGSC_ALLOW_GOOGLE_LOGIN — the operator's override for a lost password. */
  googleLoginForced: boolean;
}

const norm = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();

/** Comma- or whitespace-separated list, lower-cased, empties dropped. */
export function parseEmailList(raw: string | undefined): string[] {
  return String(raw ?? "").split(/[\s,;]+/).map(norm).filter(Boolean);
}

/** An env flag reads as on for 1/true/yes/on, in any case. */
export function envFlag(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(raw ?? "").trim());
}

/**
 * Whether the login page's Google button leads anywhere for someone who is not signed in.
 *
 * True on a fresh instance (bootstrap) and while the owner has no password; false otherwise unless
 * the operator forced it. This answers only "is the door open" — whether a *particular* Google
 * account may pass is `decideGoogleSignIn`'s job.
 */
export function googleLoginOpen(owner: { hasPassword: boolean } | null, forced: boolean): boolean {
  if (!owner) return true;
  return forced || !owner.hasPassword;
}

export function decideGoogleSignIn(f: GoogleSignInFacts): GoogleSignInDecision {
  if (!f.owner) {
    // With no restriction configured this stays first-come-first-served, as it always was; the
    // env var exists for instances that are reachable from the internet before the owner arrives.
    if (f.bootstrapEmails.length === 0) return { kind: "bootstrap" };
    const email = norm(f.email);
    if (!email || f.emailVerified === false || !f.bootstrapEmails.includes(email)) {
      return { kind: "deny", reason: "bootstrap_email" };
    }
    return { kind: "bootstrap" };
  }

  // Connecting data sources is an owner action taken from inside a session, and it is the one use
  // of Google that survives everything else being switched off.
  if (f.ownerSession) return { kind: "link" };

  // From here on this is a login attempt by someone who is not signed in. Only the owner's own,
  // already connected account can ever pass — a Google account is never attached from outside.
  const ownersOwn = f.accountLinked && !!norm(f.owner.email) && norm(f.email) === norm(f.owner.email);
  if (!ownersOwn) return { kind: "deny", reason: "owner_only" };

  if (!googleLoginOpen(f.owner, f.googleLoginForced)) return { kind: "deny", reason: "use_password" };
  return { kind: "login" };
}
