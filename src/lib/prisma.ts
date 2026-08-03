import { PrismaClient } from '@/generated/prisma'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

/**
 * Pick the driver adapter from the connection string.
 *
 * MariaDB is loaded dynamically and is not a dependency of this project: an install that uses
 * SQLite — which is every install today — should not download a MySQL driver it will never
 * construct. The error when it is missing says what to run, because "cannot find module" on a
 * package the user never asked for is a confusing way to learn that a feature is opt-in.
 *
 * Note the schema still says `provider = "sqlite"`, and Prisma refuses `env()` there, so
 * pointing DATABASE_URL at MySQL is not yet enough to run on it. This function is here so the
 * remaining gap is one file rather than two.
 *
 * The module name is assembled at runtime rather than written as a literal. A `try/catch` is
 * enough to survive a missing package while the process runs, but it does nothing at build
 * time: the bundler still resolves every literal it can see, and reports the absent optional
 * dependency as "Module not found" on every build. Hiding the string from static analysis is
 * the difference between an optional dependency and a permanent build warning.
 */
function createAdapter(url: string, isMysql: boolean) {
  if (!isMysql) return new PrismaBetterSqlite3({ url });

  const pkg = ["@prisma", "adapter-mariadb"].join("/");
  const mod = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(pkg);
    } catch {
      throw new Error(
        "DATABASE_URL points at MySQL/MariaDB but @prisma/adapter-mariadb is not installed. " +
        "Run `npm install @prisma/adapter-mariadb`. Note that MySQL support is still incomplete — " +
        "prisma/schema.prisma is fixed to the sqlite provider.",
      );
    }
  })();
  const Adapter = mod.PrismaMariaDb ?? mod.default;
  return new Adapter(url);
}

function createPrismaClient() {
  // The fallback is a last resort, not a default worth relying on: a relative path resolves
  // against whatever directory the process happens to start in, so an unset DATABASE_URL can
  // quietly produce a second database that nothing else reads. The installer writes an absolute
  // path for exactly this reason — see docs/ARCHITECTURE.md §1.
  const rawUrl = process.env.DATABASE_URL || "file:./data/prod.db"
  const isMysql = /^(mysql|mariadb):/i.test(rawUrl)
  // Strip "file:" prefix to get a raw file path for better-sqlite3. A MySQL URL is passed
  // through untouched — the driver wants the whole connection string.
  const url = isMysql ? rawUrl : rawUrl.replace(/^file:/, "")

  // Which file is in use is worth being able to see, since the failure it diagnoses — writing to
  // one database and reading from another — looks exactly like "the feature does nothing".
  // Behind a flag rather than always on: it fired on every boot and on every build, in an output
  // people scan for real problems.
  if (process.env.DEBUG_PRISMA === "1") {
    console.log(`[prisma] database: ${url}`)
  }

  const adapter = createAdapter(url, isMysql)
  return new PrismaClient({ adapter })
}

export const prisma = globalForPrisma.prisma || createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
