import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWhoisAvailability,
  parseWhoisExpiry,
  parseWhoisCreated,
  parseWhoisNameServers,
  parseWhoisStatuses,
  isDroppingSoon,
} from "./patterns";
import { resolveProfile } from "./registries";

const VERISIGN_TAKEN = `
   Domain Name: EXAMPLE.COM
   Registry Domain ID: 2336799_DOMAIN_COM-VRSN
   Registrar WHOIS Server: whois.iana.org
   Creation Date: 1995-08-14T04:00:00Z
   Registry Expiry Date: 2027-08-13T04:00:00Z
   Registrar: RESERVED-Internet Assigned Numbers Authority
   Domain Status: clientDeleteProhibited https://icann.org/epp#clientDeleteProhibited
   Name Server: A.IANA-SERVERS.NET
   Name Server: B.IANA-SERVERS.NET
`;

const VERISIGN_FREE = `No match for "NOTREGISTERED-EXAMPLE.COM".
>>> Last update of whois database: 2026-09-07T09:00:00Z <<<`;

const DENIC_FREE = `
% Error: 55000000002 Domain unknown
%% no entries found
`;

const RATE_LIMITED = `
WHOIS LIMIT EXCEEDED - SEE WWW.PIR.ORG/WHOIS FOR DETAILS
Your query rate has been exceeded. Please try again later.
`;

test("a registered reply is read as registered", () => {
  assert.equal(parseWhoisAvailability(VERISIGN_TAKEN), "registered");
});

test("the free phrasings each registry uses are recognised", () => {
  assert.equal(parseWhoisAvailability(VERISIGN_FREE), "available");
  assert.equal(parseWhoisAvailability("Not found: nothing.io"), "available");
  assert.equal(parseWhoisAvailability("Domain not found."), "available");
  assert.equal(parseWhoisAvailability("Status: AVAILABLE"), "available");
});

// DENIC says it in its own words and matches none of the shared patterns, which is what the
// per-registry `availablePatterns` field exists for.
test("a registry's own phrasing comes from its profile", () => {
  assert.equal(parseWhoisAvailability(DENIC_FREE, resolveProfile("de")), "available");
});

// The failure that turns a throttled sweep into a list of confidently wrong answers: a
// rate-limit reply contains no "available" phrasing, so anything that only looks for those
// calls every throttled name registered.
test("a refusal is a refusal, never 'registered'", () => {
  assert.equal(parseWhoisAvailability(RATE_LIMITED), "refused");
  assert.equal(parseWhoisAvailability("Access denied"), "refused");
  assert.equal(parseWhoisAvailability("Service temporarily unavailable"), "refused");
});

test("an unrecognised body is 'empty', not a guess", () => {
  assert.equal(parseWhoisAvailability(""), "empty");
  assert.equal(parseWhoisAvailability("   \n  "), "empty");
  assert.equal(parseWhoisAvailability("some prose that says nothing useful"), "empty");
});

// "no match" also appears inside terms-of-use boilerplate; an unanchored regex would report a
// live domain as free.
test("the free phrasings only count at the start of a line", () => {
  const body = VERISIGN_TAKEN + "\nTERMS OF USE: you agree that no match for these terms is implied.";
  assert.equal(parseWhoisAvailability(body), "registered");
});

test("dates are parsed when present and null when not", () => {
  assert.equal(parseWhoisExpiry(VERISIGN_TAKEN)?.toISOString(), "2027-08-13T04:00:00.000Z");
  assert.equal(parseWhoisCreated(VERISIGN_TAKEN)?.toISOString(), "1995-08-14T04:00:00.000Z");
  assert.equal(parseWhoisExpiry(VERISIGN_FREE), null);
  assert.equal(parseWhoisExpiry("Registry Expiry Date: not a date"), null);
});

test("nameservers are lowercased, de-duplicated and stripped of a trailing dot", () => {
  assert.deepEqual(parseWhoisNameServers(VERISIGN_TAKEN), ["a.iana-servers.net", "b.iana-servers.net"]);
  assert.deepEqual(parseWhoisNameServers("nserver: NS1.HOST.COM.\nnserver: ns1.host.com"), ["ns1.host.com"]);
  assert.deepEqual(parseWhoisNameServers(VERISIGN_FREE), []);
});

test("statuses drive the fast re-check", () => {
  assert.deepEqual(parseWhoisStatuses(VERISIGN_TAKEN), ["clientDeleteProhibited"]);
  assert.equal(isDroppingSoon(["clientDeleteProhibited"]), false);
  assert.equal(isDroppingSoon(["pendingDelete"]), true);
  assert.equal(isDroppingSoon(["redemptionPeriod"]), true);
  assert.equal(isDroppingSoon(["pending delete"]), true);
});
