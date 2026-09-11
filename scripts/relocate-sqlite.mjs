import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Move a database out of the repository, before the updater's `git reset --hard` walks over it.
 *
 * The problem this exists for. `dev.db` is a tracked file in this repository — an empty 23 MB
 * schema template, committed years ago and never removed. `.env.template` ships
 * `DATABASE_URL="file:./dev.db"`, so anyone who installed by copying the template, rather than
 * running `install.sh` (absolute `data/prod.db`) or Docker (`/data/prod.db` on a volume), is
 * running their live instance out of a path git owns. `update.sh` then does
 * `git reset --hard origin/main`, and a hard reset restores tracked files: their database is
 * replaced by the empty template on every single update. The pre-reset backup means the data is
 * recoverable, but recovery is a thing the operator has to know to do, and an instance that boots
 * with an empty database looks exactly like total loss.
 *
 * So this runs before the reset and relocates such a database to `data/`, which is gitignored
 * (`/data/*.db`) and which a hard reset therefore never touches. After it has run once, the
 * install is permanently out of the blast radius.
 *
 * What it deliberately does NOT do:
 *
 *   • It does not delete the original. The copy is verified first, and the original is left where
 *     it is for the reset to overwrite — nothing is destroyed at any point in this script, so a
 *     failure anywhere leaves the instance exactly as it was.
 *   • It does not touch any database outside the repository root. An absolute path, a path under
 *     `data/`, MySQL, anything unfamiliar — skipped. This handles one known bad default, and
 *     narrow is the point: a relocation script that gets clever about which database it moves is
 *     a script that eventually moves the wrong one.
 *   • It does not create a `.env`. An instance configured through systemd, Docker or the shell has
 *     no `.env` to rewrite, and inventing one would introduce a second source of truth.
 */

const ROOT = process.cwd();
const LEGACY_NAME = "dev.db";
const TARGET_DIR = path.join(ROOT, "data");

function log(message) {
  console.log(`[relocate] ${message}`);
}

/** Exit 0 — the instance is fine as it is, and the updater should carry on. */
function skip(message) {
  log(message);
  process.exit(0);
}

/** Exit 1 — something went wrong BEFORE anything was changed. The updater must stop. */
function fail(message) {
  console.error(`[relocate] ${message}`);
  process.exit(1);
}

const raw = process.env.DATABASE_URL || "";
if (!raw.startsWith("file:")) skip("non-SQLite DATABASE_URL — nothing to relocate");

const value = raw.slice("file:".length).split("?")[0];
const dbPath = path.isAbsolute(value) ? value : path.resolve(ROOT, value);

// The one case this handles: the database is the tracked file in the repository root.
if (path.dirname(dbPath) !== ROOT || path.basename(dbPath) !== LEGACY_NAME) {
  skip(`database is not the tracked ${LEGACY_NAME} in the repository root (${dbPath}) — nothing to relocate`);
}
if (!fs.existsSync(dbPath)) skip(`${LEGACY_NAME} does not exist yet — nothing to relocate`);

// A `.env` is what we would have to rewrite; without one the variable comes from somewhere this
// script cannot reach, and moving the file would point the instance at nothing.
const envPath = path.join(ROOT, ".env");
if (!fs.existsSync(envPath)) {
  skip("DATABASE_URL is not set from a .env file — relocate the database by hand, see docs");
}
const envText = fs.readFileSync(envPath, "utf8");
const envLine = /^\s*DATABASE_URL\s*=.*$/m;
if (!envLine.test(envText)) {
  skip("no DATABASE_URL line in .env — relocate the database by hand, see docs");
}

fs.mkdirSync(TARGET_DIR, { recursive: true });

// A fresh name rather than overwriting anything. `data/prod.db` may already exist from an earlier
// installer run, and a half-finished previous attempt may have left `data/dev.db` — neither is
// something to write over on the strength of a guess about what it is.
let targetPath = path.join(TARGET_DIR, LEGACY_NAME);
if (fs.existsSync(targetPath)) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  targetPath = path.join(TARGET_DIR, `dev-${stamp}.db`);
  log(`data/${LEGACY_NAME} already exists — using ${path.basename(targetPath)} instead`);
}

const require = createRequire(import.meta.url);
let Database;
try {
  Database = require("better-sqlite3");
} catch (error) {
  fail(`better-sqlite3 is not available (${error?.message ?? error}) — nothing was changed`);
}

const sizeMb = Math.round(fs.statSync(dbPath).size / 1048576);
log(`copying ${sizeMb} MB from ${dbPath} to ${targetPath}`);

/**
 * The same ladder as scripts/backup-sqlite.mjs, and for the same reason.
 *
 * `VACUUM INTO` takes one read snapshot and is not restarted by concurrent writes, which matters
 * because the app is still running while the updater works. `.backup()` restarts from the
 * beginning on every write to the source and can therefore never finish on a busy instance.
 */
let method = "vacuum";
try {
  const source = new Database(dbPath, { fileMustExist: true, timeout: 15000 });
  try {
    source.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
} catch (error) {
  log(`VACUUM INTO failed (${error?.message ?? error}) — falling back to a file copy`);
  method = "file copy";
  try {
    // Main file first, then the WAL: the other order risks a checkpoint landing between them.
    fs.copyFileSync(dbPath, targetPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, targetPath + suffix);
    }
  } catch (copyError) {
    fail(`could not copy the database: ${copyError?.message ?? copyError} — nothing was changed`);
  }
}

// A copy that cannot be opened is not a copy, and the line after this one is the one that commits
// the instance to using it.
try {
  const copy = new Database(targetPath, { readonly: true, fileMustExist: true, timeout: 15000 });
  try {
    const result = copy.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`integrity_check returned ${String(result)}`);
  } finally {
    copy.close();
  }
} catch (error) {
  fail(`the copy could not be verified: ${error?.message ?? error} — nothing was changed, ${targetPath} can be deleted`);
}

fs.chmodSync(targetPath, 0o600);

// An absolute path, not a relative one. A relative DATABASE_URL resolves against whatever
// directory the process happens to start in, which is how an instance quietly ends up with a
// second database that nothing else reads — the same reason install.sh writes an absolute path.
const nextUrl = `DATABASE_URL="file:${targetPath}"`;
const nextEnv = envText.replace(envLine, nextUrl);
const envBackup = `${envPath}.before-relocate`;
try {
  fs.copyFileSync(envPath, envBackup);
  fs.writeFileSync(envPath, nextEnv, { mode: 0o600 });
} catch (error) {
  fail(`could not update .env: ${error?.message ?? error} — the database was copied but is not in use yet`);
}

log(`verified copy via ${method}`);
log(`DATABASE_URL now points at ${targetPath} (previous .env saved as ${path.basename(envBackup)})`);
log(`the old ${LEGACY_NAME} is left in place and will be overwritten by the update — it is no longer used`);
