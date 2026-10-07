// Deferred-post alerts (the plan's 7.6-3): a SCHEDULED post that hits the uniqueness block
// (or a respin failure) at send time must tell the operator, not just flip a status in a
// table — the planning happened hours or days earlier, nobody is watching the posts page.
//
// Same shape as lib/serpmon/alerts.ts, the most recent precedent: text rendered through
// notifyI18n in the user's alert language, stored as an AlertEvent row first (unique
// dedupeKey = a repeat of the same event is a silent no-op), then delivered, then marked
// sent. Dedupe is one alert per SITE per DAY: five posts of one site blocking on the same
// day is one piece of news about that site's content, not five.
//
// Immediate publishes do NOT alert — their outcome is in the HTTP response the operator is
// looking at. Only the scheduler calls this.

import { prisma } from "@/lib/prisma";
import { getAlertSettings } from "@/lib/alertScheduler";
import { notifyUser } from "@/lib/notify";
import { NOTIFY_L, normalizeLang } from "@/lib/notifyI18n";

const isoDay = () => new Date().toISOString().slice(0, 10);

/**
 * Fire the publish_blocked alert. `reason` is the post row's error verbatim (the gate's
 * blockedError already names the twin post and the similarity; a respin failure names the
 * provider's own error) — the message invents nothing beyond it. Never throws: a dead
 * channel must not fail the scheduler tick that is mid-send.
 */
export async function notifyDeferredPostBlocked(
  userId: string,
  site: { id: string; label: string },
  post: { title: string },
  reason: string,
): Promise<void> {
  try {
    const settings = await getAlertSettings(userId);
    if (!settings.publishBlocked.on) return;
    const L = NOTIFY_L[normalizeLang(settings.lang)];
    const text = `${L.publishBlockedTitle(site.label)}\n\n${L.publishBlockedMsg(post.title, reason)}`;
    // Split back into title/message for the AlertEvent row — get_alerts (MCP) and the alerts
    // panel read them as separate fields; delivery joins them back into exactly `text`.
    const nl = text.indexOf("\n");
    const title = nl < 0 ? text : text.slice(0, nl);
    const message = nl < 0 ? "" : text.slice(nl + 1).trimStart();
    const dedupeKey = `publish_blocked:${site.id}:${isoDay()}`;
    try {
      await prisma.alertEvent.create({ data: { userId, type: "publish_blocked", siteId: site.id, title, message, dedupeKey } });
    } catch {
      return; // duplicate — this site already alerted today
    }
    const ok = await notifyUser(userId, text);
    if (ok) await prisma.alertEvent.updateMany({ where: { userId, dedupeKey }, data: { sent: true } });
  } catch (e) {
    // Half-migrated tables or a dead channel are not reasons to fail the send loop.
    console.warn("[publish-alert] failed:", e);
  }
}
