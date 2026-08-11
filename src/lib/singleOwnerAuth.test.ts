import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizeSingleOwnerGoogleSignIn,
  createOwnerSessionClaims,
  isAuthorizedOwnerSessionToken,
  OWNER_SESSION_VERSION,
  type GoogleAccountInput,
  type GoogleSignInAttempt,
  type OwnerIdentityState,
  type SingleOwnerAuthStore,
  type StoredGoogleAccount,
  type StoredOwner,
} from "./singleOwnerAuth";

const EXPECTED_EMAIL = "owner@example.com";
const OWNER_SUBJECT = "google-owner-subject";

const googleAccount: GoogleAccountInput = {
  type: "oauth",
  provider: "google",
  providerAccountId: OWNER_SUBJECT,
  accessToken: "new-access-token",
  refreshToken: undefined,
  expiresAt: 1_800_000_000,
  idToken: "new-id-token",
  scope: undefined,
  tokenType: "Bearer",
};

const owner: StoredOwner = {
  id: "owner-user-id",
  email: EXPECTED_EMAIL,
  name: "Owner",
  image: "https://example.com/owner.png",
};

const linkedAccount: StoredGoogleAccount = {
  id: "owner-account-id",
  userId: owner.id,
  provider: "google",
  providerAccountId: OWNER_SUBJECT,
};

function signInAttempt(
  overrides: Partial<GoogleSignInAttempt> = {},
): GoogleSignInAttempt {
  return {
    expectedOwnerEmail: EXPECTED_EMAIL,
    profile: {
      email: EXPECTED_EMAIL,
      email_verified: true,
      sub: OWNER_SUBJECT,
    },
    account: { ...googleAccount },
    ...overrides,
  };
}

function fakeStore(
  initialState: Omit<OwnerIdentityState, "googleAccountCount"> &
    Partial<Pick<OwnerIdentityState, "googleAccountCount">>,
  reconcileResult = true,
) {
  const reads: string[] = [];
  const writes: Array<{
    account: GoogleAccountInput;
    owner: StoredOwner;
  }> = [];
  const state: OwnerIdentityState = {
    googleAccountCount: initialState.account ? 1 : 0,
    ...initialState,
  };

  const store: SingleOwnerAuthStore = {
    async readIdentityState(providerAccountId) {
      reads.push(providerAccountId);
      return state;
    },
    async reconcileOwnerAccount(storedOwner, account) {
      writes.push({ account, owner: storedOwner });
      return reconcileResult;
    },
  };

  return { reads, store, writes };
}

