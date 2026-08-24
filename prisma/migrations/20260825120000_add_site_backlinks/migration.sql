-- Backlinks v2.
--
-- The existing `Backlink` table is left exactly as it is: it keeps its rows, its unique key and
-- the /api/backlinks/check-alive and /api/backlinks/check-xr endpoints that read it. This
-- migration adds beside it, and copies the old rows across so the new tab starts populated.
--
-- Why a new table instead of columns on the old one: `Backlink.isAlive` / `aliveStatus` answer
-- "does the donor page respond?". Nothing in the old schema ever answered "is our link still on
-- that page?", which is the question the money was spent on. The two answers are independent —
-- a live page with the link stripped out is the whole point — so they get two independent
-- columns, `pageStatus` and `checkStatus`, and the transfer below is careful never to fabricate
-- the second one out of the first.

-- CreateTable
CREATE TABLE "SiteBacklink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "urlFrom" TEXT NOT NULL,
    "urlFromNorm" TEXT NOT NULL,
    "urlTo" TEXT NOT NULL DEFAULT '',
    "domainFrom" TEXT NOT NULL DEFAULT '',
    "apiSeen" BOOLEAN NOT NULL DEFAULT false,
    "apiLost" BOOLEAN NOT NULL DEFAULT false,
    "apiLostReason" TEXT NOT NULL DEFAULT '',
    "apiAnchor" TEXT NOT NULL DEFAULT '',
    "apiAlt" TEXT NOT NULL DEFAULT '',
    "apiDofollow" BOOLEAN NOT NULL DEFAULT true,
    "apiNofollow" BOOLEAN NOT NULL DEFAULT false,
    "apiSponsored" BOOLEAN NOT NULL DEFAULT false,
    "apiUgc" BOOLEAN NOT NULL DEFAULT false,
    "apiContent" BOOLEAN NOT NULL DEFAULT true,
    "apiImage" BOOLEAN NOT NULL DEFAULT false,
    "apiJsCrawl" BOOLEAN NOT NULL DEFAULT false,
    "apiDr" REAL,
    "apiHttpCode" INTEGER,
    "apiLinkType" TEXT NOT NULL DEFAULT '',
    "apiSnippet" TEXT NOT NULL DEFAULT '',
    "apiFirstSeen" TEXT NOT NULL DEFAULT '',
    "apiLastSeen" TEXT NOT NULL DEFAULT '',
    "apiFetchedAt" DATETIME,
    "checkStatus" TEXT NOT NULL DEFAULT 'unchecked',
    "checkAnchor" TEXT NOT NULL DEFAULT '',
    "checkRel" TEXT NOT NULL DEFAULT '',
    "checkNofollow" BOOLEAN NOT NULL DEFAULT false,
    "checkSponsored" BOOLEAN NOT NULL DEFAULT false,
    "checkUgc" BOOLEAN NOT NULL DEFAULT false,
    "checkFoundUrl" TEXT NOT NULL DEFAULT '',
    "checkMatchedDomain" TEXT NOT NULL DEFAULT '',
    "checkTargetOk" BOOLEAN,
    "checkError" TEXT NOT NULL DEFAULT '',
    "checkInsecure" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" DATETIME,
    "pageStatus" TEXT NOT NULL DEFAULT 'unknown',
    "pageTitle" TEXT NOT NULL DEFAULT '',
    "pageCheckedAt" DATETIME,
    "xrStatus" TEXT NOT NULL DEFAULT '',
    "xrCheckedAt" DATETIME,
    "twoIndexStatus" TEXT NOT NULL DEFAULT '',
    "twoIndexAt" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'api',
    "sources" TEXT NOT NULL DEFAULT '',
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "priceNote" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SiteBacklink_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteBacklinkEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "backlinkId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL DEFAULT 'api',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SiteBacklinkSync" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'api',
    "status" TEXT NOT NULL DEFAULT 'running',
    "stage" TEXT NOT NULL DEFAULT 'pull',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "pagesPulled" INTEGER NOT NULL DEFAULT 0,
    "rowsSeen" INTEGER NOT NULL DEFAULT 0,
    "unitsSpent" INTEGER NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "paginationMode" TEXT NOT NULL DEFAULT '',
    "summary" TEXT,
    "error" TEXT,
    "heartbeatAt" DATETIME,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteBacklink_siteId_urlFromNorm_urlTo_key" ON "SiteBacklink"("siteId", "urlFromNorm", "urlTo");

-- CreateIndex
CREATE INDEX "SiteBacklink_siteId_checkStatus_idx" ON "SiteBacklink"("siteId", "checkStatus");

-- CreateIndex
CREATE INDEX "SiteBacklink_siteId_apiLost_idx" ON "SiteBacklink"("siteId", "apiLost");

-- CreateIndex
CREATE INDEX "SiteBacklink_siteId_favorite_idx" ON "SiteBacklink"("siteId", "favorite");

-- CreateIndex
CREATE INDEX "SiteBacklink_siteId_domainFrom_idx" ON "SiteBacklink"("siteId", "domainFrom");

