import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIpFromHeaders, trustedIpHeader } from "./clientIp";

const forged = {
  "cf-connecting-ip": "6.6.6.6",
  "x-real-ip": "192.0.2.8",
  "x-forwarded-for": "7.7.7.7, 198.51.100.7",
};

test("unset keeps the legacy order", () => {
  assert.equal(clientIpFromHeaders(forged, {}), "6.6.6.6");
  assert.equal(clientIpFromHeaders({ "x-forwarded-for": "198.51.100.7, 10.1.1.1" }, {}), "198.51.100.7");
  assert.equal(clientIpFromHeaders(undefined, {}), "unknown");
});

test("x-real-ip: a client-sent CF-Connecting-IP is ignored", () => {
  const env = { OPENGSC_CLIENT_IP_HEADER: "x-real-ip" };
  assert.equal(clientIpFromHeaders(forged, env), "192.0.2.8");
  assert.equal(clientIpFromHeaders({ "cf-connecting-ip": "6.6.6.6" }, env), "unknown");
});

test("cf-connecting-ip trusts only that header", () => {
  const env = { OPENGSC_CLIENT_IP_HEADER: "CF-Connecting-IP" };
  assert.equal(clientIpFromHeaders(forged, env), "6.6.6.6");
  assert.equal(clientIpFromHeaders({ "x-real-ip": "192.0.2.8" }, env), "unknown");
});

test("x-forwarded-for trusts the hop the proxy appended (the last one)", () => {
  const env = { OPENGSC_CLIENT_IP_HEADER: "x-forwarded-for" };
  assert.equal(clientIpFromHeaders(forged, env), "198.51.100.7");
  const web = new Headers({ "x-forwarded-for": "1.1.1.1,  203.0.113.4 " });
  assert.equal(clientIpFromHeaders(web, env), "203.0.113.4");
});

test("none puts every request in one bucket", () => {
  assert.equal(clientIpFromHeaders(forged, { OPENGSC_CLIENT_IP_HEADER: "none" }), "unknown");
});

test("an unrecognised value falls back to the legacy order instead of trusting an arbitrary header", () => {
  assert.equal(trustedIpHeader({ OPENGSC_CLIENT_IP_HEADER: "x-evil" }), null);
  assert.equal(clientIpFromHeaders(forged, { OPENGSC_CLIENT_IP_HEADER: "x-evil" }), "6.6.6.6");
});

test("malformed values never become a bucket key", () => {
  assert.equal(clientIpFromHeaders({ "x-real-ip": "bad value" }, { OPENGSC_CLIENT_IP_HEADER: "x-real-ip" }), "unknown");
});