describe("single-owner Google sign-in policy", () => {
  it("rejects an unknown first identity without reading or writing the store", async () => {
    const harness = fakeStore({ users: [], account: null });
    const attempt = signInAttempt({
      profile: {
        email: "attacker@example.com",
        email_verified: true,
        sub: "attacker-subject",
      },
      account: {
        ...googleAccount,
        providerAccountId: "attacker-subject",
      },
    });

    const result = await authorizeSingleOwnerGoogleSignIn(
      attempt,
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.reads, []);
    assert.deepEqual(harness.writes, []);
  });

  it("allows exact owner bootstrap without policy writes", async () => {
    const harness = fakeStore({ users: [], account: null });

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt(),
      harness.store,
    );

    assert.deepEqual(result, { allowed: true, kind: "bootstrap" });
    assert.deepEqual(harness.reads, [OWNER_SUBJECT]);
    assert.deepEqual(harness.writes, []);
  });

  it("rejects an unknown second identity without writes", async () => {
    const harness = fakeStore({ users: [owner], account: null });
    const unknownSubject = "unknown-second-subject";
    const attempt = signInAttempt({
      profile: {
        email: "second-attacker@example.com",
        email_verified: true,
        sub: unknownSubject,
      },
      account: {
        ...googleAccount,
        providerAccountId: unknownSubject,
      },
    });

    const result = await authorizeSingleOwnerGoogleSignIn(
      attempt,
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.reads, []);
    assert.deepEqual(harness.writes, []);
  });

  it("rejects a repeated unknown-account attempt without writes", async () => {
    const harness = fakeStore({ users: [owner], account: null });
    const unknownSubject = "repeated-unknown-subject";
    const attempt = signInAttempt({
      profile: {
        email: "repeat-attacker@example.com",
        email_verified: true,
        sub: unknownSubject,
      },
      account: {
        ...googleAccount,
        providerAccountId: unknownSubject,
      },
    });

    const first = await authorizeSingleOwnerGoogleSignIn(
      attempt,
      harness.store,
    );
    const second = await authorizeSingleOwnerGoogleSignIn(
      attempt,
      harness.store,
    );

    assert.deepEqual(first, { allowed: false });
    assert.deepEqual(second, { allowed: false });
    assert.deepEqual(harness.reads, []);
    assert.deepEqual(harness.writes, []);
  });

  it("recovers an accountless owner after verifying the configured identity", async () => {
    const harness = fakeStore({ users: [owner], account: null });
    const replacementSubject = "replacement-owner-subject";
    const attempt = signInAttempt({
      profile: {
        email: EXPECTED_EMAIL,
        email_verified: true,
        sub: replacementSubject,
      },
      account: {
        ...googleAccount,
        providerAccountId: replacementSubject,
      },
    });

    const result = await authorizeSingleOwnerGoogleSignIn(
      attempt,
      harness.store,
    );

    assert.deepEqual(result, { allowed: true, kind: "reauth", owner });
    assert.deepEqual(harness.reads, [replacementSubject]);
    assert.deepEqual(harness.writes, [{ account: attempt.account, owner }]);
  });

  it("does not replace an existing Google subject with the same email", async () => {
    const harness = fakeStore({
      users: [owner],
      account: null,
      googleAccountCount: 1,
    });
    const replacementSubject = "replacement-owner-subject";
    const attempt = signInAttempt({
      profile: {
        email: EXPECTED_EMAIL,
        email_verified: true,
        sub: replacementSubject,
      },
      account: {
        ...googleAccount,
        providerAccountId: replacementSubject,
      },
    });

    const result = await authorizeSingleOwnerGoogleSignIn(
      attempt,
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.writes, []);
  });

  it("reconciles tokens when the verified owner reauthenticates", async () => {
    const harness = fakeStore({ users: [owner], account: linkedAccount });
    const attempt = signInAttempt();

    const result = await authorizeSingleOwnerGoogleSignIn(
      attempt,
      harness.store,
    );

    assert.deepEqual(result, { allowed: true, kind: "reauth", owner });
    assert.deepEqual(harness.writes, [{ account: attempt.account, owner }]);
  });

  it("rejects an account linked to another user", async () => {
    const harness = fakeStore({
      users: [owner],
      account: { ...linkedAccount, userId: "another-user-id" },
    });

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt(),
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.writes, []);
  });

  it("fails closed when the expected owner email is missing", async () => {
    const harness = fakeStore({ users: [], account: null });

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt({ expectedOwnerEmail: undefined }),
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.reads, []);
    assert.deepEqual(harness.writes, []);
  });

  it("rejects an unverified profile before store access", async () => {
    const harness = fakeStore({ users: [], account: null });

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt({
        profile: {
          email: EXPECTED_EMAIL,
          email_verified: false,
          sub: OWNER_SUBJECT,
        },
      }),
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.reads, []);
    assert.deepEqual(harness.writes, []);
  });

  it("rejects a profile subject that differs from providerAccountId", async () => {
    const harness = fakeStore({ users: [], account: null });

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt({
        profile: {
          email: EXPECTED_EMAIL,
          email_verified: true,
          sub: "different-subject",
        },
      }),
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.reads, []);
    assert.deepEqual(harness.writes, []);
  });

  it("rejects inconsistent owner and account rows", async () => {
    const harness = fakeStore({
      users: [{ ...owner, email: "other@example.com" }],
      account: linkedAccount,
    });

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt(),
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.writes, []);
  });

  it("rejects databases with more than one user", async () => {
    const harness = fakeStore({
      users: [owner, { ...owner, id: "second-user-id" }],
      account: linkedAccount,
    });

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt(),
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.deepEqual(harness.writes, []);
  });

  it("denies sign-in when atomic account reconciliation fails", async () => {
    const harness = fakeStore({ users: [owner], account: linkedAccount }, false);

    const result = await authorizeSingleOwnerGoogleSignIn(
      signInAttempt(),
      harness.store,
    );

    assert.deepEqual(result, { allowed: false });
    assert.equal(harness.writes.length, 1);
  });

  it("creates versioned owner claims only from a verified sign-in", () => {
    assert.deepEqual(createOwnerSessionClaims(signInAttempt(), owner.id), {
      email: EXPECTED_EMAIL,
      opengscGoogleSubject: OWNER_SUBJECT,
      opengscOwnerSessionVersion: OWNER_SESSION_VERSION,
      sub: owner.id,
    });
    assert.equal(
      createOwnerSessionClaims(
        signInAttempt({
          profile: {
            email: "attacker@example.com",
            email_verified: true,
            sub: OWNER_SUBJECT,
          },
        }),
        owner.id,
      ),
      null,
    );
  });

  it("rejects every pre-patch session token", () => {
    assert.equal(
      isAuthorizedOwnerSessionToken(
        { email: EXPECTED_EMAIL, sub: owner.id },
        EXPECTED_EMAIL,
      ),
      false,
    );
  });

  it("accepts only a current claim for the configured owner", () => {
    const claims = createOwnerSessionClaims(signInAttempt(), owner.id);

    assert.equal(
      isAuthorizedOwnerSessionToken(claims, EXPECTED_EMAIL),
      true,
    );
    assert.equal(
      isAuthorizedOwnerSessionToken(claims, "other@example.com"),
      false,
    );
    assert.equal(
      isAuthorizedOwnerSessionToken(
        { ...claims, opengscOwnerSessionVersion: OWNER_SESSION_VERSION - 1 },
        EXPECTED_EMAIL,
      ),
      false,
    );
  });
});
