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
