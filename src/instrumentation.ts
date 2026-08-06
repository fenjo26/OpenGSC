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
    // The only scheduler here that can spend money, so it is also the only one that does nothing
    // until a user turns it on and gives it a budget of its own.
    const { startWarmupScheduler } = await import('@/lib/warmupScheduler');
    startWarmupScheduler();
  }
}
