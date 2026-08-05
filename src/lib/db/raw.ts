// Raw SQL that runs on both databases.
//
// The app's hand-written SQL quotes identifiers the SQLite and Postgres way: `FROM "User"`. In
// MySQL a double-quoted token is a *string literal*, not an identifier, so every one of those
// statements is a syntax error there. And because each of them sits inside a try/catch that
// returns an empty result — deliberately, so an instance that hasn't run `prisma db push`
// degrades instead of crashing — MySQL didn't produce errors. It produced silence: Telegram and
// Slack settings that never save, alerts that never fire, an MCP token that never authenticates.
//
// So identifiers are rewritten to backticks on MySQL, in one place, rather than being spelled
// per dialect at ninety-odd call sites. Going through `rawQuery`/`rawExec` instead of
// `prisma.$queryRawUnsafe` directly is what makes that possible, and a grep for the Prisma
// methods is enough to find anything that skipped the wrapper.

import { prisma } from "@/lib/prisma";

/**
 * Which SQL dialect to emit.
 *
 * Derived from `DATABASE_URL` rather than from a setting of its own, because two places that can
 * disagree about which database this is would be a worse failure than not being configurable:
 * the connection would succeed and the statements would be wrong.
 *
 * It lives here rather than in upsert.ts, where it started, because the upsert builder now goes
 * through `rawExec` — leaving it there would make the two modules import each other.
 */
export type SqlDialect = "sqlite" | "mysql";

export function currentDialect(): SqlDialect {
  const url = process.env.DATABASE_URL ?? "";
  return /^mysql:/i.test(url) || /^mariadb:/i.test(url) ? "mysql" : "sqlite";
}

/**
 * Rewrite `"identifier"` to `` `identifier` `` for MySQL, leaving string literals alone.
 *
 * The literal-skipping is not decoration. `strftime('%Y-%m-%d', "date")` mixes both kinds of
 * quote in one statement, and a plain regex would happily rewrite the inside of the format
 * string. Single quotes open a literal, a doubled '' inside one is an escaped quote and does not
 * close it — the same rule SQLite and MySQL both follow.
 */
export function portableSql(sql: string, dialect = currentDialect()): string {
  if (dialect !== "mysql") return sql;

  let out = "";
  let inLiteral = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inLiteral) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += sql[++i]; continue; } // escaped quote, still inside
        inLiteral = false;
      }
      continue;
    }

    if (ch === "'") { inLiteral = true; out += ch; continue; }

    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end === -1) { out += ch; continue; } // unbalanced — leave it exactly as written
      out += "`" + sql.slice(i + 1, end) + "`";
      i = end;
      continue;
    }

    out += ch;
  }

  return out;
}

/** `prisma.$queryRawUnsafe` with identifiers quoted for the database actually in use. */
export function rawQuery<T = unknown>(sql: string, ...params: unknown[]): Promise<T> {
  return prisma.$queryRawUnsafe<T>(portableSql(sql), ...params);
}

/** `prisma.$executeRawUnsafe` with identifiers quoted for the database actually in use. */
export function rawExec(sql: string, ...params: unknown[]): Promise<number> {
  return prisma.$executeRawUnsafe(portableSql(sql), ...params);
}
