import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { assertSafeTarget } from "@/lib/security/safeFetch";
import { NOTIFY_EVENTS } from "@/lib/notify/types";
import type { NotifyEvent } from "@/lib/notify/types";
import {
  pushSchemaMissing, upsertSubscription, deleteSubscription, updateSubscriptionEvents,
  listUserSubscriptions, csvToEvents,
} from "@/lib/push";

// POST·DELETE /api/push/subscribe (CONTRACT.md §4, act) — the browser end of web push.
// GET lists the caller's own devices and PATCH retargets one device's event filter: the
// PushSettingsCard needs both, and they stay inside this owned /api/push/** prefix.
//
// The endpoint URL is user-supplied input that this server will later POST to, so it must be
// https and must pass the same private-address check any other outbound request gets.

const MAX_ENDPOINT_LEN = 1000;
const MAX_KEY_LEN = 500;

function sanitizeEvents(value: unknown): NotifyEvent[] {
  if (!Array.isArray(value)) return [];
  return NOTIFY_EVENTS.filter(e => value.includes(e));
}

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const rows = await listUserSubscriptions(userId);
    return NextResponse.json({
      subscriptions: rows.map(r => ({
        endpoint: r.endpoint,
        userAgent: r.userAgent,
        events: csvToEvents(r.events),
        failures: r.failures,
        lastOkAt: r.lastOkAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    if (pushSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const endpoint = String(b?.endpoint ?? "").trim();
  const p256dh = String(b?.keys?.p256dh ?? "").trim();
  const auth = String(b?.keys?.auth ?? "").trim();
  if (!endpoint || !p256dh || !auth) return NextResponse.json({ error: "invalid_value" }, { status: 400 });
  if (endpoint.length > MAX_ENDPOINT_LEN || p256dh.length > MAX_KEY_LEN || auth.length > MAX_KEY_LEN) {
    return NextResponse.json({ error: "invalid_value" }, { status: 400 });
  }
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }
  if (endpointUrl.protocol !== "https:") return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  try {
    await assertSafeTarget(endpoint);
  } catch {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  try {
    const row = await upsertSubscription({
      userId,
      endpoint,
      p256dh,
      auth,
      userAgent: typeof b?.userAgent === "string" ? b.userAgent : "",
      events: sanitizeEvents(b?.events),
    });
    return NextResponse.json({ ok: true, endpoint: row.endpoint });
  } catch (e) {
    if (pushSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

async function endpointOf(req: Request): Promise<string | null> {
  const b = await req.json().catch(() => ({}));
  const endpoint = String(b?.endpoint ?? "").trim();
  return endpoint || null;
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const endpoint = await endpointOf(req);
  if (!endpoint) return NextResponse.json({ error: "invalid_value" }, { status: 400 });
  try {
    const removed = await deleteSubscription(userId, endpoint);
    return NextResponse.json({ ok: removed });
  } catch (e) {
    if (pushSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const endpoint = String(b?.endpoint ?? "").trim();
  if (!endpoint) return NextResponse.json({ error: "invalid_value" }, { status: 400 });
  try {
    const row = await updateSubscriptionEvents(userId, endpoint, sanitizeEvents(b?.events));
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, events: csvToEvents(row.events) });
  } catch (e) {
    if (pushSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
