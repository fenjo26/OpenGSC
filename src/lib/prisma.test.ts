// SQLite under a log that writes on every provider call.
//
// The rank scheduler runs up to fifty sequential checks for a single site while other schedulers
// write alongside it; each provider call now adds a row of its own. In the rollback journal, a
// writer locks out readers for the length of its transaction, and a second writer gets
// SQLITE_BUSY immediately rather than waiting. Neither is survivable at that rate, and the
// failure would land on the feature being logged, not on the logger.
//
// So this asserts the two settings on a real connection rather than on the source of prisma.ts:
// a grep for "WAL" proves the string is present, not that better-sqlite3 ever saw it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A scratch database, because dev.db is tracked in git and journal_mode is written into the file.
const dir = mkdtempSync(join(tmpdir(), "opengsc-prisma-"));
process.env.DATABASE_URL = `file:${join(dir, "scratch.db")}`;

test("the connection prisma hands out is in WAL with a busy timeout", async () => {
  const { prisma, SQLITE_BUSY_TIMEOUT_MS } = await import("./prisma");
  try {
    const journal = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
    assert.equal(String(journal[0].journal_mode).toLowerCase(), "wal");

    // better-sqlite3 defaults this to 5000, so an assertion of "greater than zero" would pass
    // against a client that was never configured at all.
    const busy = await prisma.$queryRawUnsafe<{ timeout: number }[]>("PRAGMA busy_timeout");
    assert.equal(Number(busy[0].timeout), SQLITE_BUSY_TIMEOUT_MS);
    assert.ok(SQLITE_BUSY_TIMEOUT_MS >= 10_000, "a timeout shorter than a scheduler's write burst buys nothing");
  } finally {
    await prisma.$disconnect();
  }
});

test("a MySQL url is never taken down the SQLite path", async () => {
  const { createAdapter } = await import("./prisma");
  const before = readdirSync(dir);
  // MySQL is opt-in and the adapter is not installed here, so this is expected to fail — the
  // point is *how*. If the pragma work ran first it would fail earlier and differently, and
  // would have opened a SQLite file named after a connection string.
  assert.throws(
    () => createAdapter("mysql://user:pw@localhost:3306/opengsc", true),
    /adapter-mariadb/,
  );
  assert.deepEqual(readdirSync(dir), before, "the MySQL path touched the filesystem");
});
