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
// Two runs can land in the same second (a retried update, an operator and the app racing), and a
// stamp collision makes VACUUM INTO fail on "output file already exists". The pid breaks the tie.
const backupPath = path.join(
  backupDir,
  fs.existsSync(path.join(backupDir, `opengsc-before-update-${stamp}.db`))
    ? `opengsc-before-update-${stamp}-${process.pid}.db`
    : `opengsc-before-update-${stamp}.db`,
);
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// How many verified backups to keep around. Every update writes a full one, and until 2026-09-22
// nothing ever removed the previous: ~50 of them (12 GB) silently filled a 33 GB VPS disk and the
// next update could not back up at all. Three is a day of rollbacks without being a disk liability.
const KEEP = Math.max(1, parseInt(process.env.OPENGSC_BACKUPS_KEEP ?? "3", 10) || 3);
const BACKUP_RE = /^opengsc-before-update-.*\.db$/;

function listBackups() {
  return fs.readdirSync(backupDir)
    .filter(name => BACKUP_RE.test(name))
    .map(name => {
      const full = path.join(backupDir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first
}

/**
 * Delete everything beyond the newest `keep` backups, plus sidecars whose database is gone. Runs
 * after a backup is verified (routine retention) and before one is attempted when the disk is too
 * full for it — in that rung `keep` is 1, because when the choice is forced, a fresh verified
 * backup is worth more than two stale ones.
 */
function prune(keep, why) {
  for (const { full } of listBackups().slice(keep)) {
    fs.rmSync(full, { force: true });
    for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(full + suffix, { force: true });
    log(`removed old backup (keeping ${keep}, ${why}): ${path.basename(full)}`);
  }
  // A backup attempt that dies mid-write leaves its -wal/-shm/-journal behind; without the .db
  // they belonged to these are junk that only adds to the disk that was too full to begin with.
  const live = new Set(listBackups().map(b => path.basename(b.full)));
  for (const name of fs.readdirSync(backupDir)) {
    const m = name.match(/^(opengsc-before-update-.+\.db)-(wal|shm|journal)$/);
    if (m && !live.has(m[1])) {
      fs.rmSync(path.join(backupDir, name), { force: true });
      log(`removed an orphaned sidecar: ${name}`);
    }
  }
}

function freeBytes() {
  try {
    const stats = fs.statfsSync(backupDir);
    return stats.bavail * stats.bsize;
  } catch {
    return null; // statfs needs a newer node than some installs run; the copy will fail loudly
  }
}

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

// Room is checked before the copy is attempted: a VACUUM INTO that dies at 90% on a full disk
// leaves a partial multi-gigabyte file and an error naming no numbers. If there is not enough,
// pruning down to the single newest backup is the space recovery — and if even that is not
// enough, fail here, before anything is written: the update aborts with the database untouched,
// exactly as it would have mid-copy, but with the arithmetic spelled out.
const walSize = fs.existsSync(dbPath + "-wal") ? fs.statSync(dbPath + "-wal").size : 0;
const needed = fs.statSync(dbPath).size + walSize;
let free = freeBytes();
if (free !== null && free < needed) {
  log(`only ${Math.round(free / 1048576)} MB free, ${Math.round(needed / 1048576)} MB needed — keeping only the newest backup`);
  prune(1, "make room for the new one");
  free = freeBytes();
  if (free !== null && free < needed) {
    console.error(`[backup] not enough disk space: ${Math.round(free / 1048576)} MB free after pruning, ${Math.round(needed / 1048576)} MB needed — free space on the volume first`);
    process.exit(1);
  }
}

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
  // A failed VACUUM INTO can leave a partial target behind; the fallback starts from clean ground.
  fs.rmSync(backupPath, { force: true });
  for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(backupPath + suffix, { force: true });
  method = "file copy";
  try {
    fileCopy();
  } catch (copyError) {
    fs.rmSync(backupPath, { force: true });
    for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(backupPath + suffix, { force: true });
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
prune(KEEP, "retention");
