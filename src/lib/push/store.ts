// N10 — PushSubscription storage (docs/tasks/wave-nov/N10-pwa-push.md). The Prisma half of
// src/lib/push: every rule about WHAT a delivery attempt means for a row lives in
// subscription.ts (pure); this file only reads and writes.
//
// An instance that pulled the code but has not run `prisma db push` gets `notMigrated`
// answers, never a 500 — the schemaMissing() convention from src/lib/drops/store.ts.

import { prisma } from "@/lib/prisma";
import type { NotifyEvent } from "@/lib/notify/types";
import { hostnameOf, parseEventsFilter } from "./payload";
import { outcomeForAttempt } from "./subscription";

export interface PushSubRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
  events: string;       // comma-separated NotifyEvent; "" = all
  failures: number;
  lastOkAt: Date | null;
  createdAt: Date;
}

type DbRow = {
  id: string; userId: string; endpoint: string; p256dh: string; auth: string;
  userAgent: string; events: string; failures: number; lastOkAt: Date | null; createdAt: Date;
};

const toRow = (r: DbRow): PushSubRow => ({
  id: r.id, userId: r.userId, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth,
  userAgent: r.userAgent, events: r.events, failures: r.failures,
  lastOkAt: r.lastOkAt ?? null, createdAt: r.createdAt,
});

/** PushSubscription/InstanceSetting missing on this instance (prisma db push not run). */
export function pushSchemaMissing(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | undefined;
  return (
    value?.code === "P2021" ||
    /(?:PushSubscription|InstanceSetting).*(?:does not exist|no such table)/i.test(String(value?.message ?? ""))
  );
}

export function eventsToCsv(events: NotifyEvent[]): string {
  return events.join(",");
}

export function csvToEvents(csv: string): NotifyEvent[] {
  return parseEventsFilter(csv) as NotifyEvent[];
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listUserSubscriptions(userId: string): Promise<PushSubRow[]> {
  try {
    const rows = await prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRow);
  } catch (e) {
    if (pushSchemaMissing(e)) return [];
    throw e;
  }
}

/**
 * The push fan-out audience: the owner plus every accepted member. Each subscription is one
 * person's phone with its own event filter — notifyUserDetailed applies that filter per row.
 */
export async function listWorkspaceSubscriptions(ownerId: string): Promise<PushSubRow[]> {
  const recipients = await workspaceRecipientIds(ownerId);
  if (!recipients.length) return [];
  try {
    const rows = await prisma.pushSubscription.findMany({
      where: { userId: { in: recipients } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRow);
  } catch (e) {
    if (pushSchemaMissing(e)) return [];
    throw e;
  }
}

/** Owner + bound, accepted member accounts. Same access rule as resolveWorkspace(). */
export async function workspaceRecipientIds(ownerId: string): Promise<string[]> {
  const ids = new Set<string>([ownerId]);
  try {
    const rows = await (prisma as unknown as { membership?: { findMany(args: unknown): Promise<{ userId: string | null; status: string }[]> } })
      .membership?.findMany({ where: { ownerId, status: "active", userId: { not: null } }, select: { userId: true, status: true } });
    for (const row of rows ?? []) if (row.userId) ids.add(row.userId);
  } catch {
    // No Membership table — an un-migrated instance has no members by definition.
  }
  return [...ids];
}

/** Portfolio sites for the alert → /site/<id> link (see payload.matchSiteDomain). */
export async function workspaceSiteDomains(ownerId: string): Promise<{ id: string; domain: string }[]> {
  try {
    const rows = await prisma.site.findMany({
      where: { userId: ownerId },
      select: { id: true, url: true },
    });
    return rows.map(r => ({ id: r.id, domain: hostnameOf(r.url) }));
  } catch {
    return []; // sites predate this feature only in tests; an alert link is best-effort
  }
}

/** The channelViews row data: how many devices, when the last one accepted a push. */
export async function pushChannelSummary(ownerId: string): Promise<{ count: number; lastOkAt: string | null }> {
  const subs = await listWorkspaceSubscriptions(ownerId);
  const lastOk = subs.reduce<Date | null>((acc, s) => (!s.lastOkAt ? acc : !acc || s.lastOkAt > acc ? s.lastOkAt : acc), null);
  return { count: subs.length, lastOkAt: lastOk ? lastOk.toISOString() : null };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export interface SubscribeInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  events?: NotifyEvent[];
}

/** Upsert by endpoint: re-subscribing the same browser refreshes its keys and filter. */
export async function upsertSubscription(input: SubscribeInput): Promise<PushSubRow> {
  const data = {
    userId: input.userId,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: (input.userAgent ?? "").slice(0, 300),
    events: eventsToCsv(input.events ?? []),
  };
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { endpoint: input.endpoint, ...data },
    update: data,
  });
  return toRow(row);
}

export async function deleteSubscription(userId: string, endpoint: string): Promise<boolean> {
  const r = await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
  return r.count > 0;
}

export async function updateSubscriptionEvents(userId: string, endpoint: string, events: NotifyEvent[]): Promise<PushSubRow | null> {
  // updateMany keyed on BOTH endpoint and userId: a member must not retarget another
  // person's phone by POSTing their endpoint.
  const r = await prisma.pushSubscription.updateMany({
    where: { endpoint, userId },
    data: { events: eventsToCsv(events) },
  }).catch(() => null);
  if (!r || r.count === 0) return null;
  const row = await prisma.pushSubscription.findUnique({ where: { endpoint } });
  return row ? toRow(row) : null;
}

/**
 * Apply one delivery attempt: reset on success, delete on 404/410 or the 5th consecutive
 * failure, otherwise count one failure. Returns what happened, for logs and tests.
 */
export async function markAttempt(row: PushSubRow, ok: boolean, statusCode?: number | null): Promise<"ok" | "failure" | "deleted"> {
  const decision = outcomeForAttempt({ ok, statusCode, failures: row.failures });
  if (decision.action === "mark_ok") {
    await prisma.pushSubscription.update({ where: { id: row.id }, data: { failures: 0, lastOkAt: new Date() } });
    return "ok";
  }
  if (decision.action === "delete") {
    await prisma.pushSubscription.deleteMany({ where: { id: row.id } });
    return "deleted";
  }
  await prisma.pushSubscription.update({ where: { id: row.id }, data: { failures: row.failures + 1 } });
  return "failure";
}
