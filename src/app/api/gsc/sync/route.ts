import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { workspaceUserId } from "@/lib/team/workspace";
import { runGscSync, isSyncInProgress, getLastSyncResult, getSyncStartedAt } from '@/lib/gscSync';
import { getSyncSchedule } from '@/lib/syncSchedule';

export async function GET() {
    const workspaceId = await workspaceUserId();
  if (!workspaceId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = getLastSyncResult();

  // `lastSyncResult` is a module variable, so a restart or a deploy forgets a sync that really
  // happened. The database remembers it, so fall back to that rather than telling the user their
  // data is older than it is.
  const userId = workspaceId;
  const persisted = userId ? (await getSyncSchedule(userId)).lastCompletedAt ?? null : null;
  const completedAt = result.completedAt ?? persisted;
  return NextResponse.json({
    syncing: isSyncInProgress(),
    // Lets a page opened mid-run pick the spinner back up, and lets it say how long the run has
    // been going instead of spinning mutely.
    startedAt: getSyncStartedAt(),
    // The counts and the error flags only exist for a run this process watched. The timestamp can
    // outlive it, so a restored one is reported with zeroes rather than being thrown away: the
    // question the label asks is "when", not "how many".
    lastResult: completedAt ? {
      sitesSynced: result.sitesSynced,
      sitesArchived: result.sitesArchived,
      sitesRestored: result.sitesRestored,
      needsReauth: result.accountErrors.some(e => e.needsReauth),
      accountErrors: result.accountErrors.length,
      siteErrors: result.siteErrors.length,
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
