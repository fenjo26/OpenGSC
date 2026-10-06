import assert from "node:assert/strict";
import test from "node:test";
import {
  claimPwdAt,
  enforcePasswordRevision,
  passwordSessionRevoked,
  sessionRevokedByPasswordChange,
  type PasswordLookupResult,
} from "./sessionRevocation";

const ISSUED = 1_700_000_000_000;
const CHANGED = 1_700_000_100_000;

test("a token stamped with the current revision stays valid", () => {
  assert.equal(
    sessionRevokedByPasswordChange({ pwdAt: ISSUED }, { passwordUpdatedAtMs: ISSUED }),
    false,
  );
  assert.equal(
    sessionRevokedByPasswordChange({ pwdAt: 0 }, { passwordUpdatedAtMs: null }),
    false,
  );
});

test("a password change after sign-in revokes the stamped token", () => {
  assert.equal(
    sessionRevokedByPasswordChange({ pwdAt: ISSUED }, { passwordUpdatedAtMs: CHANGED }),
    true,
  );
  // Setting a password on a Google-only account moves the column from null to a timestamp.
  assert.equal(
    sessionRevokedByPasswordChange({ pwdAt: 0 }, { passwordUpdatedAtMs: CHANGED }),
    true,
  );
});

test("a legacy token is revoked once a revision exists, even if iat is newer than the change", () => {
  // next-auth re-encodes the JWT on every /api/auth/session and setIssuedAt() slides iat
  // forward, so a stolen cookie can look newer than passwordUpdatedAt. The missing claim
  // is the signal, not iat.
  assert.equal(
    sessionRevokedByPasswordChange({ pwdAt: null }, { passwordUpdatedAtMs: ISSUED }),
    true,
  );
  assert.equal(
    sessionRevokedByPasswordChange({ pwdAt: null }, { passwordUpdatedAtMs: null }),
    false,
  );
});

test("NaN is not a revision stamp", () => {
  assert.equal(claimPwdAt(Number.NaN), null);
  assert.equal(claimPwdAt(ISSUED), ISSUED);
  assert.equal(claimPwdAt("1700000000000"), null);
});

test("sign-in stamps pwdAt from the column, including null as 0", async () => {
  const token: { sub?: string; pwdAt?: unknown } = { sub: "user-1" };
  const verdict = await enforcePasswordRevision(token, {
    signingIn: true,
    lookup: async () => ({ passwordUpdatedAtMs: ISSUED }),
  });
  assert.equal(verdict, "ok");
  assert.equal(token.pwdAt, ISSUED);

  const google: { sub?: string; pwdAt?: unknown } = { sub: "user-1" };
  assert.equal(await enforcePasswordRevision(google, {
    signingIn: true,
    lookup: async () => ({ passwordUpdatedAtMs: null }),
  }), "ok");
  assert.equal(google.pwdAt, 0);
});

test("a later request rejects a stamp that no longer matches and keeps a match", async () => {
  const stale = { sub: "user-1", pwdAt: ISSUED };
  assert.equal(await enforcePasswordRevision(stale, {
    signingIn: false,
    lookup: async () => ({ passwordUpdatedAtMs: CHANGED }),
  }), "revoked");

  const current = { sub: "user-1", pwdAt: CHANGED };
  assert.equal(await enforcePasswordRevision(current, {
    signingIn: false,
    lookup: async () => ({ passwordUpdatedAtMs: CHANGED }),
  }), "ok");
  assert.equal(current.pwdAt, CHANGED);
});

test("a legacy password session is revoked; a legacy Google-only session is stamped and kept", async () => {
  const password: { sub?: string; pwdAt?: unknown } = { sub: "user-1" };
  assert.equal(await enforcePasswordRevision(password, {
    signingIn: false,
    lookup: async () => ({ passwordUpdatedAtMs: ISSUED }),
  }), "revoked");
  assert.equal(password.pwdAt, undefined);

  const google: { sub?: string; pwdAt?: unknown } = { sub: "user-1" };
  assert.equal(await enforcePasswordRevision(google, {
    signingIn: false,
    lookup: async () => ({ passwordUpdatedAtMs: null }),
  }), "ok");
  assert.equal(google.pwdAt, 0);
});

test("a deleted user is revoked; a lookup failure fails open except during sign-in", async () => {
  assert.equal(await enforcePasswordRevision({ sub: "user-1", pwdAt: ISSUED }, {
    signingIn: false,
    lookup: async () => "missing",
  }), "revoked");

  const kept = { sub: "user-1", pwdAt: ISSUED };
  assert.equal(await enforcePasswordRevision(kept, {
    signingIn: false,
    lookup: async () => "error",
  }), "ok");
  assert.equal(kept.pwdAt, ISSUED);

  assert.equal(await enforcePasswordRevision({ sub: "user-1" }, {
    signingIn: true,
    lookup: async () => "error",
  }), "revoked");
});

test("the proxy gate agrees with the jwt gate", async () => {
  const lookup = async (id: string): Promise<PasswordLookupResult> => {
    if (id === "gone") return "missing";
    if (id === "down") return "error";
    if (id === "google") return { passwordUpdatedAtMs: null };
    return { passwordUpdatedAtMs: CHANGED };
  };

  assert.equal(await passwordSessionRevoked({ sub: "user-1", pwdAt: ISSUED }, lookup), true);
  assert.equal(await passwordSessionRevoked({ sub: "user-1", pwdAt: CHANGED }, lookup), false);
  assert.equal(await passwordSessionRevoked({ sub: "user-1" }, lookup), true);
  assert.equal(await passwordSessionRevoked({ sub: "google" }, lookup), false);
  assert.equal(await passwordSessionRevoked({ sub: "gone", pwdAt: CHANGED }, lookup), true);
  assert.equal(await passwordSessionRevoked({ sub: "down", pwdAt: ISSUED }, lookup), false);
  assert.equal(await passwordSessionRevoked(null, lookup), false);
  assert.equal(await passwordSessionRevoked({ pwdAt: CHANGED }, lookup), false);
});
