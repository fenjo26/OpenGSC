import { NextResponse } from 'next/server';
import { workspaceUserId } from "@/lib/team/workspace";
import { runGscSync, isSyncInProgress, getLastSyncResult, getSyncStartedAt } from '@/lib/gscSync';
import { getSyncSchedule } from '@/lib/syncSchedule';
import { summarizeSyncFailure } from '@/lib/gscSyncHealth';

export async function GET() {
    const workspaceId = await workspaceUserId();
  if (!workspaceId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = getLastSyncResult();

  // `lastSyncResult` is a module variable, so a restart or a deploy forgets a sync that really
  // happened. The database remembers both the last success and the last outcome (including a
  // revoked token), so a refresh the next morning still says the authorization is dead
  // instead of painting the failed run as a fresh success.
  const userId = workspaceId;
  const schedule = userId ? await getSyncSchedule(userId) : null;
  const persistedSuccess = schedule?.lastCompletedAt ?? null;
  const persisted = schedule?.lastOutcome ?? null;
  const memoryFresh = !!result.completedAt;
  const summary = memoryFresh ? summarizeSyncFailure(result) : null;
  const accountErrors = memoryFresh ? result.accountErrors.length : (persisted?.accountErrors ?? 0);
  const siteErrors = memoryFresh ? result.siteErrors.length : (persisted?.siteErrors ?? 0);
  const needsReauth = memoryFresh ? !!summary?.needsReauth : !!persisted?.needsReauth;
  const failureKind = memoryFresh
    ? ((accountErrors > 0 || siteErrors > 0) ? summary?.failureKind ?? null : null)
    : (persisted?.failureKind ?? null);
  const sitesSynced = memoryFresh ? result.sitesSynced : (persisted?.sitesSynced ?? 0);
  const completedAt = memoryFresh ? result.completedAt : (persisted?.at ? new Date(persisted.at) : (persistedSuccess ? new Date(persistedSuccess) : null));
  return NextResponse.json({
    syncing: isSyncInProgress(),
    // Lets a page opened mid-run pick the spinner back up, and lets it say how long the run has
    // been going instead of spinning mutely.
    startedAt: getSyncStartedAt(),
    // Only a run with no account or site errors. The button's "last sync" time reads this,
    // so a revoked token cannot make the data look newer than it is.
    lastSuccessAt: persistedSuccess,
    lastResult: completedAt ? {
      sitesSynced,
      sitesArchived: memoryFresh ? result.sitesArchived : 0,
      sitesRestored: memoryFresh ? result.sitesRestored : 0,
      needsReauth,
      accountErrors,
      siteErrors,
      failureKind,
      completedAt,
    } : null,
  });
}

export async function POST() {
    const workspaceId = await workspaceUserId("act");
  if (!workspaceId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (isSyncInProgress()) {
    return NextResponse.json({ started: false, message: 'Already in progress' });
  }

  // Fire-and-forget: respond immediately, sync runs in background
  setImmediate(() => {
    runGscSync().catch((err) => console.error('[GSC Sync] Background error:', err));
  });

  return NextResponse.json({ started: true, message: 'Sync started' });
}
