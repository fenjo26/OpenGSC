// Guards for the MCP `execute_sql_query` tool.
//
// The tool hands an agent free-form SELECTs over the whole database, so what it must never return
// is anything that works as a credential: passwords, API keys, OAuth tokens, share links, proxy
// logins, publishing credentials. A keyword list of four table names did not cover that — most
// secrets live in ordinary tables (Site.shareToken, BlogConnection.credentials, DropProxy.password,
// InstanceSetting). Three layers now, each enough on its own for the common case:
//
//   1. screenSqlText   — the query text, string literals blanked: no writes, no attach/pragma, no
//                        secret table or secret-looking column named anywhere.
//   2. checkSqlitePlan — SQLite only, and the authoritative one: compile the statement with EXPLAIN
//                        and walk the bytecode. Every table or index the query opens and every column
//                        it reads is resolved against sqlite_master, so views, CTEs, subqueries and
//                        `SELECT *` cannot reach a secret the text did not name.
//   3. stripSecretKeys — whatever survives, any result key that looks like a secret is dropped.
//
// Pure apart from the `SqliteLike` handle it is given, so the tests run on node:sqlite.

/** Tables that are credentials as a whole, or exist only to hold them. Compared case-insensitively. */
export const SECRET_TABLES: readonly string[] = [
  "User", "Account", "Session", "VerificationToken",
  "Membership", "InstanceSetting", "BlogConnection", "DropProxy",
  "PushSubscription", "ContentRepository", "McpLink",
];

/**
 * A column whose name says it holds a secret. Anchored at the end so counters such as
 * `promptTokens` and fingerprints such as `contentHash` stay readable.
 */
export const SECRET_COLUMN = /(?:token|secret|password|passwd|credentials?|apikey|api_key|privatekey|private_key|indexnowkey|widgetkey|invitehash|cipher|webhook)$/i;

const SECRET_TABLE_SET = new Set(SECRET_TABLES.map(t => t.toLowerCase()));

export function isSecretTable(name: string): boolean {
  return SECRET_TABLE_SET.has(name.toLowerCase());
}

export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMN.test(name);
}

export type SqlEngine = "sqlite" | "mysql";

const WRITE_OR_ADMIN = /\b(attach|detach|pragma|vacuum|reindex|load_extension|insert|update|delete|drop|alter|create|replace|truncate|grant|revoke|analyze)\b/i;
/** SQLite virtual tables that expose raw pages or storage internals. */
const SQLITE_RAW = /\b(sqlite_dbpage|dbstat)\b/i;
/** MySQL: file access, timing/locking primitives, other schemas. */
const MYSQL_EXTRA = /\b(into|outfile|dumpfile|load_file|sleep|benchmark|get_lock|release_lock|processlist)\b|\bfor\s+(update|share)\b|\block\s+in\s+share\b|\b(mysql|performance_schema|sys)\s*\./i;

/** Single-quoted literals blanked, so `LIKE '%delete%'` is not a false positive. */
function blankLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Returns an error message, or null when the text passes. */
export function screenSqlText(sql: string, engine: SqlEngine): string | null {
  if (!/^(select|with)\b/i.test(sql)) return "Only SELECT (or WITH…SELECT) queries are allowed.";
  const text = blankLiterals(sql);
  const write = text.match(WRITE_OR_ADMIN);
  if (write) return `Blocked keyword: "${write[0]}". This tool is read-only.`;
  if (engine === "sqlite") {
    const raw = text.match(SQLITE_RAW);
    if (raw) return `Blocked object: "${raw[0]}".`;
  } else {
    const extra = text.match(MYSQL_EXTRA);
    if (extra) return `Blocked keyword: "${extra[0].trim()}".`;
  }
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (isSecretTable(word)) return `Table "${word}" holds credentials and is not readable through this tool.`;
    if (isSecretColumn(word)) return `Column "${word}" holds a secret and is not readable through this tool.`;
  }
  return null;
}

/** The minimum of better-sqlite3 / node:sqlite this module uses. */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

