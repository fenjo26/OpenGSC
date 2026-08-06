-- CreateTable
-- Learned per (host, endpoint, field): whether this API host actually returns the column.
-- Only `supported = 0` changes behaviour — it suppresses the field and drops its price surcharge.
CREATE TABLE "GatewayFieldSupport" (
    "host" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "supported" INTEGER NOT NULL DEFAULT 1,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("host", "endpoint", "field")
);
