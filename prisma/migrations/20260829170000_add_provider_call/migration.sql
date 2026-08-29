-- CreateTable
-- Append-only log of outbound provider requests. Every column beyond the four facts a request
-- always has is nullable, so `prisma db push` — which is how this project applies schema on
-- deploy — adds it to a live database without touching anything that exists.
--
-- `id` is supplied by the application rather than defaulted here: the row is INSERTED when the
-- request settles and UPDATED once the caller has parsed the response, and both need to address
-- the same row without a round-trip to find out what it was called.
CREATE TABLE "ProviderCall" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT,
  "feature" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT,
  "endpoint" TEXT NOT NULL,
  "status" INTEGER NOT NULL,
  "ms" INTEGER NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "costUsd" REAL,
  "error" TEXT,
  "complete" BOOLEAN NOT NULL DEFAULT false,
  "requestBody" TEXT,
  "responseBody" TEXT
);

-- CreateIndex
-- Three read patterns: one user's recent calls, one provider's recent calls, and the retention
-- sweep. The sweep asks only "older than", and SQLite cannot use the second column of either
-- composite index for that, so the standalone index on "at" earns its place.
CREATE INDEX "ProviderCall_userId_at_idx" ON "ProviderCall"("userId", "at");
CREATE INDEX "ProviderCall_provider_at_idx" ON "ProviderCall"("provider", "at");
CREATE INDEX "ProviderCall_at_idx" ON "ProviderCall"("at");
