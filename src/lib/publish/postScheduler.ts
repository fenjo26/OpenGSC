// The publish queue scheduler — sends scheduled posts (jitter spread) through the same
// per-post path as Retry. Registered from instrumentation.ts (the import is pre-wired); the
// startPublishScheduler export name is part of that contract.
//
// Tick = 2 min (inside the plan's 1–5 min band; the spread window is hours/days, so tick
// granularity contributes nothing to the jitter while keeping the loop responsive after a
// restart). Per tick, at most MAX_SENDS_PER_TICK due posts, oldest first, with a `running`
// flag against overlap: a respin inside a send can take tens of seconds, and two overlapping
// loops would double-send the same row.
//
// Respin and the uniqueness gate run at SEND time (the plan's 7.6 wording): the row was
// planned earlier with the source text; what actually ships is adapted (when planned as a
// respin) and gated (always) here, via the store's shared sendPostRow. A deferred post that
// gets BLOCKED — or whose respin fails — fires an alert through the existing alert engine
// (lib/publish/alerts.ts → AlertEvent + Telegram/Slack/etc.), not just a status change. An
// ordinary platform failure does NOT alert: it is retryable exactly like an immediate
// failure, and the posts table is its honest surface.
//
// Degrades silently before `prisma db push` (tables missing → the tick logs and retries;
// same convention as the other in-process loops).

import { prisma } from "@/lib/prisma";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { respinAtSend, sendPostRow, type PostDbRow } from "./store";
import { notifyDeferredPostBlocked } from "./alerts";

const TICK_MS = 2 * 60_000; // 2 minutes
const FIRST_TICK_MS = 45_000; // first pass shortly after boot, like the other loops
const MAX_SENDS_PER_TICK = 10; // each send may include an AI respin — the tick stays bounded

let started = false;
let running = false;

/** The tick body without the timer — exported so tests (and a future "send due now" button)
 *  exercise exactly the code the interval runs. */
export async function runPublishTick(): Promise<{ sent: number; alerted: number }> {
  const due = await prisma.publishedPost.findMany({
    where: { status: "scheduled", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: MAX_SENDS_PER_TICK,
    include: { connection: true, site: { select: { id: true, url: true, siteId: true, userId: true } } },
  });
  let sent = 0;
  let alerted = 0;
  for (const post of due) {
    try {
      // The row as it stands right now (title/markdown may be refreshed by the respin below).
      let fresh: PostDbRow = post;
      // Claim the row first: publishing → anyone re-running the tick (or a concurrent send)
      // must see it as in-flight, not as due. A crash here leaves a "publishing" row visible
      // in the table instead of a silent double-send later.
      await prisma.publishedPost.update({ where: { id: post.id }, data: { status: "publishing", error: "" } });

      // Respin half — only when the plan asked for one. Credentials resolve on the "respin"
      // task slot exactly like the immediate path; plain posts never touch AI creds at all.
      if (post.respinUsed) {
        const creds = await resolveAiCreds(post.site.userId, {}, "respin");
        if (!creds.aiApiKey) {
          const error = "no_ai_creds: configure an AI provider for the respin task (Settings → SEO Tools)";
          await prisma.publishedPost.update({ where: { id: post.id }, data: { status: "failed", error, respinUsed: false } });
          await notifyDeferredPostBlocked(
            post.site.userId,
            { id: post.site.id, label: siteLabelOf(post.site.url || post.site.siteId) },
            { title: post.title },
            error,
          );
          alerted++;
          continue;
        }
        const r = await respinAtSend(post, post.connection, post.site, creds);
        if (!r.ok) {
          await notifyDeferredPostBlocked(
            post.site.userId,
            { id: post.site.id, label: siteLabelOf(post.site.url || post.site.siteId) },
            { title: post.title },
            r.error,
          );
          alerted++;
          continue;
        }
        fresh = r.post;
      }

      // Gate + send — the same sendPostRow Retry and the immediate publish loop run.
      const updated = await sendPostRow(fresh, post.connection, post.site);
      if (updated.status === "blocked") {
        await notifyDeferredPostBlocked(
          post.site.userId,
          { id: post.site.id, label: siteLabelOf(post.site.url || post.site.siteId) },
          { title: updated.title },
          updated.error,
        );
        alerted++;
      }
      sent++;
    } catch (e) {
      // One bad row must not stall the rest of the queue. The row was already claimed as
      // "publishing"; park it as failed with the error so it is visible and retryable,
      // rather than silently re-claiming it on every future tick.
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`[publish-cron] post ${post.id} failed:`, error);
      await prisma.publishedPost
        .update({ where: { id: post.id }, data: { status: "failed", error } })
        .catch(() => undefined);
    }
  }
  return { sent, alerted };
}

function siteLabelOf(urlOrProp: string): string {
  return String(urlOrProp || "").replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").replace(/\/+$/, "");
}

export function startPublishScheduler(): void {
  if (started) return;
  started = true;
  console.log("[publish-cron] scheduler started");
  setTimeout(() => { void tick(); }, FIRST_TICK_MS);
  setInterval(() => { void tick(); }, TICK_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await runPublishTick();
    if (r.sent) console.log(`[publish-cron] sent ${r.sent} scheduled post(s), ${r.alerted} alert(s)`);
  } catch (e) {
    console.warn("[publish-cron] tick failed (tables migrated?):", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}
