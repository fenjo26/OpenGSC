-- Last time this property's Search Console sync succeeded.
-- The dashboard staleness badge reads this column. It must not use the newest
-- DailyMetric date: GSC data lags 2–3 days, so that date would warn every healthy day.
ALTER TABLE "Site" ADD COLUMN "lastGscSyncAt" DATETIME;
