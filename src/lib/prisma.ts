import { PrismaClient } from '@/generated/prisma'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

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

  const mod = requireMariaDbAdapter();
  const Adapter = mod.PrismaMariaDb ?? mod.default;
  if (typeof Adapter !== "function") {
    throw new Error("@prisma/adapter-mariadb loaded but exports no PrismaMariaDb constructor.");
  }
  // The constructor takes either a mariadb PoolConfig or the connection string; the string form
  // is what DATABASE_URL already is.
  return new Adapter(url);
}

/**
 * Load the adapter with Node's resolver rather than the bundler's.
 *
 * Hiding the name from static analysis (above) also hides it from the bundler's runtime, and the
 * two are the same `require` inside a compiled chunk. Turbopack's throws
 *
 *   Cannot find module as expression is too dynamic
 *
 * for any non-literal specifier, installed or not, so a plain `require(pkg)` here reports the
 * adapter as missing on a machine that has it — which is what `npm run build` did, seconds after
 * `prisma db push` had used the very same package. `createRequire` returns the real Node
 * `require`, which looks at node_modules on disk and knows nothing about the chunk graph.
 *
 * Two bases. `import.meta.url` is rewritten to this file's own source path and is what resolves
 * in practice — `next build`, `next start` and the Docker image all keep the tree intact. cwd is
 * a fallback for layouts that run compiled output away from the sources.
 *
 * The failure text is deliberately not a bare "not installed" any more. That claim was wrong in
 * the one case that actually happened, and a wrong diagnosis sends people to reinstall a package
 * they already have; the underlying resolver errors are appended so the next unexpected failure
 * mode reads as itself.
 */
function requireMariaDbAdapter() {
  const pkg = ["@prisma", "adapter-mariadb"].join("/");
  const bases = [import.meta.url, pathToFileURL(join(process.cwd(), "noop.js")).href];
  const failures: string[] = [];

  for (const base of bases) {
    try {
      return createRequire(base)(pkg);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  throw new Error(
    "DATABASE_URL points at MySQL/MariaDB but @prisma/adapter-mariadb could not be loaded. " +
    "If it is not installed, run `npm install @prisma/adapter-mariadb`. Note that MySQL support " +
    "is still incomplete — prisma/schema.prisma is fixed to the sqlite provider.\n" +
    failures.map(f => `  - ${f}`).join("\n"),
  );
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
