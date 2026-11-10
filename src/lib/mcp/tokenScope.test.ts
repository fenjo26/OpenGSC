import assert from "node:assert/strict";
import { test } from "node:test";
import type { Capability } from "@/lib/team/roles";
import { grantCapabilities, isLinkTokenFormat, isMainTokenFormat, isNewIp, parseKnownIps, refusal, rememberIp, requiredCapabilities, KNOWN_IPS_MAX } from "./tokenScope";

const OWNER: Capability[] = ["read", "act", "write", "spend", "publish", "manageMembers", "manageAdmins", "manageSecrets", "manageInstance"];
const read = { cost: "local" };
const write = { cost: "local", readOnly: false };
const paid = { cost: "paid" };
const publish = { cost: "paid", readOnly: false };
const sql = { cost: "local", capability: "manageSecrets" as Capability };

test("a header token keeps the person's capabilities", () => {
  assert.deepEqual(grantCapabilities({ kind: "header" }, OWNER), OWNER);
});

test("a URL token reads and acts only", () => {
  assert.deepEqual(grantCapabilities({ kind: "url" }, OWNER), ["read", "act"]);
});

test("a connector link adds only what it was created with", () => {
  const link = (allowWrite: boolean, allowSpend: boolean) => ({ kind: "link" as const, linkId: "l", allowWrite, allowSpend });
  assert.deepEqual(grantCapabilities(link(false, false), OWNER), ["read", "act"]);
  assert.deepEqual(grantCapabilities(link(true, false), OWNER), ["read", "act", "write"]);
  assert.deepEqual(grantCapabilities(link(false, true), OWNER), ["read", "act", "spend", "publish"]);
  // Never more than the person has.
  assert.deepEqual(grantCapabilities(link(true, true), ["read"]), ["read"]);
});

test("a paid tool that changes something needs spend AND write", () => {
  assert.deepEqual(requiredCapabilities(publish).sort(), ["read", "spend", "write"]);
  assert.deepEqual(requiredCapabilities(read), ["read"]);
  assert.deepEqual(requiredCapabilities(sql).sort(), ["manageSecrets", "read"]);
});

test("refusals name the right fix", () => {
  const header = { kind: "header" as const };
  const url = { kind: "url" as const };
  const spendOnly = { kind: "link" as const, linkId: "l", allowWrite: false, allowSpend: true };
  assert.equal(refusal("get_sites", read, "owner", OWNER, url), null);
  assert.equal(refusal("publish_post", publish, "owner", OWNER, header), null);
  assert.match(refusal("publish_post", publish, "owner", OWNER, url) ?? "", /URL/);
  assert.match(refusal("start_rewrite_job", paid, "owner", OWNER, url) ?? "", /connector link/);
  assert.match(refusal("publish_post", publish, "owner", OWNER, spendOnly) ?? "", /does not allow/);
  assert.match(refusal("update_site_context", write, "viewer", ["read"], header) ?? "", /role \(viewer\)/);
  assert.match(refusal("execute_sql_query", sql, "owner", OWNER, url) ?? "", /manageSecrets/);
});

test("new-address alerts skip the first use and unknown addresses", () => {
  assert.equal(isNewIp([], "1.1.1.1"), false);
  assert.equal(isNewIp(["1.1.1.1"], "1.1.1.1"), false);
  assert.equal(isNewIp(["1.1.1.1"], "2.2.2.2"), true);
  assert.equal(isNewIp(["1.1.1.1"], "unknown"), false);
});

test("known addresses stay bounded, most recent first", () => {
  let ips: string[] = [];
  for (let i = 0; i < KNOWN_IPS_MAX + 5; i++) ips = rememberIp(ips, `10.0.0.${i}`);
  assert.equal(ips.length, KNOWN_IPS_MAX);
  assert.equal(ips[0], `10.0.0.${KNOWN_IPS_MAX + 4}`);
  assert.deepEqual(rememberIp(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(rememberIp(["a"], "unknown"), ["a"]);
  assert.deepEqual(parseKnownIps('["a",1,"b"]'), ["a", "b"]);
  assert.deepEqual(parseKnownIps("not json"), []);
});

test("token shapes: only minted tokens, never a stored hash form", async () => {
  const { newToken, storedFormOf } = await import("@/lib/security/apiTokens");
  const main = newToken("ogsc_");
  const link = newToken("ogsc_link_");
  assert.ok(isMainTokenFormat(main));
  assert.ok(isLinkTokenFormat(link));
  assert.ok(!isMainTokenFormat(link));
  assert.ok(!isMainTokenFormat(storedFormOf(main)));
  assert.ok(!isLinkTokenFormat(storedFormOf(link)));
  assert.ok(!isMainTokenFormat(main.toUpperCase()));
  assert.ok(!isMainTokenFormat(main + "0"));
});