interface ObjInfo {
  kind: "table" | "index";
  name: string;
  table: string;
  /** For a table: column name by record position. For an index: column name by key position, null = rowid, "" = expression. */
  columns: (string | null)[];
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

function loadSchema(db: SqliteLike): Map<number, ObjInfo> {
  const rows = db.prepare(
    `SELECT type, name, tbl_name, rootpage FROM sqlite_master WHERE type IN ('table','index') AND rootpage > 0`,
  ).all() as { type: string; name: string; tbl_name: string; rootpage: number }[];
  const map = new Map<number, ObjInfo>();
  for (const r of rows) {
    if (r.type === "table") {
      const cols = r.name === "sqlite_master" || r.name === "sqlite_schema" ? [] :
        (db.prepare(`PRAGMA table_info(${quoteIdent(r.name)})`).all() as { cid: number; name: string }[])
          .sort((a, b) => a.cid - b.cid).map(c => c.name);
      map.set(Number(r.rootpage), { kind: "table", name: r.name, table: r.name, columns: cols });
    } else {
      const cols = (db.prepare(`PRAGMA index_xinfo(${quoteIdent(r.name)})`).all() as { seqno: number; cid: number; name: string | null }[])
        .sort((a, b) => a.seqno - b.seqno)
        .map(c => (c.cid === -1 ? null : c.cid === -2 ? "" : c.name ?? ""));
      map.set(Number(r.rootpage), { kind: "index", name: r.name, table: r.tbl_name, columns: cols });
    }
  }
  // sqlite_master itself lives on page 1 and is not listed in itself.
  if (!map.has(1)) map.set(1, { kind: "table", name: "sqlite_master", table: "sqlite_master", columns: [] });
  return map;
}

interface PlanRow { opcode: string; p1: number; p2: number; p3: number }

/**
 * Compile the query with EXPLAIN and check what it would touch. Returns an error message or null.
 * Runs nothing: EXPLAIN only prepares the statement.
 */
export function checkSqlitePlan(db: SqliteLike, sql: string): string | null {
  const schema = loadSchema(db);
  let plan: PlanRow[];
  try {
    plan = db.prepare(`EXPLAIN ${sql}`).all() as PlanRow[];
  } catch (e) {
    return `Query did not compile: ${(e as Error)?.message ?? e}`;
  }

  const cursors = new Map<number, ObjInfo>();
  for (const op of plan) {
    switch (op.opcode) {
      case "OpenWrite":
        return "This tool is read-only.";
      case "OpenRead":
      case "ReopenIdx": {
        if (Number(op.p3) !== 0) return "Only the main database is readable through this tool.";
        const obj = schema.get(Number(op.p2));
        if (!obj) return "The query reads a storage object this tool cannot identify.";
        if (isSecretTable(obj.table)) return `Table "${obj.table}" holds credentials and is not readable through this tool.`;
        if (obj.kind === "index") {
          // A comparison against an index key reads the value without any Column opcode, so an index
          // over a secret column is refused at open time, not at read time.
          const bad = obj.columns.find(c => c === "" || (c !== null && isSecretColumn(c)));
          if (bad !== undefined) {
            return bad === ""
              ? `Index "${obj.name}" is an expression index and is not readable through this tool.`
              : `Column "${obj.table}.${bad}" holds a secret and is not readable through this tool.`;
          }
        }
        cursors.set(Number(op.p1), obj);
        break;
      }
      case "OpenDup": {
        const orig = cursors.get(Number(op.p2));
        if (orig) cursors.set(Number(op.p1), orig);
        break;
      }
      case "Column": {
        const obj = cursors.get(Number(op.p1));
        if (!obj) break; // ephemeral / sorter / pseudo cursor: holds only values already read through a checked cursor
        const col = obj.columns[Number(op.p2)];
        if (col === undefined && obj.columns.length) return `The query reads a column of "${obj.table}" this tool cannot identify.`;
        if (col && isSecretColumn(col)) return `Column "${obj.table}.${col}" holds a secret and is not readable through this tool.`;
        break;
      }
    }
  }
  return null;
}

/** Drop result keys that look like secrets. Returns new row objects. */
export function stripSecretKeys(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!isSecretColumn(k)) out[k] = v;
    return out;
  });
}
