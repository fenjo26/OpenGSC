import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const raw = process.env.DATABASE_URL || "";
if (!raw.startsWith("file:")) {
  console.log("[backup] non-SQLite DATABASE_URL — automatic file backup skipped");
  process.exit(0);
}

const value = raw.slice("file:".length).split("?")[0];
const dbPath = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
if (!fs.existsSync(dbPath)) {
  console.log(`[backup] SQLite database does not exist yet — skipped (${dbPath})`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const backupDir = path.join(path.dirname(dbPath), "backups");
const backupPath = path.join(backupDir, `opengsc-before-update-${stamp}.db`);
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

/**
 * How a live database gets copied, and why not the obvious way.
 *
 * `better-sqlite3`'s `.backup()` walks the file page by page and **restarts from the beginning
 * whenever the source is written to**. On an idle development database that finishes instantly; on
 * a production instance with hourly rank, AEO and Clarity schedulers writing constantly, it can
 * restart forever. It did — an update sat on this line for fifteen minutes with no output and no
 * error, which is worse than any failure, because the operator cannot tell a slow backup from a
 * hung one.
 *
 * `VACUUM INTO` is the right tool: one statement, a single read snapshot, no restart on concurrent
 * writes, and the result is a compacted copy rather than a byte-for-byte one. Everything below is
 * a ladder of fallbacks around it, and every rung reports what it is doing.
 */
function log(message) {
  console.log(`[backup] ${message}`);
}

function fileCopy() {
  // Last resort while the app is running: copy the database and its WAL sidecars together. WAL
  // first would risk a checkpoint landing between the two, so the main file goes first and the
  // -wal after it — the pair then replays to a consistent state on open.
  fs.copyFileSync(dbPath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, backupPath + suffix);
  }
}

const sizeMb = Math.round(fs.statSync(dbPath).size / 1048576);
log(`copying ${sizeMb} MB from ${dbPath}`);

let method = "vacuum";
try {
  const source = new Database(dbPath, { fileMustExist: true, timeout: 15000 });
  try {
    // A quoted path: the database lives under a path the operator chose, which may contain spaces.
    source.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
} catch (error) {
  log(`VACUUM INTO failed (${error?.message ?? error}) — falling back to a file copy`);
  method = "file copy";
  try {
    fileCopy();
  } catch (copyError) {
    console.error(`[backup] could not create a backup: ${copyError?.message ?? copyError}`);
    process.exit(1);
  }
}

try {
  const copy = new Database(backupPath, { readonly: true, fileMustExist: true, timeout: 15000 });
  try {
    const result = copy.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`integrity_check returned ${String(result)}`);
  } finally {
    copy.close();
  }
} catch (error) {
  // A backup that cannot be opened is not a backup, and the schema change that follows is exactly
  // the moment its absence would matter.
  console.error(`[backup] the copy could not be verified: ${error?.message ?? error}`);
  process.exit(1);
}

fs.chmodSync(backupPath, 0o600);
for (const suffix of ["-wal", "-shm"]) {
  if (fs.existsSync(backupPath + suffix)) fs.chmodSync(backupPath + suffix, 0o600);
}
log(`verified backup via ${method}: ${backupPath}`);
