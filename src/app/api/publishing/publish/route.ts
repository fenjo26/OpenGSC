import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { runPublish } from "@/lib/publish/store";

export const dynamic = "force-dynamic";

// POST /api/publishing/publish — { siteId, historyId?, title?, markdown?, connectionIds, respin, targetUrl? }
//
// The one flow both the UI and the MCP tool run (lib/publish/store.ts). Respin credentials
// resolve server-side on the "respin" task slot through resolveAiCreds — the exact pattern
// the drops-history route uses for its own cheap task, so the per-task override a user sets
// in Settings applies here too without the browser having to forward keys.
//
// Each connection is independent; the response separates posts (rows that were actually
// sent — published or failed at the platform) from failures (nothing was sent, e.g. the
// respin call errored), so the UI can render both honestly.
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const siteId = String(body?.siteId ?? "");
  const connectionIds = (Array.isArray(body?.connectionIds) ? body.connectionIds : [])
    .filter((v: unknown): v is string => typeof v === "string" && !!v);
  if (!siteId || !connectionIds.length) {
    return NextResponse.json({ error: "siteId and connectionIds required" }, { status: 400 });
  }

  const site = await prisma.site.findFirst({
    where: { id: siteId, userId },
    select: { id: true, url: true, siteId: true },
  });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const respin = body?.respin === true;
  let creds;
  if (respin) {
    creds = await resolveAiCreds(userId, {}, "respin");
    if (!creds.aiApiKey) {
      return NextResponse.json({ error: "no_ai_creds: configure an AI provider for the respin task (Settings → SEO Tools)" }, { status: 400 });
    }
  } else {
    // resolveAiCreds with an empty-key shape still needs to exist for runPublish's signature;
    // an empty provider/key is fine when no respin will run.
    creds = { aiProvider: "", aiApiKey: "" };
  }

  try {
    const result = await runPublish(userId, site, {
      siteId,
      historyId: typeof body?.historyId === "string" && body.historyId ? body.historyId : undefined,
      title: typeof body?.title === "string" && body.title ? body.title : undefined,
      markdown: typeof body?.markdown === "string" && body.markdown ? body.markdown : undefined,
      connectionIds,
      respin,
      targetUrl: typeof body?.targetUrl === "string" && body.targetUrl.trim() ? body.targetUrl.trim() : undefined,
    }, creds);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
