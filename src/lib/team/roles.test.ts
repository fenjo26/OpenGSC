import assert from "node:assert/strict";
import test from "node:test";
import {
  assignableRoles, can, canManageMember, capabilitiesOf, isTeamRole,
  normalizeEmail, passwordProblem, statusGrantsAccess, TEAM_ROLES,
} from "./roles";

test("a viewer can read and nothing else", () => {
  const viewer = { role: "viewer" as const };
  assert.equal(can(viewer, "read"), true);
  for (const capability of ["act", "write", "spend", "publish", "manageMembers", "manageSecrets", "manageInstance"] as const) {
    assert.equal(can(viewer, capability), false, capability);
  }
});

test("spending is the boundary between editor and admin", () => {
  assert.equal(can({ role: "editor" }, "write"), true);
  assert.equal(can({ role: "editor" }, "act"), true);
  // An editor writing a draft costs nothing; generating it bills the owner's key.
  assert.equal(can({ role: "editor" }, "spend"), false);
  assert.equal(can({ role: "editor" }, "publish"), false);
  assert.equal(can({ role: "admin" }, "spend"), true);
  assert.equal(can({ role: "admin" }, "publish"), true);
});

test("credentials and instance control never leave the owner", () => {
  for (const capability of ["manageSecrets", "manageInstance", "manageAdmins"] as const) {
    assert.equal(can({ role: "admin" }, capability), false, capability);
    assert.equal(can({ role: "owner" }, capability), true, capability);
  }
});

test("no role is missing from the matrix and none is empty", () => {
  for (const role of [...TEAM_ROLES, "owner"] as const) {
    assert.ok(capabilitiesOf(role).length > 0, role);
  }
  assert.equal(can(null, "read"), false);
  assert.equal(can(undefined, "read"), false);
  assert.equal(isTeamRole("owner"), false, "owner is not a membership role");
  assert.equal(isTeamRole("editor"), true);
  assert.equal(isTeamRole("root"), false);
});

test("the owner cannot be demoted, suspended or removed by anyone", () => {
  for (const actor of ["owner", "admin", "editor", "viewer"] as const) {
    assert.equal(canManageMember(actor, "owner"), false, actor);
    assert.equal(canManageMember(actor, "editor", "owner"), false, actor);
  }
});

test("an admin manages viewers and editors but never another admin", () => {
  assert.equal(canManageMember("admin", "viewer"), true);
  assert.equal(canManageMember("admin", "editor"), true);
  assert.equal(canManageMember("admin", "admin"), false);
  // Promotion to admin means permission to spend, so it stays an owner decision.
  assert.equal(canManageMember("admin", "editor", "admin"), false);
  assert.equal(canManageMember("owner", "editor", "admin"), true);
  assert.equal(canManageMember("editor", "viewer"), false);
  assert.deepEqual([...assignableRoles("admin")], ["viewer", "editor"]);
  assert.deepEqual([...assignableRoles("owner")], ["viewer", "editor", "admin"]);
  assert.deepEqual([...assignableRoles("editor")], []);
});

test("only an active membership grants access", () => {
  assert.equal(statusGrantsAccess("active"), true);
  assert.equal(statusGrantsAccess("invited"), false);
  assert.equal(statusGrantsAccess("suspended"), false);
});

test("password rules reject the failures that actually happen", () => {
  assert.equal(passwordProblem("correct horse battery", "editor@agency.com"), null);
  assert.equal(passwordProblem("short1", "editor@agency.com"), "password_too_short");
  assert.equal(passwordProblem("editorEDITOR12", "editor@agency.com"), "password_contains_email");
  assert.equal(passwordProblem("aaaaaaaaaaaaaa", "editor@agency.com"), "password_too_simple");
  // A two-letter local part is too short to be a meaningful substring rule.
  assert.equal(passwordProblem("qwertyuiopas", "ab@agency.com"), null);
});

test("emails are compared in one normalized form", () => {
  assert.equal(normalizeEmail("  Editor@Agency.COM "), "editor@agency.com");
  assert.equal(normalizeEmail(undefined), "");
});
