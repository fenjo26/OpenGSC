// N10 — pure per-subscription decisions (docs/tasks/wave-nov/N10-pwa-push.md).
// The database half lives in store.ts; these are the rules that decide what happens to a
// row, kept Prisma-free so they are testable without a client.

import type { NotifyEvent } from "@/lib/notify/types";

/**
 * A subscription's event filter is a comma-separated NotifyEvent list; "" or an unparseable
 * value means "all events" (the column default). "test" bypasses every filter — the same
 * rule eventAllowed() applies to the other channels.
 */
export function subscriptionAllows(eventsCsv: string, event: NotifyEvent): boolean {
  if (event === "test") return true;
  const csv = (eventsCsv ?? "").trim();
  if (!csv) return true;
  return csv.split(",").map(s => s.trim()).includes(event);
}

/**
 * Push services answer 404/410 when the subscription is gone for good — delete immediately.
 * Any other repeated failure is counted; five in a row means the device is not coming back
 * (app uninstalled, browser data wiped) and the row is dropped too.
 */
export const MAX_CONSECUTIVE_FAILURES = 5;

export function isGoneStatus(statusCode: number | null | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

/** What to do with the row after one delivery attempt. */
export type SubscriptionOutcome =
  | { action: "delete"; reason: "gone" | "too_many_failures" }
  | { action: "count_failure" }
  | { action: "mark_ok" };

export function outcomeForAttempt(input: { ok: boolean; statusCode?: number | null; failures: number }): SubscriptionOutcome {
  if (input.ok) return { action: "mark_ok" };
  if (isGoneStatus(input.statusCode)) return { action: "delete", reason: "gone" };
  if (input.failures + 1 >= MAX_CONSECUTIVE_FAILURES) return { action: "delete", reason: "too_many_failures" };
  return { action: "count_failure" };
}
