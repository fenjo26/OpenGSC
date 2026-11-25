import assert from "node:assert/strict";
import { test } from "node:test";
import type { Capability } from "@/lib/team/roles";
import { grantCapabilities, isLinkTokenFormat, isMainTokenFormat, isNewIp, parseKnownIps, refusal, rememberIp, requiredCapabilities, subnetOf, KNOWN_IPS_MAX } from "./tokenScope";

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
  // A capability no link can carry (execute_sql_query is owner-only): the fix is the header alone.
  // Sending the user to create a link would have them grant spending for nothing, and still be refused.
  const fullLink = { kind: "link" as const, linkId: "l", allowWrite: true, allowSpend: true };
  const sqlViaUrl = refusal("execute_sql_query", sql, "owner", OWNER, url) ?? "";
  const sqlViaLink = refusal("execute_sql_query", sql, "owner", OWNER, fullLink) ?? "";
  for (const text of [sqlViaUrl, sqlViaLink]) {
    assert.match(text, /manageSecrets/);
    assert.match(text, /"Authorization: Bearer" header/);
    assert.doesNotMatch(text, /create a (connector )?link/);
    assert.doesNotMatch(text, /publishing and spending/);
  }
  assert.match(sqlViaLink, /no connector link allows/);
});

test("new-address alerts skip the first use and unknown addresses", () => {
  assert.equal(isNewIp([], "1.1.1.1"), false);
  assert.equal(isNewIp(["1.1.1.1"], "1.1.1.1"), false);
  assert.equal(isNewIp(["1.1.1.1"], "2.2.2.2"), true);
  assert.equal(isNewIp(["1.1.1.1"], "unknown"), false);
});

test("addresses are compared by subnet, not exactly — rotating egress stays quiet (#41)", () => {
  // IPv4: a claude.ai-style pool rotating the host bits inside a /24 is NOT new.
  assert.equal(isNewIp(["160.79.104.7"], "160.79.104.199"), false);
  // ...but crossing into a range it never used still alerts.
  assert.equal(isNewIp(["160.79.104.7"], "160.79.105.7"), true);
  // IPv6: /64 grain, compressed and expanded spellings of the same prefix agree.
  assert.equal(isNewIp(["2600:1f16::1"], "2600:1f16:0:0:0:0:0:2"), false);
  assert.equal(isNewIp(["2600:1f16::1"], "2600:1f17::1"), true);
  // IPv4-mapped IPv6 compares as the IPv4 address it carries.
  assert.equal(isNewIp(["::ffff:1.2.3.4"], "1.2.3.99"), false);
  // The stored list keeps exact addresses; legacy rows compare by subnet without migration.
  assert.deepEqual(subnetOf("1.2.3.4"), "1.2.3");
  assert.deepEqual(subnetOf("2600:1f16::1"), "2600:1f16:0:0");
  assert.deepEqual(subnetOf("::ffff:5.6.7.8"), "5.6.7");
  assert.deepEqual(subnetOf(""), "");
  assert.deepEqual(subnetOf("garbage"), "garbage");
});

test("known addresses stay bounded, ONE ENTRY PER SUBNET, most recent first", () => {
  let ips: string[] = [];
  for (let i = 0; i < KNOWN_IPS_MAX + 5; i++) ips = rememberIp(ips, `10.${i}.0.1`); // each its own /24
  assert.equal(ips.length, KNOWN_IPS_MAX);
  assert.equal(ips[0], `10.${KNOWN_IPS_MAX + 4}.0.1`);
  // Rotation inside a subnet REPLACES that subnet's older entry — one subnet, one slot,
  // so a rotating pool can never evict subnets that were already seen.
  assert.deepEqual(rememberIp(["160.79.104.7", "160.79.105.7"], "160.79.104.199"), ["160.79.104.199", "160.79.105.7"]);
  assert.deepEqual(rememberIp(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(rememberIp(["a"], "unknown"), ["a"]);
  assert.deepEqual(parseKnownIps('["a",1,"b"]'), ["a", "b"]);
  assert.deepEqual(parseKnownIps("not json"), []);
});

test("a rotating egress pool goes silent after warm-up — 24 subnets, 24 slots (#41)", () => {
  // claude.ai's published ranges: 160.79.104.0/21 (8 /24s) + 153.61.208.0/20 (16 /24s).
  const subnets: string[] = [];
  for (let i = 104; i <= 111; i++) subnets.push(`160.79.${i}.`);
  for (let i = 208; i <= 223; i++) subnets.push(`153.61.${i}.`);
  const draw = () => `${subnets[Math.floor(Math.random() * subnets.length)]}${Math.floor(Math.random() * 254) + 1}`;
  // Warm-up: at most one alert per unseen subnet — never per call.
  let ips: string[] = [];
  let warmupAlerts = 0;
  for (let i = 0; i < 500; i++) {
    const ip = draw();
    if (isNewIp(ips, ip)) warmupAlerts++;
    ips = rememberIp(ips, ip);
  }
  assert.equal(ips.length, 24, `expected one slot per subnet, got ${ips.length}`);
  assert.ok(warmupAlerts <= 24, `warm-up fired ${warmupAlerts} alerts for 24 subnets`);
  // The complaint itself: after warm-up, hundreds of rotating calls produce zero alerts.
  let afterWarmup = 0;
  for (let i = 0; i < 100; i++) {
    const ip = draw();
    if (isNewIp(ips, ip)) afterWarmup++;
    ips = rememberIp(ips, ip);
  }
  assert.equal(afterWarmup, 0, `rotating pool still alerting: ${afterWarmup} of 100 calls`);
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
