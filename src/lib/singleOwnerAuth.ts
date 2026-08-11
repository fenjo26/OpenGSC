export interface GoogleAccountInput {
  type: string | null | undefined;
  provider: string | null | undefined;
  providerAccountId: string | null | undefined;
  accessToken: string | null | undefined;
  refreshToken: string | null | undefined;
  expiresAt: number | null | undefined;
  idToken: string | null | undefined;
  scope: string | null | undefined;
  tokenType: string | null | undefined;
}

export interface GoogleSignInAttempt {
  expectedOwnerEmail: string | undefined;
  profile: unknown;
  account: GoogleAccountInput | null | undefined;
}

export interface StoredOwner {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

export interface StoredGoogleAccount {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
}

export interface OwnerIdentityState {
  users: readonly StoredOwner[];
  account: StoredGoogleAccount | null;
  googleAccountCount: number;
}

export interface SingleOwnerAuthStore {
  readIdentityState(providerAccountId: string): Promise<OwnerIdentityState>;
  reconcileOwnerAccount(
    owner: StoredOwner,
    account: GoogleAccountInput,
  ): Promise<boolean>;
}

export type SingleOwnerAuthorization =
  | { allowed: false }
  | { allowed: true; kind: "bootstrap" }
  | { allowed: true; kind: "reauth"; owner: StoredOwner };

export interface VerifiedGoogleIdentity {
  email: string;
  providerAccountId: string;
}

export const OWNER_SESSION_VERSION = 1;

export interface OwnerSessionClaims {
  email: string;
  opengscGoogleSubject: string;
  opengscOwnerSessionVersion: number;
  sub: string;
}

const DENIED = { allowed: false } as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    value === value.trim() &&
    EMAIL_PATTERN.test(value)
  );
}

function isValidSubject(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value === value.trim()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function verifyExpectedOwnerGoogleIdentity(
  attempt: GoogleSignInAttempt,
): VerifiedGoogleIdentity | null {
  const { account, expectedOwnerEmail, profile } = attempt;
  if (!isValidEmail(expectedOwnerEmail)) return null;
  if (!account || account.type !== "oauth" || account.provider !== "google") {
    return null;
  }
  if (!isRecord(profile)) return null;

  const { email, email_verified: emailVerified, sub } = profile;
  if (!isValidEmail(email) || email !== expectedOwnerEmail) return null;
  if (emailVerified !== true) return null;
  if (!isValidSubject(sub)) return null;
  if (
    !isValidSubject(account.providerAccountId) ||
    account.providerAccountId !== sub
  ) {
    return null;
  }

  return { email, providerAccountId: sub };
}

export function createOwnerSessionClaims(
  attempt: GoogleSignInAttempt,
  userId: unknown,
): OwnerSessionClaims | null {
  const identity = verifyExpectedOwnerGoogleIdentity(attempt);
  if (!identity || !isValidSubject(userId)) return null;

  return {
    email: identity.email,
    opengscGoogleSubject: identity.providerAccountId,
    opengscOwnerSessionVersion: OWNER_SESSION_VERSION,
    sub: userId,
  };
}

export function isAuthorizedOwnerSessionToken(
  token: unknown,
  expectedOwnerEmail: string | undefined,
): token is OwnerSessionClaims {
  if (!isRecord(token) || !isValidEmail(expectedOwnerEmail)) return false;

  return (
    token.email === expectedOwnerEmail &&
    token.opengscOwnerSessionVersion === OWNER_SESSION_VERSION &&
    isValidSubject(token.opengscGoogleSubject) &&
    isValidSubject(token.sub)
  );
}

export async function authorizeSingleOwnerGoogleSignIn(
  attempt: GoogleSignInAttempt,
  store: SingleOwnerAuthStore,
): Promise<SingleOwnerAuthorization> {
  const identity = verifyExpectedOwnerGoogleIdentity(attempt);
  if (!identity) return DENIED;

  const state = await store.readIdentityState(identity.providerAccountId);
  if (state.users.length === 0) {
    return state.account === null && state.googleAccountCount === 0
      ? { allowed: true, kind: "bootstrap" }
      : DENIED;
  }
  if (state.users.length !== 1) return DENIED;

  const owner = state.users[0];
  const accountInput = attempt.account;
  if (
    !owner ||
    !isValidSubject(owner.id) ||
    owner.email !== identity.email ||
    !accountInput
  ) {
    return DENIED;
  }
  if (
    state.account &&
    (state.account.id.length === 0 ||
      state.account.userId !== owner.id ||
      state.account.provider !== "google" ||
      state.account.providerAccountId !== identity.providerAccountId)
  ) {
    return DENIED;
  }
  if (
    (state.account === null && state.googleAccountCount !== 0) ||
    (state.account !== null && state.googleAccountCount < 1)
  ) {
    return DENIED;
  }

  const reconciled = await store.reconcileOwnerAccount(owner, accountInput);
  if (!reconciled) return DENIED;

  return { allowed: true, kind: "reauth", owner };
}
