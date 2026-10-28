// After a scheduled GSC sync: count consecutive failures and tell Telegram once.
//
// Manual syncs do not come through here. A click on the dashboard must not reset the
// streak, and it must not send the daily alert. The state lives in User.syncSettings
// next to the schedule, so it survives a restart without a second table.

import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { rawQuery } from "@/lib/db/raw";
import { getSyncSchedule, saveSyncSchedule, type SyncHealthState } from "@/lib/syncSchedule";
import {
  formatSyncFailureAlert,
  formatSyncRecoveryAlert,
  nextSyncHealth,
  normalizeAlertLang,
  scheduledRunFailed,
  summarizeSyncFailure,
  type SyncErrorLike,
  type SyncFailureKind,
} from "@/lib/gscSyncHealth";

type RunLike = {
  accountErrors?: SyncErrorLike[] | null;
  siteErrors?: (SyncErrorLike & { site?: string })[] | null;
};

async function langFor(userId: string) {
  try {
    const rows = await rawQuery<{ alertSettings?: string | null }[]>(
      `SELECT alertSettings FROM "User" WHERE id = ?`,
      userId,
    );
    const raw = rows?.[0]?.alertSettings;
    if (!raw) return normalizeAlertLang(undefined);
    return normalizeAlertLang(JSON.parse(raw).lang);
  } catch {
    return normalizeAlertLang(undefined);
  }
}

function hostOf(url: string): string {
  return url
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

async function sitesFor(userId: string, named: string[]): Promise<string[]> {
  if (named.length > 0) return named;
  try {
    const rows = await prisma.site.findMany({
      where: { userId, archivedAt: null },
      select: { url: true },
      take: 30,
    });
    return rows.map(r => hostOf(r.url));
  } catch {
    return [];
  }
}

/**
 * Record this scheduled run and, if it is the second failure in a row, send one alert.
 * A failed send leaves `alerted` false so the next failure of the same streak tries
 * again — the user never saw the first attempt, so that is not a second message.
 */
export async function noteScheduledSyncResult(userIds: string[], result: RunLike): Promise<void> {
  const failed = scheduledRunFailed(result);
  const summary = summarizeSyncFailure(result);
  const kind: SyncFailureKind = summary.failureKind ?? "other";

  for (const userId of new Set(userIds)) {
    try {
      const current = await getSyncSchedule(userId);
      const prev: SyncHealthState = current.syncHealth ?? { consecutiveFailures: 0, alerted: false };
      const step = nextSyncHealth(prev, failed);
      let health = step.health;

      if (step.sendAlert) {
        const lang = await langFor(userId);
        const sites = await sitesFor(userId, summary.sites);
        const text = formatSyncFailureAlert(lang, {
          sites,
          kind,
          consecutive: health.consecutiveFailures,
        });
        console.log(`[sync-cron] gsc-sync-alert user=${userId}\n${text}`);
        const ok = await notifyUser(userId, text, { event: "alert" }).catch(err => {
          console.warn(`[sync-cron] gsc-sync-alert delivery failed for ${userId}:`, err);
          return false;
        });
        if (ok) health = { ...health, alerted: true };
        else console.warn(`[sync-cron] gsc-sync-alert not delivered for ${userId} (no channel or send failed)`);
      } else if (step.sendRecovery) {
        const lang = await langFor(userId);
        const text = formatSyncRecoveryAlert(lang);
        console.log(`[sync-cron] gsc-sync-recovered user=${userId}\n${text}`);
        await notifyUser(userId, text, { event: "alert" }).catch(err => {
          console.warn(`[sync-cron] gsc-sync recovery note failed for ${userId}:`, err);
        });
      }

      await saveSyncSchedule(userId, { ...current, syncHealth: health });
    } catch (err) {
      console.warn(`[sync-cron] could not update the sync failure streak for ${userId}:`, err);
    }
  }
}
