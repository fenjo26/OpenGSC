import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { listPosts, retryPost } from "@/lib/publish/store";

export const dynamic = "force-dynamic";

const PAGE_SIZES = [25, 50, 100];

// GET /api/publishing/posts?siteId=&page=&pageSize= → { rows, total, page, pageSize }
// Same pagination vocabulary as the backlinks list, so the table UI behaves like its siblings.
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  const pageSizeRaw = Number(searchParams.get("pageSize") ?? "50");
  const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : 50;
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  return NextResponse.json(await listPosts(userId, siteId, page, pageSize));
}

// POST /api/publishing/posts — { id, action: "retry" }
// Re-sends a FAILED post's stored title/markdown (the respin output, when one ran, is what
// was stored). A post that is publishing/published/draft is refused — retry means retry, not
// republish-as-new.
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  if (body?.action !== "retry" || typeof body?.id !== "string" || !body.id) {
    return NextResponse.json({ error: 'id and action "retry" required' }, { status: 400 });
  }
  try {
    return NextResponse.json({ post: await retryPost(userId, body.id) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = message === "post_not_found" || message === "connection_not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
