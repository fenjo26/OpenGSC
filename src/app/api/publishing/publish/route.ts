import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { runPublish, parseWindowMs } from "@/lib/publish/store";

export const dynamic = "force-dynamic";

// POST /api/publishing/publish — { siteId, historyId?, title?, markdown?, connectionIds, respin, targetUrl? }
//                            | { siteId, items: [{connectionId, historyId? | title?+markdown?}], respin, … }
//                            + windowHours | windowDays (defers the whole batch with jitter)
//
// The one flow both the UI and the MCP tool run (lib/publish/store.ts). Respin credentials
// resolve server-side on the "respin" task slot through resolveAiCreds — the exact pattern
// the drops-history route uses for its own cheap task, so the per-task override a user sets
// in Settings applies here too without the browser having to forward keys.
//
// With a spread window no creds are required NOW: nothing is sent at planning time, and the
// scheduler resolves the respin slot again at send time (a missing key then fails that one
// post and fires the deferred-blocked alert, instead of pretending at plan time).
//
// Each connection is independent; the response separates posts (rows that were actually
// created — scheduled, published, blocked or failed at the platform) from failures (nothing
// was created, e.g. the respin call or the connection-type gate refused it), so the UI can
// render both honestly. anchorSummary + warnings carry the pre-publish review signals.
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const siteId = String(body?.siteId ?? "");
  const items = Array.isArray(body?.items)
    ? (body.items as Record<string, unknown>[]).map(i => ({
      connectionId: String(i?.connectionId ?? ""),
      historyId: typeof i?.historyId === "string" && i.historyId ? i.historyId : undefined,
      title: typeof i?.title === "string" && i.title ? i.title : undefined,
      markdown: typeof i?.markdown === "string" && i.markdown ? i.markdown : undefined,
    })).filter(i => i.connectionId)
    : undefined;
  const connectionIds = (Array.isArray(body?.connectionIds) ? body.connectionIds : [])
    .filter((v: unknown): v is string => typeof v === "string" && !!v);
  if (!siteId || (!connectionIds.length && !items?.length)) {
    return NextResponse.json({ error: "siteId and connectionIds (or items) required" }, { status: 400 });
  }

  const site = await prisma.site.findFirst({
    where: { id: siteId, userId },
    select: { id: true, url: true, siteId: true },
  });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const respin = body?.respin === true;
  let windowMs: number | null = null;
  try {
    windowMs = parseWindowMs({ windowHours: body?.windowHours as number | undefined, windowDays: body?.windowDays as number | undefined });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }

  let creds;
  if (respin && windowMs == null) {
    creds = await resolveAiCreds(userId, {}, "respin");
    if (!creds.aiApiKey) {
      return NextResponse.json({ error: "no_ai_creds: configure an AI provider for the respin task (Settings → SEO Tools)" }, { status: 400 });
    }
  } else {
    // resolveAiCreds with an empty-key shape still needs to exist for runPublish's signature;
    // an empty provider/key is fine when no respin will run — now (no respin) or later
    // (deferred: the scheduler resolves its own creds at send time).
    creds = { aiProvider: "", aiApiKey: "" };
  }

  try {
    const result = await runPublish(userId, site, {
      siteId,
      historyId: typeof body?.historyId === "string" && body.historyId ? body.historyId : undefined,
      title: typeof body?.title === "string" && body.title ? body.title : undefined,
      markdown: typeof body?.markdown === "string" && body.markdown ? body.markdown : undefined,
      connectionIds,
      items,
      respin,
      targetUrl: typeof body?.targetUrl === "string" && body.targetUrl.trim() ? body.targetUrl.trim() : undefined,
      windowHours: typeof body?.windowHours === "number" ? body.windowHours : undefined,
      windowDays: typeof body?.windowDays === "number" ? body.windowDays : undefined,
    }, creds);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
