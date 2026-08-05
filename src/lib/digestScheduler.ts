// Digest scheduler — hourly tick (same in-process pattern as alert-cron). For every user
// with digests enabled + Telegram connected, sends the digest when the configured hour
// arrives: daily = every day at hourUtc, weekly = Mondays at hourUtc. lastSentAt inside
// digestSettings prevents double sends across ticks/restarts.

import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { buildDigest, aiSummary, getDigestSettings, saveDigestSettings } from "@/lib/digest";
import type { NotifyLang } from "@/lib/notifyI18n";
import { rawQuery } from "@/lib/db/raw";

const TICK_MS = 60 * 60 * 1000;

export async function sendDigestNow(userId: string, tag: string, days: number, ai: boolean, lang: NotifyLang = "en"): Promise<{ content: string; sent: boolean }> {
  const { content } = await buildDigest(userId, tag, days, lang);
  let full = content;
  if (ai) {
    const summary = await aiSummary(userId, content, lang);
    if (summary) full = `${content}\n\n${summary}`;
  }
  const sent = await notifyUser(userId, full);
  
  let sentToVal: string | null = null;
  if (sent) {
    const creds = await rawQuery<any[]>(`SELECT telegramBotToken, telegramChatId, slackWebhook FROM "User" WHERE id = ?`, userId).then(rows => rows?.[0]).catch(() => null);
    const hasTg = !!(creds?.telegramBotToken && creds?.telegramChatId);
    const hasSlack = !!creds?.slackWebhook;
    if (hasTg && hasSlack) sentToVal = "telegram, slack";
    else if (hasTg) sentToVal = "telegram";
    else if (hasSlack) sentToVal = "slack";
  }

  await prisma.digest.create({
    data: { userId, tag, days, content: full, sentTo: sentToVal },
  }).catch(() => {});
  return { content: full, sent };
}

async function tick() {
  let users: any[] = [];
  try {
    users = await rawQuery(
      `SELECT id, digestSettings FROM "User"
       WHERE (telegramBotToken IS NOT NULL AND telegramChatId IS NOT NULL OR slackWebhook IS NOT NULL) AND digestSettings IS NOT NULL`);
  } catch { return; } // not migrated yet

  const now = new Date();
  for (const u of users) {
    try {
      const s = await getDigestSettings(u.id);
      if (!s.enabled) continue;
      if (now.getUTCHours() !== s.hourUtc) continue;
      if (s.frequency === "weekly" && now.getUTCDay() !== 1) continue; // Mondays

      // Already sent within this scheduling window?
      const last = s.lastSentAt ? new Date(s.lastSentAt) : null;
      const windowMs = s.frequency === "daily" ? 20 * 3600_000 : 6 * 86_400_000;
      if (last && now.getTime() - last.getTime() < windowMs) continue;

      await sendDigestNow(u.id, s.tag, s.days, s.ai, s.lang);
      await saveDigestSettings(u.id, { ...s, lastSentAt: now.toISOString() });
      console.log(`[digest-cron] sent digest to user ${u.id} (tag="${s.tag}")`);
    } catch (e) {
      console.warn(`[digest-cron] user ${u.id} failed:`, e);
    }
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
