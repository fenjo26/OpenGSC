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
// Adding a database is one branch of {@link buildUpsert}. SQLite is the only dialect any
// instance actually runs today; the MySQL branch is written but has never executed against a
// real server, and the Prisma schema cannot switch providers yet — see the note above that
// branch before relying on it.

import { rawExec, currentDialect, type SqlDialect } from "@/lib/db/raw";

// Dialect detection moved to db/raw.ts when this builder started running its statements through
// `rawExec` — keeping it here would have made the two modules import each other. Re-exported so
// the call sites that already import it from this module keep working.
export { currentDialect, type SqlDialect } from "@/lib/db/raw";

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

/** SQLite and Postgres quote identifiers with double quotes; MySQL and MariaDB use backticks. */
function quote(id: string, dialect: SqlDialect): string {
  return dialect === "mysql" ? `\`${id}\`` : `"${id}"`;
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

    // ── MySQL / MariaDB ───────────────────────────────────────────────────────────────────
    //
    // UNVERIFIED AGAINST A REAL SERVER. Every statement below is generated correctly in shape —
    // `scripts/check-upsert-sql.ts` asserts that — but no one has yet watched MySQL *execute*
    // them. Until someone has, this path should be treated as a draft rather than a feature.
    // See docs/ARCHITECTURE.md for what still has to be done around it (the schema's `provider`
    // cannot be an environment variable, so it is not switchable yet).
    //
    // Three differences from the SQLite form, the third being the only interesting one:
    //
    //   ON CONFLICT(a, b) DO UPDATE SET …  →  ON DUPLICATE KEY UPDATE …   (no conflict target;
    //                                          MySQL matches on any unique key, which is fine
    //                                          here — every spec conflicts on its primary key)
    //   excluded.col                       →  VALUES(col)
    //   WHERE excluded.x >= table.x        →  nothing. MySQL has no conditional on-duplicate
    //                                          clause at all, so the guard has to move inside
    //                                          every single assignment as an IF().
    case "mysql": {
      const v = (col: string) => `VALUES(${q(col)})`;

      const valueFor = (col: string, mode: UpsertMode): string => {
        switch (mode) {
          case "set":       return v(col);
          case "keep":      return `COALESCE(${v(col)}, ${q(col)})`;
          case "add":       return `${q(col)} + ${v(col)}`;
          case "keepEmpty": return `CASE WHEN ${v(col)} != '' THEN ${v(col)} ELSE ${q(col)} END`;
        }
      };

      const guard = spec.onlyIfNewer;

      // Assignment order is load-bearing here, and it is the easiest thing to get wrong.
      //
      // MySQL evaluates ON DUPLICATE KEY UPDATE assignments left to right, and a later
      // assignment sees the values written by earlier ones. The guard compares the incoming
      // row against the *stored* timestamp — so if the timestamp column were updated first,
      // every assignment after it would compare against the value just written and the guard
      // would always pass. Writing it last is what keeps the comparison meaningful.
      const updateCols = Object.keys(spec.update).filter(c => c !== guard);
      if (guard && guard in spec.update) updateCols.push(guard);

      const assignments = updateCols.map(col => {
        const next = valueFor(col, spec.update[col]);
        return guard
          ? `${q(col)} = IF(${v(guard)} >= ${q(guard)}, ${next}, ${q(col)})`
          : `${q(col)} = ${next}`;
      });

      const sql =
        `INSERT INTO ${q(spec.table)} (${cols.map(q).join(", ")}) ` +
        `VALUES (${cols.map(() => "?").join(", ")}) ` +
        `ON DUPLICATE KEY UPDATE ${assignments.join(", ")}`;

      return { sql, params };
    }
  }
}

/**
 * Run an upsert. Throws on a missing table, which every caller already handles: these writes
 * are caches, and the app is expected to work — degraded — on a database that has not run
 * `prisma db push`.
 */
export async function runUpsert(spec: UpsertSpec): Promise<void> {
  const { sql, params } = buildUpsert(spec);
  await rawExec(sql, ...params);
}
