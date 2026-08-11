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
const source = new Database(dbPath, { fileMustExist: true });
try {
  await source.backup(backupPath);
} finally {
  source.close();
}

const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
try {
  const result = copy.pragma("integrity_check", { simple: true });
  if (result !== "ok") throw new Error(`backup integrity_check returned ${String(result)}`);
} finally {
  copy.close();
}

fs.chmodSync(backupPath, 0o600);
console.log(`[backup] consistent SQLite backup: ${backupPath}`);
