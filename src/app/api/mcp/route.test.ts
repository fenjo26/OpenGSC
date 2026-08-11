import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";

import { MCP_TOKEN_PREFIX } from "@/lib/mcpToken";

const DATABASE_PATH = `/tmp/opengsc-mcp-route-test-${process.pid}.db`;
const CURRENT_TOKEN = `${MCP_TOKEN_PREFIX}${"a".repeat(48)}`;
const LEGACY_TOKEN = `ogsc_${"b".repeat(48)}`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let postMcp: (request: Request) => Promise<Response>;
let getTools: (request: Request) => Promise<Response>;

before(async () => {
  process.env.DATABASE_URL = `file:${DATABASE_PATH}`;
  process.env.NEXTAUTH_SECRET = "mcp-route-test-secret-mcp-route-test";
  process.env.NEXTAUTH_URL = "http://localhost:3000";
  process.env.OPENGSC_EXPECTED_OWNER_EMAIL = "owner@example.com";
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

  prisma = (await import("@/lib/prisma")).prisma;
  postMcp = (await import("./route")).POST;
  getTools = (await import("./tools/route")).GET;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "mcpToken" TEXT UNIQUE
    )
  `);
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "User"`);
});

after(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    rmSync(`${DATABASE_PATH}${suffix}`, { force: true });
  }
});

async function seedToken(token: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "mcpToken") VALUES (?, ?)`,
    "owner-user-id",
    token,
  );
}

function mcpRequest(token: string) {
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("MCP authentication boundary", () => {
  it("rejects a stored pre-patch bearer token", async () => {
    await seedToken(LEGACY_TOKEN);

    const response = await postMcp(mcpRequest(LEGACY_TOKEN));

    assert.equal(response.status, 401);
  });

  it("accepts a stored current bearer token", async () => {
    await seedToken(CURRENT_TOKEN);

    const response = await postMcp(mcpRequest(CURRENT_TOKEN));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.result?.tools));
  });

  it("rejects a legacy token on the tools endpoint without a session", async () => {
    await seedToken(LEGACY_TOKEN);
    const request = new Request("http://localhost:3000/api/mcp/tools", {
      headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
    });

    const response = await getTools(request);

    assert.equal(response.status, 401);
  });
});
