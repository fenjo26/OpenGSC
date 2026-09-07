import assert from "node:assert/strict";
import test from "node:test";
import { classifyDnsError, needsRegistryCheck, settlesWithoutRegistry, checkDnsBatch } from "./dns";

// The whole point of separating this from the resolver: the mapping from a failure code to a
// verdict is where the expensive mistakes live, and it can be checked without a network.
test("an authoritative 'does not exist' is distinguished from a resolver failure", () => {
  assert.equal(classifyDnsError("ENOTFOUND"), "nxdomain");
  assert.equal(classifyDnsError("NXDOMAIN"), "nxdomain");
});

test("resolver failures say nothing about the domain", () => {
  for (const code of ["SERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED", "ECANCELLED", undefined]) {
    assert.equal(classifyDnsError(code), "unknown", `code ${code}`);
  }
});

test("ENODATA is 'exists but not delegated', not 'free'", () => {
  assert.equal(classifyDnsError("ENODATA"), "no_records");
});

// The silent-data-loss bug this guards: a resolver hiccup must never retire a candidate.
test("only delegation lets a candidate skip the registry", () => {
  assert.equal(settlesWithoutRegistry("delegated"), true);
  for (const o of ["nxdomain", "no_records", "unknown"] as const) {
    assert.equal(settlesWithoutRegistry(o), false, o);
    assert.equal(needsRegistryCheck(o), true, o);
  }
  assert.equal(needsRegistryCheck("delegated"), false);
});

test("an empty batch resolves without touching the network", async () => {
  const res = await checkDnsBatch([]);
  assert.equal(res.size, 0);
});
