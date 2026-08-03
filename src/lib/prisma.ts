import { PrismaClient } from '@/generated/prisma'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

function createPrismaClient() {
  // The fallback is a last resort, not a default worth relying on: a relative path resolves
  // against whatever directory the process happens to start in, so an unset DATABASE_URL can
  // quietly produce a second database that nothing else reads. The installer writes an absolute
  // path for exactly this reason — see docs/ARCHITECTURE.md §1.
  const rawUrl = process.env.DATABASE_URL || "file:./data/prod.db"
  // Strip "file:" prefix to get a raw file path for better-sqlite3
  const url = rawUrl.replace(/^file:/, "")

  // Which file is in use is worth being able to see, since the failure it diagnoses — writing to
  // one database and reading from another — looks exactly like "the feature does nothing".
  // Behind a flag rather than always on: it fired on every boot and on every build, in an output
  // people scan for real problems.
  if (process.env.DEBUG_PRISMA === "1") {
    console.log(`[prisma] database: ${url}`)
  }

  const adapter = new PrismaBetterSqlite3({ url })
  return new PrismaClient({ adapter })
}

export const prisma = globalForPrisma.prisma || createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
