import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";

import { OWNER_SESSION_VERSION } from "./lib/singleOwnerAuth";

const EXPECTED_EMAIL = "owner@example.com";
const OWNER_ID = "owner-user-id";
const OWNER_SUBJECT = "google-owner-subject";
const SECRET = "proxy-test-secret-proxy-test-secret";

let proxy: (request: NextRequest, event: never) => Promise<Response | undefined>;

before(async () => {
  process.env.NEXTAUTH_SECRET = SECRET;
  process.env.NEXTAUTH_URL = "http://localhost:3000";
  process.env.OPENGSC_EXPECTED_OWNER_EMAIL = EXPECTED_EMAIL;
  proxy = (await import("./proxy")).default as unknown as typeof proxy;
});

async function requestWithToken(token: Record<string, unknown>) {
  const encoded = await encode({ secret: SECRET, token, maxAge: 3600 });
  const request = new NextRequest("http://localhost:3000/settings", {
    headers: {
      cookie: `next-auth.session-token=${encoded}`,
    },
  });
  return proxy(request, undefined as never);
}

describe("authenticated request proxy", () => {
  it("redirects a signed pre-patch owner token", async () => {
    const response = await requestWithToken({
      email: EXPECTED_EMAIL,
      sub: OWNER_ID,
    });

    assert.equal(response?.status, 307);
    assert.match(response?.headers.get("location") ?? "", /\/api\/auth\/signin/);
  });

  it("allows a current owner token", async () => {
    const response = await requestWithToken({
      email: EXPECTED_EMAIL,
      sub: OWNER_ID,
      opengscGoogleSubject: OWNER_SUBJECT,
      opengscOwnerSessionVersion: OWNER_SESSION_VERSION,
    });

    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("x-middleware-next"), "1");
  });

  it("redirects current claims for another configured email", async () => {
    const response = await requestWithToken({
      email: "attacker@example.com",
      sub: OWNER_ID,
      opengscGoogleSubject: OWNER_SUBJECT,
      opengscOwnerSessionVersion: OWNER_SESSION_VERSION,
    });

    assert.equal(response?.status, 307);
  });
});
