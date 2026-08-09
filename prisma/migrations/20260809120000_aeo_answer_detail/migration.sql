-- AI Visibility (AEO Tracker): keep the evidence, not just the verdict.
--
-- A stored "cited = 0" could not be argued with — when it disagreed with what the user saw in
-- ChatGPT there was no answer text, no citation list and no record of which model ran, so the
-- only available conclusion was "the tool is broken". These columns are what makes a check
-- inspectable after the fact.

-- AlterTable
ALTER TABLE "AeoCheck" ADD COLUMN "status" TEXT;
ALTER TABLE "AeoCheck" ADD COLUMN "rank" INTEGER;
ALTER TABLE "AeoCheck" ADD COLUMN "model" TEXT;
ALTER TABLE "AeoCheck" ADD COLUMN "searched" BOOLEAN;
ALTER TABLE "AeoCheck" ADD COLUMN "answerText" TEXT;
ALTER TABLE "AeoCheck" ADD COLUMN "citations" TEXT;

-- Backfill the verdict for rows written before the three-state status existed. There is no
-- answer text for them, so "mentioned" is unrecoverable — every old non-citation becomes
-- "absent", which is what the UI showed at the time anyway.
UPDATE "AeoCheck" SET "status" = CASE WHEN "cited" = 1 THEN 'cited' ELSE 'absent' END WHERE "status" IS NULL;

-- AlterTable
-- Per-site check settings. Nullable country/city mean "ask without a location" — a deliberate
-- choice, not an unset value to be guessed at. aeoAuto defaults off: these checks spend the
-- user's own AI credits, so the background scheduler waits to be invited.
ALTER TABLE "Site" ADD COLUMN "aeoModel" TEXT;
ALTER TABLE "Site" ADD COLUMN "aeoCountry" TEXT;
ALTER TABLE "Site" ADD COLUMN "aeoCity" TEXT;
ALTER TABLE "Site" ADD COLUMN "aeoLanguage" TEXT;
ALTER TABLE "Site" ADD COLUMN "aeoAuto" BOOLEAN NOT NULL DEFAULT false;
