-- Workspace-wide audit history (GET /api/audit without siteId).
--
-- The per-site list is served by the composite (siteId, startedAt) index. The global list has
-- no siteId to anchor on — it orders every audit of the workspace by startedAt — so without
-- this index that ordering is a fresh sort over the whole table on every open of the global
-- audits page.

-- CreateIndex
CREATE INDEX "SiteAudit_startedAt_idx" ON "SiteAudit"("startedAt");
