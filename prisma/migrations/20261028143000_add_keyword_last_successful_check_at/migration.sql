-- When a rank check last succeeded (error IS NULL). The Positions badge reads this
-- column. lastCheckedAt is not that moment: ops scripts set it to 2099-01-01 to
-- throttle the scheduler, which would paint every keyword as just-checked.
-- Backfill from the newest RankCheck that had no error so existing ranks keep
-- their real "last found" time instead of showing "not yet".
ALTER TABLE "TrackedKeyword" ADD COLUMN "lastSuccessfulCheckAt" DATETIME;

UPDATE "TrackedKeyword"
SET "lastSuccessfulCheckAt" = (
  SELECT MAX("checkedAt") FROM "RankCheck"
  WHERE "RankCheck"."keywordId" = "TrackedKeyword"."id"
    AND "RankCheck"."error" IS NULL
);
