// Brand mentions — the daily watcher (T6). Same shape as the serpmon scheduler: runs inside
// the Next server process from instrumentation, keeps a `running` flag against overlap, and
// disables itself when the BrandMention table is missing (pulled-but-not-pushed window).
//
// Tick = 1 h. Sites eligible: mentionSettings on AND lastRunAt older than 24 h (null = never
// = immediately due). ONE site per owner per tick, oldest lastRunAt first — a workspace with
// 30 watched sites spreads its runs over ~30 hours instead of bursting 30 × 3 sources at once.
// All external work runs inside withCallContext so it lands in the provider journal.

import { prisma } from "@/lib/prisma";
import { withCallContext } from "@/lib/providerLog/context";
import { runMentions } from "./store";
import type { MentionSettings } from "./types";

const TICK_MS = 60 * 60_000;       // hourly
const FIRST_TICK_MS = 90_000;      // first pass shortly after boot, like the alert loop
const STALE_AFTER_MS = 24 * 60 * 60_000;
const MAX_SITES_PER_TICK = 10;

let started = false;
let running = false;
let kickQueued = false;
/** Set when the BrandMention table is missing — the tick stops retrying until restart. */
let disabled = false;

interface Candidate { siteDbId: string; userId: string; lastRunAt: number }

function eligible(site: { id: string; userId: string; mentionSettings: string | null }): Candidate | null {
  if (!site.mentionSettings) return null;
  let settings: Partial<MentionSettings>;
  try {
    settings = JSON.parse(site.mentionSettings);
  } catch {
    return null;
  }
  if (!settings?.on) return null;
  const lastRunAt = settings.lastRunAt ? new Date(settings.lastRunAt).getTime() : 0;
  if (Number.isFinite(lastRunAt) && Date.now() - lastRunAt < STALE_AFTER_MS) return null;
  return { siteDbId: site.id, userId: site.userId, lastRunAt };
}

async function tick(): Promise<void> {
  if (running || disabled) return;
  running = true;
  try {
    // One indexed-shaped query: mentionSettings is null for every site that never touched the
    // feature, so the where clause discards the whole portfolio in the index scan.
    const sites = await prisma.site.findMany({
      where: { mentionSettings: { not: null } },
      select: { id: true, userId: true, mentionSettings: true },
      take: 500,
    });

    // Oldest lastRunAt first, one site per owner.
    const perOwner = new Map<string, Candidate>();
    for (const site of sites) {
      const candidate = eligible(site);
      if (!candidate) continue;
      const current = perOwner.get(site.userId);
      if (!current || candidate.lastRunAt < current.lastRunAt) perOwner.set(site.userId, candidate);
    }
    const chosen = [...perOwner.values()].slice(0, MAX_SITES_PER_TICK);

    for (const c of chosen) {
      try {
        await withCallContext({ userId: c.userId, feature: "mentions-cron", captureBodies: false }, () =>
          runMentions(c.userId, c.siteDbId),
        );
      } catch (e) {
        console.warn(`[mentions-cron] run for site ${c.siteDbId} failed:`, e);
      }
    }
  } catch (e) {
    const value = e as { code?: string; message?: string };
    if (value?.code === "P2021" || /BrandMention.*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))) {
      disabled = true;
      console.warn("[mentions-cron] BrandMention table missing — scheduler disabled until restart");
      return;
    }
    console.warn("[mentions-cron] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startMentionsScheduler(): void {
  if (started) return;
  started = true;
  console.log("[mentions-cron] scheduler started");
  setTimeout(() => void tick(), FIRST_TICK_MS);
  setInterval(() => void tick(), TICK_MS);
}

/**
 * Wake the loop now — the settings route calls this after the watcher is enabled, so a fresh
 * opt-in gets its first (silent, backfilling) run within seconds instead of at the next hourly
 * tick. Coalesced: a burst of saves queues exactly one immediate tick.
 */
export function kickMentionsScheduler(): void {
  if (!started || running || disabled || kickQueued) return;
  kickQueued = true;
  setTimeout(() => {
    kickQueued = false;
    void tick();
  }, 0);
}
