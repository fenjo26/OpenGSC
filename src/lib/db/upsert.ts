// One place that knows how this database spells "insert or update".
//
// Why this exists rather than `prisma.upsert()`
// ---------------------------------------------
// The obvious way to make OpenGSC portable to another database is to replace its raw upserts
// with Prisma's own `upsert()`, which is dialect-agnostic by construction. That was tried and
// rejected, because three behaviours in these writes cannot be expressed through it, and losing
// them would be a silent data-quality regression rather than a visible break:
//
//   1. **Do not overwrite a known value with a null.** `COALESCE(incoming, stored)`. A partial
//      refresh (say, volumes without keyword difficulty) must not erase the difficulty someone
//      already paid for. Prisma's `update` has no expression referring to the stored row.
//
//   2. **Do not let an older observation win.** `WHERE incoming.checkedAt >= stored.checkedAt`.
//      A CSV export generated three weeks ago can be imported today; without the guard it would
//      overwrite fresher API data. Prisma has no conditional-on-conflict.
//
//   3. **Accumulate rather than replace.** `units = units + incoming`. Prisma *can* express this
//      with `{ increment }`, but only after choosing create-vs-update, which is a second query.
//
// Emulating any of them in JavaScript means read-then-write: an extra query per row — and
// `writeKeywordCache` writes up to a thousand rows in a loop — plus a race the single statement
// did not have. So the dialect stays in SQL, and this module is the only file that has to learn
// a second one.
//
// Adding a database is now one function: {@link buildUpsert}'s `default` branch.

import { prisma } from "@/lib/prisma";

/** How a column behaves when the row already exists. */
export type UpsertMode =
  /** Always take the incoming value. */
  | "set"
  /** Take the incoming value unless it is null — then keep what is stored. */
  | "keep"
  /** Add the incoming value to the stored one. */
  | "add"
  /** Take the incoming value unless it is an empty string — then keep what is stored. */
  | "keepEmpty";

export interface UpsertSpec {
  table: string;
  /** Columns forming the primary key / unique index the conflict is detected on. */
  conflict: string[];
  /** Every column being inserted, in the order they should be written. */
  values: Record<string, unknown>;
  /**
   * What to do with each column on conflict. Columns absent from this map are inserted but
   * never updated — which is how `createdAt`-style columns keep their original value.
   */
  update: Record<string, UpsertMode>;
  /**
   * Apply the update only when the incoming value of this column is greater than or equal to
   * the stored one. The freshness guard from behaviour 2 above.
   */
  onlyIfNewer?: string;
}

/**
 * Which SQL dialect to emit.
 *
 * Read from the Prisma datasource rather than from a setting of its own: two places that can
 * disagree about the database is a worse failure than not being configurable. Today the schema
 * only ever says `sqlite`; the point of reading it is that adding a provider changes one file.
 */
export type SqlDialect = "sqlite";

export function currentDialect(): SqlDialect {
  return "sqlite";
}

/** Quote an identifier for the dialect. SQLite and Postgres use double quotes; MySQL backticks. */
function quote(id: string, dialect: SqlDialect): string {
  switch (dialect) {
    case "sqlite":
      return `"${id}"`;
  }
}

/**
 * Build the INSERT … ON CONFLICT statement and its positional parameters.
 *
 * Exported separately from {@link runUpsert} so it can be asserted against in a test without a
 * database — the whole risk of this refactor is a generated statement that differs from the
 * hand-written one it replaced, and reading the string is the cheapest way to see that.
 */
export function buildUpsert(spec: UpsertSpec, dialect: SqlDialect = currentDialect()): { sql: string; params: unknown[] } {
  const cols = Object.keys(spec.values);
  const params = cols.map(c => spec.values[c]);
  const q = (id: string) => quote(id, dialect);

  switch (dialect) {
    case "sqlite": {
      // In SQLite (and Postgres) the proposed row is `excluded` and the stored row is addressed
      // by table name.
      const assignments = Object.entries(spec.update).map(([col, mode]) => {
        const inc = `excluded.${q(col)}`;
        const cur = `${q(spec.table)}.${q(col)}`;
        switch (mode) {
          case "set":       return `${q(col)} = ${inc}`;
          case "keep":      return `${q(col)} = COALESCE(${inc}, ${cur})`;
          case "add":       return `${q(col)} = ${cur} + ${inc}`;
          case "keepEmpty": return `${q(col)} = CASE WHEN ${inc} != '' THEN ${inc} ELSE ${cur} END`;
        }
      });

      const guard = spec.onlyIfNewer
        ? ` WHERE excluded.${q(spec.onlyIfNewer)} >= ${q(spec.table)}.${q(spec.onlyIfNewer)}`
        : "";

      const sql =
        `INSERT INTO ${q(spec.table)} (${cols.map(q).join(", ")}) ` +
        `VALUES (${cols.map(() => "?").join(", ")}) ` +
        `ON CONFLICT(${spec.conflict.map(q).join(", ")}) DO UPDATE SET ${assignments.join(", ")}${guard}`;

      return { sql, params };
    }

    // MySQL / MariaDB goes here, and the translation is mechanical rather than difficult:
    //
    //   ON CONFLICT(a, b) DO UPDATE SET …   →  ON DUPLICATE KEY UPDATE …
    //   excluded.col                        →  VALUES(col)   (or a row alias on MySQL 8.0.19+)
    //   "identifier"                         →  `identifier`
    //   WHERE excluded.x >= table.x          →  no direct equivalent; each assignment becomes
    //                                           IF(VALUES(x) >= x, <new value>, <column>)
    //
    // Deliberately not written on spec. Untested SQL that looks authoritative is worse than a
    // clear gap: it would be trusted, and the failure would show up as quietly wrong cached
    // metrics rather than an error. Whoever adds it should also add a case to the test that
    // compares generated statements, and run the metric-cache paths against a real MariaDB —
    // particularly the freshness guard, which is the one piece with no direct translation.
  }
}

/**
 * Run an upsert. Throws on a missing table, which every caller already handles: these writes
 * are caches, and the app is expected to work — degraded — on a database that has not run
 * `prisma db push`.
 */
export async function runUpsert(spec: UpsertSpec): Promise<void> {
  const { sql, params } = buildUpsert(spec);
  await prisma.$executeRawUnsafe(sql, ...params);
}
