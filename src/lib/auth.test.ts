import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";

import type { NextAuthOptions } from "next-auth";

const EXPECTED_EMAIL = "owner@example.com";
const OWNER_ID = "owner-user-id";
const OWNER_SUBJECT = "google-owner-subject";
const DATABASE_PATH = `/tmp/opengsc-auth-callback-test-${process.pid}.db`;

let callbacks: NonNullable<NextAuthOptions["callbacks"]>;
let authOptions: NextAuthOptions;
let prisma: (typeof import("./prisma"))["prisma"];

before(async () => {
  process.env.DATABASE_URL = `file:${DATABASE_PATH}`;
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.OPENGSC_EXPECTED_OWNER_EMAIL = EXPECTED_EMAIL;

  prisma = (await import("./prisma")).prisma;
  authOptions = (await import("./auth")).authOptions;
  if (!authOptions.callbacks) throw new Error("Auth callbacks are not configured");
  callbacks = authOptions.callbacks;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE "User" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT,
      "email" TEXT UNIQUE,
      "emailVerified" DATETIME,
      "image" TEXT,
      "seoSettings" TEXT,
      "mcpToken" TEXT UNIQUE,
      "telegramBotToken" TEXT,
      "telegramChatId" TEXT,
      "slackWebhook" TEXT,
      "alertSettings" TEXT,
      "digestSettings" TEXT,
      "syncSettings" TEXT,
      "neuralIndexerToken" TEXT,
      "xmlRiverUserId" TEXT,
      "xmlRiverApiKey" TEXT,
      "twoIndexToken" TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "Account" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "providerAccountId" TEXT NOT NULL,
      "refresh_token" TEXT,
      "access_token" TEXT,
      "expires_at" INTEGER,
      "token_type" TEXT,
      "scope" TEXT,
      "id_token" TEXT,
      "session_state" TEXT,
      "refresh_token_expires_in" INTEGER,
      CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId")`,
  );
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "Account"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "User"`);
});

after(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    rmSync(`${DATABASE_PATH}${suffix}`, { force: true });
  }
});

async function seedOwner(id = OWNER_ID, email = EXPECTED_EMAIL) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "name", "email") VALUES (?, ?, ?)`,
    id,
    "Owner",
    email,
  );
}

async function seedAccount({
  id,
  provider = "google",
  providerAccountId,
  refreshToken = null,
  scope = null,
}: {
  id: string;
  provider?: string;
  providerAccountId: string;
  refreshToken?: string | null;
  scope?: string | null;
}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Account" ("id", "userId", "type", "provider", "providerAccountId", "refresh_token", "access_token", "scope") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    OWNER_ID,
    "oauth",
    provider,
    providerAccountId,
    refreshToken,
    "old-access-token",
    scope,
  );
}

async function googleSignIn(
  email: string,
  subject: string,
  tokens: { refreshToken?: string; scope?: string } = {},
) {
  if (!callbacks.signIn) throw new Error("Sign-in callback is not configured");

  return callbacks.signIn({
    user: { id: subject, email },
    account: {
      type: "oauth",
      provider: "google",
      providerAccountId: subject,
      access_token: "new-access-token",
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
      token_type: "Bearer",
    },
    profile: { email, email_verified: true, sub: subject },
    credentials: undefined,
  } as never);
}

