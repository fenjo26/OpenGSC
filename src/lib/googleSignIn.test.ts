import test from "node:test";
import assert from "node:assert/strict";
import { decideGoogleSignIn, envFlag, googleLoginOpen, parseEmailList, type GoogleSignInFacts } from "./googleSignIn";

const owner = { email: "owner@example.com", hasPassword: true };
const base: GoogleSignInFacts = {
  owner, ownerSession: false, accountLinked: true,
  email: "owner@example.com", emailVerified: true, bootstrapEmails: [], googleLoginForced: false,
};
const decide = (patch: Partial<GoogleSignInFacts>) => decideGoogleSignIn({ ...base, ...patch });

test("fresh instance without a restriction: first Google account bootstraps the owner", () => {
  assert.deepEqual(decide({ owner: null, accountLinked: false, email: "anyone@x.com" }), { kind: "bootstrap" });
});

test("fresh instance with OPENGSC_OWNER_EMAIL: only a listed, verified address bootstraps", () => {
  const list = ["me@x.com", "backup@x.com"];
  assert.deepEqual(decide({ owner: null, bootstrapEmails: list, email: "Me@X.com" }), { kind: "bootstrap" });
  assert.deepEqual(decide({ owner: null, bootstrapEmails: list, email: "stranger@x.com" }), { kind: "deny", reason: "bootstrap_email" });
  assert.deepEqual(decide({ owner: null, bootstrapEmails: list, email: "me@x.com", emailVerified: false }), { kind: "deny", reason: "bootstrap_email" });
  assert.deepEqual(decide({ owner: null, bootstrapEmails: list, email: null }), { kind: "deny", reason: "bootstrap_email" });
});

test("signed-in owner may connect any Google account, password or not", () => {
  assert.deepEqual(decide({ ownerSession: true, accountLinked: false, email: "other@x.com" }), { kind: "link" });
  assert.deepEqual(decide({ ownerSession: true, owner: { ...owner, hasPassword: false } }), { kind: "link" });
});

test("owner with a password cannot sign in through Google", () => {
  assert.deepEqual(decide({}), { kind: "deny", reason: "use_password" });
});

test("owner without a password keeps Google as the only way in", () => {
  assert.deepEqual(decide({ owner: { ...owner, hasPassword: false } }), { kind: "login" });
});

test("operator override reopens Google login for the owner only", () => {
  assert.deepEqual(decide({ googleLoginForced: true }), { kind: "login" });
  assert.deepEqual(decide({ googleLoginForced: true, email: "other@x.com" }), { kind: "deny", reason: "owner_only" });
});

test("strangers are refused whatever the owner's settings", () => {
  for (const hasPassword of [true, false]) {
    for (const googleLoginForced of [true, false]) {
      const o = { ...owner, hasPassword };
      assert.deepEqual(decide({ owner: o, googleLoginForced, accountLinked: false, email: "x@y.com" }), { kind: "deny", reason: "owner_only" });
      // A connected but non-owner account never becomes a login either.
      assert.deepEqual(decide({ owner: o, googleLoginForced, accountLinked: true, email: "x@y.com" }), { kind: "deny", reason: "owner_only" });
    }
  }
});

test("the owner's address on an unconnected Google account does not attach itself", () => {
  assert.deepEqual(decide({ owner: { ...owner, hasPassword: false }, accountLinked: false }), { kind: "deny", reason: "owner_only" });
});

test("an owner with no email cannot be matched by an empty Google email", () => {
  assert.deepEqual(decide({ owner: { email: null, hasPassword: false }, email: null }), { kind: "deny", reason: "owner_only" });
  assert.deepEqual(decide({ owner: { email: "", hasPassword: false }, email: "" }), { kind: "deny", reason: "owner_only" });
});

test("googleLoginOpen mirrors the login rule for the login page", () => {
  assert.equal(googleLoginOpen(null, false), true);
  assert.equal(googleLoginOpen({ hasPassword: false }, false), true);
  assert.equal(googleLoginOpen({ hasPassword: true }, false), false);
  assert.equal(googleLoginOpen({ hasPassword: true }, true), true);
});

test("env parsing", () => {
  assert.deepEqual(parseEmailList(" A@x.com, b@x.com;c@x.com  d@x.com ,"), ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  assert.deepEqual(parseEmailList(undefined), []);
  for (const on of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(envFlag(on), true, on);
  for (const off of [undefined, "", "0", "false", "no", "maybe"]) assert.equal(envFlag(off), false, String(off));
});
