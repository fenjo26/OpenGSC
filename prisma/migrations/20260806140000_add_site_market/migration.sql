-- AlterTable
-- Nullable and without a default: null means "market unknown", which is a different statement
-- from "United States". Backfill for ccTLD domains is `scripts/backfill-site-market.ts`.
ALTER TABLE "Site" ADD COLUMN "market" TEXT;
