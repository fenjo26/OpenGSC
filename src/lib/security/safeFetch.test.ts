import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeTarget, isUnsafeAddress, privateTargetsAllowed, SafeFetchError } from "./safeFetch";

test("blocks private, local, link-local and reserved IPv4 ranges", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  ]) assert.equal(isUnsafeAddress(address), true, address);
  assert.equal(isUnsafeAddress("8.8.8.8"), false);
  assert.equal(isUnsafeAddress("1.1.1.1"), false);
});

test("blocks unsafe IPv6 ranges and normalized IPv4-mapped loopback", () => {
  for (const address of [
    "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "64:ff9b::7f00:1",
  ]) {
    assert.equal(isUnsafeAddress(address), true, address);
  }
  assert.equal(isUnsafeAddress("2606:4700:4700::1111"), false);
});

test("rejects non-http protocols and credentials", async () => {
  await assert.rejects(() => assertSafeTarget("file:///etc/passwd"), (error: unknown) => error instanceof SafeFetchError && error.code === "unsupported_protocol");
  await assert.rejects(() => assertSafeTarget("https://user:pass@example.com/"), (error: unknown) => error instanceof SafeFetchError && error.code === "credentials_not_allowed");
});

test("rejects local hostnames and literal private destinations before a socket opens", async () => {
  for (const target of ["http://localhost/", "http://service.internal/", "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/"]) {
    await assert.rejects(() => assertSafeTarget(target), (error: unknown) => error instanceof SafeFetchError && error.code === "private_address", target);
  }
});

// The opt-in below exists for operators auditing a staging site on their own box. Every test here
// guards the same contract: it is off by default, it never widens a public surface, and it does
// not relax any check other than the destination address.
test("private targets stay blocked unless the instance opts in", async () => {
  const previous = process.env.OPENGSC_ALLOW_PRIVATE_TARGETS;
  try {
    delete process.env.OPENGSC_ALLOW_PRIVATE_TARGETS;
    assert.equal(privateTargetsAllowed(), false);
    await assert.rejects(() => assertSafeTarget("http://127.0.0.1/"), (error: unknown) => error instanceof SafeFetchError && error.code === "private_address");

    process.env.OPENGSC_ALLOW_PRIVATE_TARGETS = "1";
    assert.equal(privateTargetsAllowed(), true);
    const allowed = await assertSafeTarget("http://127.0.0.1:3000/audit");
    assert.equal(allowed.addresses[0]?.address, "127.0.0.1");

    // A public route passes allowPrivate:false and must keep the strict behaviour regardless.
    await assert.rejects(() => assertSafeTarget("http://127.0.0.1/", { allowPrivate: false }), (error: unknown) => error instanceof SafeFetchError && error.code === "private_address");
    await assert.rejects(() => assertSafeTarget("http://localhost/", { allowPrivate: false }), (error: unknown) => error instanceof SafeFetchError && error.code === "private_address");
  } finally {
    if (previous === undefined) delete process.env.OPENGSC_ALLOW_PRIVATE_TARGETS;
    else process.env.OPENGSC_ALLOW_PRIVATE_TARGETS = previous;
  }
});

test("the private-target opt-in does not relax protocol or credential rules", async () => {
  await assert.rejects(() => assertSafeTarget("file:///etc/passwd", { allowPrivate: true }), (error: unknown) => error instanceof SafeFetchError && error.code === "unsupported_protocol");
  await assert.rejects(() => assertSafeTarget("http://user:pass@127.0.0.1/", { allowPrivate: true }), (error: unknown) => error instanceof SafeFetchError && error.code === "credentials_not_allowed");
});
