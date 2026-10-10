// Next.js instrumentation: runs once when the server process starts.
// We use it to start the in-app background schedulers (Clarity auto-collect,
// rank tracker position checks).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startClarityScheduler } = await import('@/lib/clarityScheduler');
    startClarityScheduler();
    const { startRankScheduler } = await import('@/lib/rankScheduler');
    startRankScheduler();
    const { startAeoScheduler } = await import('@/lib/aeoScheduler');
    startAeoScheduler();
    const { startAlertScheduler } = await import('@/lib/alertScheduler');
    startAlertScheduler();
    const { startDigestScheduler } = await import('@/lib/digestScheduler');
    startDigestScheduler();
    const { startSyncScheduler } = await import('@/lib/syncScheduler');
    startSyncScheduler();
    // The drops watch loop: re-checks rows the user marked as watched until a registry says
    // they are free, then notifies once (Telegram/Slack) and stops that watch. Free registry
    // calls only, and a tick with nothing due is a single indexed query.
    const { startDropsScheduler } = await import('@/lib/drops/scheduler');
    startDropsScheduler();
    // The monthly DR walk: one fresh Ahrefs DR point per site domain per month, so the DR
    // sparklines on the site page and dashboard have a series to draw without anyone having
    // to open every site after each cache expiry. Free public endpoint, capped per tick.
    const { startDrSiteScheduler } = await import('@/lib/seo/drSiteScheduler');
    startDrSiteScheduler();
    // SERP Monitor: resumes running checks, starts scheduled ones, then enriches new hosts.
    // A-Parser only, so no per-request bill; idle ticks are one indexed query.
    const { startSerpmonScheduler } = await import('@/lib/serpmon/scheduler');
    startSerpmonScheduler();
    // The only scheduler here that can spend money, so it is also the only one that does nothing
    // until a user turns it on and gives it a budget of its own.
    const { startWarmupScheduler } = await import('@/lib/warmupScheduler');
    startWarmupScheduler();
    // Site Audit queue + scheduler: recovers orphaned runs, drains queued orders under
    // the concurrency setting, and creates scheduled orders inside each workspace's hour.
    const { startAuditScheduler } = await import('@/lib/audit/auditScheduler');
    startAuditScheduler();
    // Uptime monitor: HTTP checks every few minutes, alerts on up→down→up transitions only.
    const { startUptimeScheduler } = await import('@/lib/uptime/scheduler');
    startUptimeScheduler();
    // Automatic URL Inspection inside Google's free per-property quota (resets at midnight PT).
    const { startIndexScheduler } = await import('@/lib/indexing/scheduler');
    startIndexScheduler();
    // Brand mentions: Google News RSS + Wikipedia/Wikidata once a day per opted-in site.
    const { startMentionsScheduler } = await import('@/lib/mentions/scheduler');
    startMentionsScheduler();
    // ─── wave-nov schedulers (CONTRACT.md §3), after the mentions block ─────────────
    // All four start as empty no-op stubs from the foundation commit; their owning tasks
    // (N2/N4/N5/N8) fill the tick bodies. Signatures follow serpmon/scheduler.ts.
    // Backlink toxicity: hourly recalculation of sites with new donors + toxic_new alerts (N2).
    const { startBacklinkToxScheduler } = await import('@/lib/backlinks/scheduler');
    startBacklinkToxScheduler();
    // The меджики loop: imports paid orders' publication URLs into SiteBacklink and re-verifies
    // placements whose last check is older than a week through the same runner the manual
    // button uses. Both halves are free and degrade silently before `db push`.
    const { startBacklinkVerifyScheduler } = await import('@/lib/backlinks/verifyScheduler');
    startBacklinkVerifyScheduler();
    // Weekly DataForSEO backlink refresh (issue #26). Spends money, so — like warmup — it does
    // nothing until a user switches it on in Settings → SEO Metrics, and stays inside their cap.
    const { startDataforseoBacklinkScheduler } = await import('@/lib/seo/dataforseoBacklinkScheduler');
    startDataforseoBacklinkScheduler();
    // ─── R+ wave schedulers (pre-wired stubs; owning agents fill the tick bodies) ────
    // Geo-grid presets: fires scheduled scans (cron matcher, high-water lastFireAt) and
    // never back-fills missed ticks — a grid run costs gridSize² queries.
    const { startGridPresetScheduler } = await import('@/lib/localGrid/presetScheduler');
    startGridPresetScheduler();
    // Publish queue: sends scheduled posts (jitter) through the per-post path, running the
    // respin gate and the uniqueness gate at send time; a blocked deferred post fires an
    // alert through the existing alert engine, not just a status change.
    const { startPublishScheduler } = await import('@/lib/publish/postScheduler');
    startPublishScheduler();
    // Local SEO: GBP posts due for publishing, reviews every 6 h, citations weekly (N4).
    const { startLocalScheduler } = await import('@/lib/local/scheduler');
    startLocalScheduler();
    // Trend radar: gsc_rising / gsc_new / suggest once a day per site (N5).
    const { startTrendsScheduler } = await import('@/lib/trends/scheduler');
    startTrendsScheduler();
    // Client reports: render + mail reports whose nextSendAt has passed, hourly (N8).
    const { startReportsScheduler } = await import('@/lib/reports/scheduler');
    startReportsScheduler();
  }
}