-- CreateIndex
CREATE INDEX "SiteBacklink_siteId_addedAt_idx" ON "SiteBacklink"("siteId", "addedAt");

-- CreateIndex
CREATE INDEX "SiteBacklinkEvent_siteId_createdAt_idx" ON "SiteBacklinkEvent"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteBacklinkEvent_backlinkId_createdAt_idx" ON "SiteBacklinkEvent"("backlinkId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteBacklinkSync_siteId_startedAt_idx" ON "SiteBacklinkSync"("siteId", "startedAt");

-- DataMigration: carry the old `Backlink` rows over.
--
-- Four things in here are deliberate and should not be "tidied up" later:
--
-- 1. `checkStatus` is 'unchecked' for every single row, with no exception. The old check never
--    looked for our link, so there is no row anywhere in the old table whose placement is known.
--    Writing 'found' here — even for pages that answered 200 — would declare verified something
--    that was never verified, which is the exact bug this whole wave exists to remove.
--
-- 2. The old liveness answer lands in `pageStatus`, keeping `aliveStatus` where it exists and
--    falling back to the older boolean `isAlive` only where it does not. `isAlive IS NULL` stays
--    'unknown' rather than becoming 'dead': null there meant "not checked", and for a blocked
--    page it meant "we were refused", neither of which is a death.
--
-- 3. `id` is generated from randomblob() rather than a cuid, because SQL has no cuid and the
--    column only has to be unique and stable. The 'mig_' prefix makes rows that came from this
--    migration identifiable later without another column.
--
-- 4. `INSERT OR IGNORE`, because the new unique key is (siteId, normalized url, urlTo) while the
--    old one was (siteId, raw url). Two old rows differing only in case, scheme, `www.` or a
--    trailing slash were distinct before and are the same placement now. `ORDER BY addedAt, id`
--    makes the survivor the oldest row rather than whichever one SQLite reached first.
--
-- The normalization below is deliberately minimal — lowercase, drop #fragment, drop the scheme,
-- drop a leading `www.`, drop one trailing `/`. It exists so the unique key does not trip over
-- duplicates, not to be the canonical rule; the real normalization lives in TypeScript (T2/T3)
-- and both must agree on these five steps for a re-import to match instead of duplicating.
WITH lowered AS (
    SELECT "id" AS srcId, lower("url") AS u FROM "Backlink"
),
nofrag AS (
    SELECT srcId,
           CASE WHEN instr(u, '#') > 0 THEN substr(u, 1, instr(u, '#') - 1) ELSE u END AS u
    FROM lowered
),
noscheme AS (
    SELECT srcId,
           CASE WHEN u LIKE 'https://%' THEN substr(u, 9)
                WHEN u LIKE 'http://%'  THEN substr(u, 8)
                ELSE u END AS u
    FROM nofrag
),
nowww AS (
    SELECT srcId,
           CASE WHEN u LIKE 'www.%' THEN substr(u, 5) ELSE u END AS u
    FROM noscheme
),
norm AS (
    SELECT srcId,
           CASE WHEN length(u) > 1 AND substr(u, -1) = '/' THEN substr(u, 1, length(u) - 1)
                ELSE u END AS u
    FROM nowww
)
INSERT OR IGNORE INTO "SiteBacklink" (
    "id", "siteId", "urlFrom", "urlFromNorm", "urlTo", "domainFrom",
    "checkStatus",
    "pageStatus", "pageTitle", "pageCheckedAt",
    "xrStatus", "xrCheckedAt", "twoIndexStatus", "twoIndexAt",
    "source", "sources",
    "addedAt", "updatedAt"
)
SELECT
    'mig_' || lower(hex(randomblob(12))),
    b."siteId",
    b."url",
    n.u,
    '',
    -- everything before the first '/' of the normalized form: the donor host. Not listed in the
    -- brief's field map, but the new tab filters and groups by this column, and leaving it empty
    -- would hide every migrated row from the donor-domain filter. Derived, never guessed.
    CASE WHEN instr(n.u, '/') > 0 THEN substr(n.u, 1, instr(n.u, '/') - 1) ELSE n.u END,
    'unchecked',
    CASE
        WHEN b."aliveStatus" = 'alive'   THEN 'alive'
        WHEN b."aliveStatus" = 'dead'    THEN 'dead'
        WHEN b."aliveStatus" = 'blocked' THEN 'blocked'
        WHEN b."isAlive" = 1 THEN 'alive'
        WHEN b."isAlive" = 0 THEN 'dead'
        ELSE 'unknown'
    END,
    COALESCE(b."title", ''),
    -- same group as pageStatus, so it travels with it: a status with no timestamp renders as
    -- "never checked" next to a value that says otherwise.
    b."aliveChecked",
    COALESCE(b."xrStatus", ''),
    b."xrChecked",
    COALESCE(b."twoIndexStatus", ''),
    b."twoIndexAt",
    'manual',
    'manual',
    b."addedAt",
    b."addedAt"
FROM "Backlink" b
JOIN norm n ON n.srcId = b."id"
ORDER BY b."addedAt" ASC, b."id" ASC;
