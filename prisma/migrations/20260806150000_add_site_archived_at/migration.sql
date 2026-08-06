-- AlterTable
-- Set when Google's sites.list stops returning a property (removed from Search Console,
-- verification lapsed, or the domain was replaced). Nullable because null is the normal
-- state: archiving is soft on purpose, so a replaced domain leaves the dashboard while its
-- metrics, audits and keywords stay queryable. The next sync clears it if Google returns
-- the property again.
ALTER TABLE "Site" ADD COLUMN "archivedAt" DATETIME;

-- CreateIndex
-- Every live-site read is now `where userId = ? and archivedAt is null`, including the
-- schedulers that run unattended.
CREATE INDEX "Site_userId_archivedAt_idx" ON "Site"("userId", "archivedAt");
