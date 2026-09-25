// N10 — web push delivery (docs/tasks/wave-nov/N10-pwa-push.md).
//
// web-push is used as the brief prescribes (sendNotification with TTL 3600); the endpoint URL
// still passes assertSafeTarget before any socket is opened, because a subscription endpoint
// is user-supplied input and this server must not become a probe of its own internal network
// (the safeFetch rule — web-push cannot route through safeFetch itself).

import webpush, { WebPushError } from "web-push";
import { assertSafeTarget } from "@/lib/security/safeFetch";
import type { NotifyEvent } from "@/lib/notify/types";
import { buildPushPayload, matchSiteDomain, urlForEvent, type PushPayload } from "./payload";
import { subscriptionAllows } from "./subscription";
import { getVapidKeys } from "./vapid";
import { listWorkspaceSubscriptions, markAttempt, workspaceSiteDomains, type PushSubRow } from "./store";

const PUSH_TTL_SECONDS = 3600;

export interface PushSendReport {
  sent: number;     // devices actually attempted
  ok: number;       // devices that accepted the message
  dropped: number;  // subscriptions removed (gone / 5 failures)
  error?: string;   // transport-level problem that applied to the whole batch (e.g. no VAPID)
}

async function deliverOne(row: PushSubRow, payload: PushPayload, vapid: { publicKey: string; privateKey: string; subject: string }): Promise<{ ok: boolean; outcome: "ok" | "failure" | "deleted" }> {
  try {
    await assertSafeTarget(row.endpoint);
  } catch {
    const outcome = await markAttempt(row, false, null).catch(() => "failure" as const);
    return { ok: false, outcome };
  }
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: PUSH_TTL_SECONDS, vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } },
    );
    const outcome = await markAttempt(row, true).catch(() => "ok" as const);
    return { ok: true, outcome };
  } catch (e) {
    const statusCode = e instanceof WebPushError ? e.statusCode : null;
    const outcome = await markAttempt(row, false, statusCode).catch(() => "failure" as const);
    return { ok: false, outcome };
  }
}

/** Send one payload to already-chosen rows. Never throws — per-device failures are data. */
export async function pushToSubscriptions(subs: PushSubRow[], payload: PushPayload): Promise<PushSendReport> {
  const vapid = await getVapidKeys().catch(() => null);
  if (!vapid) return { sent: 0, ok: 0, dropped: 0, error: "not_migrated" };
  const settled = await Promise.allSettled(subs.map(row => deliverOne(row, payload, vapid)));
  let ok = 0;
  let dropped = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    if (s.value.ok) ok++;
    if (s.value.outcome === "deleted") dropped++;
  }
  return { sent: subs.length, ok, dropped };
}

/**
 * The notify stack's entry point: every subscription of the owner AND accepted workspace
 * members whose per-device event filter passes, one payload, URL mapped by event
 * (alert → the site's page when the text names a portfolio domain, lead → /leads, else /).
 */
export async function sendWorkspacePush(
  ownerId: string,
  title: string,
  text: string,
  event: NotifyEvent,
  opts?: { url?: string },
): Promise<PushSendReport> {
  const all = await listWorkspaceSubscriptions(ownerId);
  const targets = all.filter(s => subscriptionAllows(s.events, event));
  if (!targets.length) return { sent: 0, ok: 0, dropped: 0 };

  let url = opts?.url;
  if (!url && event === "alert") {
    const domains = await workspaceSiteDomains(ownerId);
    const siteId = matchSiteDomain(`${title}\n${text}`, domains);
    if (siteId) url = `/site/${siteId}`;
  }
  const payload = buildPushPayload({ title, text, event, url: url || urlForEvent(event) });
  return pushToSubscriptions(targets, payload);
}
