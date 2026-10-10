// Digest scheduler — hourly tick (same in-process pattern as alert-cron). For every user
// with digests enabled + at least one notification channel that takes "digest" events,
// sends the digest when the configured hour
// arrives: daily = every day at hourUtc, weekly = Mondays at hourUtc. lastSentAt inside
// digestSettings prevents double sends across ticks/restarts.

import { prisma } from "@/lib/prisma";
import { notifyUserDetailed, deliverableChannels } from "@/lib/notify";
import { buildDigest, aiSummary, getDigestSettings, saveDigestSettings } from "@/lib/digest";
import type { NotifyLang } from "@/lib/notifyI18n";
import { rawQuery } from "@/lib/db/raw";
import { resolveCaptureBodies } from '@/lib/providerLog/bodies';
import { withCallContext } from "@/lib/providerLog/context";

const TICK_MS = 60 * 60 * 1000;

export async function sendDigestNow(userId: string, tag: string, days: number, ai: boolean, lang: NotifyLang = "en"): Promise<{ content: string; sent: boolean }> {
  const { content } = await buildDigest(userId, tag, days, lang);
  let full = content;
  if (ai) {
    const summary = await aiSummary(userId, content, lang);
    if (summary) full = `${content}\n\n${summary}`;
  }
  // sentTo lists the channels that actually accepted it ("email", "telegram, email", …).
  const deliveries = await notifyUserDetailed(userId, full, { event: "digest" });
  const okChannels = deliveries.filter(d => d.ok).map(d => d.channel);
  const sent = okChannels.length > 0;
  const sentToVal = sent ? okChannels.join(", ") : null;

  await prisma.digest.create({
    data: { userId, tag, days, content: full, sentTo: sentToVal },
  }).catch(() => {});
  return { content: full, sent };
}

async function tick() {
  let users: { id: string }[] = [];
  try {
    users = await rawQuery<{ id: string }[]>(
      `SELECT id FROM "User" WHERE digestSettings IS NOT NULL`);
    // No channel filter in SQL any more: email/Discord/Teams/webhook/push live in the
    // notifyChannels JSON, so deliverableChannels() decides per user below (issue #25).
  } catch { return; } // not migrated yet

  const now = new Date();
  for (const u of users) {
    // Around the whole per-user body, not just the send: a timer inherits no request, so every
    // call `sendDigestNow` makes on this user's behalf — the AI summary above all — would
    // otherwise be logged as nobody's.
    const captureBodies = await resolveCaptureBodies(u.id);
    await withCallContext({ userId: u.id, feature: "digest-cron", captureBodies }, async () => {
      try {
        const s = await getDigestSettings(u.id);
        if (!s.enabled) return;
        if (now.getUTCHours() !== s.hourUtc) return;
        if (s.frequency === "weekly" && now.getUTCDay() !== 1) return; // Mondays

        // Already sent within this scheduling window?
        const last = s.lastSentAt ? new Date(s.lastSentAt) : null;
        const windowMs = s.frequency === "daily" ? 20 * 3600_000 : 6 * 86_400_000;
        if (last && now.getTime() - last.getTime() < windowMs) return;

        // Nobody to deliver to → don't build (an AI summary would spend credits for nothing).
        if (!(await deliverableChannels(u.id, "digest")).length) return;

        await sendDigestNow(u.id, s.tag, s.days, s.ai, s.lang);
        await saveDigestSettings(u.id, { ...s, lastSentAt: now.toISOString() });
        console.log(`[digest-cron] sent digest to user ${u.id} (tag="${s.tag}")`);
      } catch (e) {
        console.warn(`[digest-cron] user ${u.id} failed:`, e);
      }
    });
  }
}

let started = false;
let running = false;

export function startDigestScheduler() {
  if (started) return;
  started = true;
  console.log("[digest-cron] scheduler started");
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (e) { console.warn("[digest-cron] tick failed:", e); }
    finally { running = false; }
  };
  setTimeout(run, 120_000);
  setInterval(run, TICK_MS);
}
