import "dotenv/config";
import { defineConfig, env } from "prisma/config";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Which schema file the Prisma CLI works from.
 *
 * The datasource provider cannot be an environment variable — Prisma rejects it outright:
 *
 *   error: A datasource must not use the env() function in the provider argument.
 *
 * So pointing DATABASE_URL at MySQL was not enough on its own: you also had to edit
 * `provider = "sqlite"` by hand, and that edit lived in a tracked file, so every `git pull` —
 * and `update.sh`, which runs `git reset --hard` — silently put it back. The symptom is not an
 * obvious one either. `prisma generate` happily rebuilds the client for SQLite, and the app then
 * fails at boot with "the driver adapter is not compatible with the provider", which reads like
 * an adapter problem rather than a file that was reverted underneath you.
 *
 * This config is TypeScript and runs before the CLI reads anything, which is the one place that
 * knows both the connection string and the schema. For MySQL it derives a copy of the schema
 * with the provider swapped and hands the CLI that instead.
 *
 * The copy sits next to the original rather than in a subdirectory on purpose: `output` in the
 * generator block is resolved relative to the schema file, so a copy one level deeper would
 * quietly generate the client into the wrong place. It is gitignored, and rewritten from the
 * real schema on every CLI invocation, so it cannot drift.
 */
const BASE_SCHEMA = "prisma/schema.prisma";
const MYSQL_SCHEMA = "prisma/schema.mysql.prisma";

function schemaForDatabase(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!/^(mysql|mariadb):/i.test(url)) return BASE_SCHEMA;

  const source = readFileSync(BASE_SCHEMA, "utf8");

  // Someone who edited the provider by hand before this existed already has the file this would
  // produce. Deriving a copy of it would work, but using theirs directly means `git status` keeps
  // showing them the edit they made, instead of a second file quietly shadowing it.
  if (/provider\s*=\s*"mysql"/.test(source)) return BASE_SCHEMA;

  const swapped = source.replace(/provider(\s*)=(\s*)"sqlite"/, 'provider$1=$2"mysql"');
  if (swapped === source) {
    // Failing loudly beats generating a SQLite client for a MySQL database, which surfaces much
    // later and much less clearly.
    throw new Error(
      `DATABASE_URL points at MySQL but no \`provider = "sqlite"\` line was found in ${BASE_SCHEMA}.`,
    );
  }

  writeFileSync(
    MYSQL_SCHEMA,
    "// GENERATED — do not edit. Derived from schema.prisma by prisma.config.ts because\n" +
    "// DATABASE_URL points at MySQL and Prisma forbids env() in the provider field.\n" +
    "// Rewritten on every Prisma CLI run; edit schema.prisma instead.\n\n" +
    swapped,
  );
  return MYSQL_SCHEMA;
}

export default defineConfig({
  schema: schemaForDatabase(),
  datasource: {
    url: env("DATABASE_URL"),
  },
});