describe("owner session callbacks", () => {
  it("rejects a validly signed pre-patch token without owner claims", async () => {
    if (!callbacks.jwt) throw new Error("JWT callback is not configured");

    await assert.rejects(
      async () => {
        await callbacks.jwt!({
          token: { email: EXPECTED_EMAIL, sub: OWNER_ID },
          trigger: "update",
          session: {},
        } as never);
      },
      /Invalid or expired owner session/,
    );
  });

  it("mints owner claims only during a verified Google sign-in", async () => {
    if (!callbacks.jwt) throw new Error("JWT callback is not configured");

    const token = await callbacks.jwt({
      token: {},
      user: { id: OWNER_ID, email: EXPECTED_EMAIL },
      account: {
        type: "oauth",
        provider: "google",
        providerAccountId: OWNER_SUBJECT,
      },
      profile: {
        email: EXPECTED_EMAIL,
        email_verified: true,
        sub: OWNER_SUBJECT,
      },
      trigger: "signIn",
      isNewUser: false,
    } as never);

    assert.equal(token.email, EXPECTED_EMAIL);
    assert.equal(token.sub, OWNER_ID);
    assert.equal(token.opengscGoogleSubject, OWNER_SUBJECT);
    assert.equal(token.opengscOwnerSessionVersion, 1);
  });

  it("rejects an unverified identity before minting claims", async () => {
    if (!callbacks.jwt) throw new Error("JWT callback is not configured");

    await assert.rejects(
      async () => {
        await callbacks.jwt!({
          token: {},
          user: { id: OWNER_ID, email: EXPECTED_EMAIL },
          account: {
            type: "oauth",
            provider: "google",
            providerAccountId: OWNER_SUBJECT,
          },
          profile: {
            email: EXPECTED_EMAIL,
            email_verified: false,
            sub: OWNER_SUBJECT,
          },
          trigger: "signIn",
          isNewUser: false,
        } as never);
      },
      /Could not authorize owner session/,
    );
  });
});

describe("single-owner sign-in integration", () => {
  it("rejects repeated attacker callbacks without database writes", async () => {
    assert.equal(await googleSignIn("attacker@example.com", "attacker-subject"), false);
    assert.equal(await googleSignIn("attacker@example.com", "attacker-subject"), false);

    assert.equal(await prisma.user.count(), 0);
    assert.equal(await prisma.account.count(), 0);
  });

  it("recovers an accountless owner for the adapter without creating a user", async () => {
    await seedOwner();

    assert.equal(await googleSignIn(EXPECTED_EMAIL, OWNER_SUBJECT), true);
    assert.equal(await prisma.user.count(), 1);
    assert.equal(await prisma.account.count(), 1);

    const linkedOwner = await authOptions.adapter?.getUserByAccount?.({
      provider: "google",
      providerAccountId: OWNER_SUBJECT,
    });
    assert.equal(linkedOwner?.id, OWNER_ID);
  });

  it("does not replace a linked owner subject with the same email", async () => {
    await seedOwner();
    await seedAccount({ id: "owner-account", providerAccountId: OWNER_SUBJECT });

    assert.equal(
      await googleSignIn(EXPECTED_EMAIL, "replacement-owner-subject"),
      false,
    );
    const accounts = await prisma.account.findMany();
    assert.deepEqual(
      accounts.map((account) => account.providerAccountId),
      [OWNER_SUBJECT],
    );
  });

  it("removes legacy Google accounts while preserving tokens and other providers", async () => {
    await seedOwner();
    await seedAccount({
      id: "owner-account",
      providerAccountId: OWNER_SUBJECT,
      refreshToken: "stored-refresh-token",
      scope: "stored-scope",
    });
    await seedAccount({
      id: "legacy-google-account",
      providerAccountId: "legacy-attacker-subject",
    });
    await seedAccount({
      id: "other-provider-account",
      provider: "github",
      providerAccountId: "github-owner",
    });

    assert.equal(await googleSignIn(EXPECTED_EMAIL, OWNER_SUBJECT), true);

    const accounts = await prisma.account.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      })),
      [
        {
          id: "other-provider-account",
          provider: "github",
          providerAccountId: "github-owner",
        },
        {
          id: "owner-account",
          provider: "google",
          providerAccountId: OWNER_SUBJECT,
        },
      ],
    );
    const ownerAccount = accounts.find((account) => account.id === "owner-account");
    assert.equal(ownerAccount?.access_token, "new-access-token");
    assert.equal(ownerAccount?.refresh_token, "stored-refresh-token");
    assert.equal(ownerAccount?.scope, "stored-scope");
  });
});
