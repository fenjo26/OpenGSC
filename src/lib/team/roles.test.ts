import assert from "node:assert/strict";
import test from "node:test";
import {
  assignableRoles, can, canManageMember, capabilitiesOf, deltaFor,
  effectiveCapabilities, isTeamRole, normalizeEmail, passwordProblem,
  sanitizeDelta, statusGrantsAccess, TEAM_ROLES, toggleableFor, TUNABLE_CAPABILITIES,
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

test("overrides can widen or narrow a member inside the fences", () => {
  // An editor trusted with paid research, an admin barred from spending: both are the owner's call.
  assert.deepEqual([...effectiveCapabilities("editor", { add: ["spend"] })], ["read", "act", "write", "spend"]);
  assert.deepEqual(
    [...effectiveCapabilities("admin", { remove: ["spend", "manageMembers"] })],
    ["read", "act", "write", "publish"],
  );
  // A viewer upgraded to writer without becoming an editor in name.
  assert.deepEqual([...effectiveCapabilities("viewer", { add: ["write"] })], ["read", "write"]);
});

test("no override ever grants an owner-only capability or takes away read", () => {
  for (const raw of [
    { add: ["manageSecrets", "manageAdmins", "manageInstance", "read"] },
    { add: ["manageSecrets"], remove: ["read"] },
    "not json at all",
    { add: "spend" },          // wrong shape: not an array
    { add: ["spend"], remove: ["nonsense", "spend"] },
    null, undefined, 42,
  ]) {
    for (const role of TEAM_ROLES) {
      const caps = effectiveCapabilities(role, raw);
      assert.equal(caps.includes("read"), true, `${role} keeps read`);
      assert.equal(caps.includes("manageSecrets"), false, `${role} cannot gain secrets`);
      assert.equal(caps.includes("manageAdmins"), false, `${role} cannot gain admins`);
      assert.equal(caps.includes("manageInstance"), false, `${role} cannot gain the instance`);
    }
  }
  // The owner role ignores deltas entirely — ownership is not a membership row.
  assert.deepEqual([...effectiveCapabilities("owner", { remove: ["read"] })], [...capabilitiesOf("owner")]);
});

test("sanitize drops what the fences do not allow for that role", () => {
  // Granting manageMembers below admin is dead on arrival — canManageMember is hierarchy, not caps.
  assert.deepEqual(sanitizeDelta("viewer", { add: ["write", "manageMembers", "spend"] }), { add: ["write", "spend"], remove: [] });
  assert.deepEqual(sanitizeDelta("editor", { add: ["spend", "act"], remove: ["read"] }), { add: ["spend"], remove: [] });
  assert.deepEqual(sanitizeDelta("admin", { add: ["spend"], remove: ["publish", "manageMembers"] }), { add: [], remove: ["publish", "manageMembers"] });
  assert.deepEqual(sanitizeDelta("admin", null), { add: [], remove: [] });
});

test("a granted switch stays flippable in both directions", () => {
  // Defaults: admin has spend, viewer does not.
  assert.equal(toggleableFor("admin", "spend", true), true);
  assert.equal(toggleableFor("viewer", "spend", false), true);
  // Owner-only and read never get a switch, and manageMembers is not grantable below admin.
  assert.equal(toggleableFor("admin", "manageSecrets", false), false);
  assert.equal(toggleableFor("viewer", "read", true), false);
  assert.equal(toggleableFor("editor", "manageMembers", false), false);
  // The moment spend is granted to a viewer, taking it back must be possible too.
  assert.equal(toggleableFor("viewer", "spend", true), true);
});

test("deltaFor stores nothing when the answer equals the role defaults", () => {
  assert.equal(deltaFor("admin", [...capabilitiesOf("admin")]), null);
  assert.deepEqual(deltaFor("editor", ["read", "act", "write", "spend"]), { add: ["spend"], remove: [] });
  assert.deepEqual(deltaFor("admin", ["read", "write", "spend", "publish", "manageMembers"]), { add: [], remove: ["act"] });
  // Round trip: apply the computed delta, get the desired list back.
  const desired: readonly import("./roles").Capability[] = ["read", "act", "write", "spend"];
  const delta = deltaFor("viewer", desired);
  assert.deepEqual(
    [...effectiveCapabilities("viewer", delta)],
    desired,
  );
});

test("can() honors effective capabilities when they are present", () => {
  const adminNoSpend = { role: "admin" as const, capabilities: effectiveCapabilities("admin", { remove: ["spend"] }) };
  assert.equal(can(adminNoSpend, "spend"), false);
  assert.equal(can(adminNoSpend, "publish"), true);
  assert.equal(can(adminNoSpend, "manageMembers"), true);
  // Without the field the pure matrix decides — old callers and tests keep their meaning.
  assert.equal(can({ role: "admin" }, "spend"), true);
  const editorWithSpend = { role: "editor" as const, capabilities: effectiveCapabilities("editor", { add: ["spend"] }) };
  assert.equal(can(editorWithSpend, "spend"), true);
  assert.equal(can(editorWithSpend, "publish"), false);
});

test("the tunable list never mentions an owner-only capability or read", () => {
  for (const cap of TUNABLE_CAPABILITIES) {
    assert.notEqual(cap, "read");
    assert.notEqual(cap, "manageAdmins");
    assert.notEqual(cap, "manageSecrets");
    assert.notEqual(cap, "manageInstance");
  }
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
