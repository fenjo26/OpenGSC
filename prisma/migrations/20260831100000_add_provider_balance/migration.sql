-- Balances and quotas per provider, as the provider's own counters report them. Read by the
-- balances page and the balance_low alert; written only by the balance refresh, never on
-- page load. Values are in the provider's own billing unit.
CREATE TABLE "ProviderBalance" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "left" DOUBLE PRECISION,
    "limit" DOUBLE PRECISION,
    "resetAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderBalance_pkey" PRIMARY KEY ("userId","provider")
);
