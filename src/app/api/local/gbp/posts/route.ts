import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { createPost, deletePost, listPosts, localSchemaMissing } from "@/lib/local/store";
import { isPostCtaType } from "@/lib/local/gbpParse";
import { kickLocalScheduler } from "@/lib/local/scheduler";

// GET    /api/local/gbp/posts?siteId= (read) — the site's posts with status/error (scheduled,
//         published, failed — the scheduler's verdicts land here).
// POST   /api/local/gbp/posts { siteId, summary, ctaType?, ctaUrl?, mediaUrl?, scheduledAt, status }
//         (act) — a draft, or a scheduled post the 10-minute loop publishes at scheduledAt
//         (scheduling "now" publishes on the kicked tick, seconds later). No GBP call here.
// DELETE /api/local/gbp/posts?id= (act).

const httpsUrl = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return /^https:\/\/\S+$/i.test(s) ? s : null;
};

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const siteId = new URL(req.url).searchParams.get("siteId") ?? "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  try {
    const posts = await listPosts(userId, siteId);
    return NextResponse.json({ posts });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP posts load failed:", error);
    return NextResponse.json({ error: "posts_load_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const siteId = String(body?.siteId ?? "");
  const summary = String(body?.summary ?? "").trim();
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  if (!summary) return NextResponse.json({ error: "summary_required" }, { status: 400 });

  const ctaType = typeof body.ctaType === "string" && isPostCtaType(body.ctaType) ? body.ctaType : null;
  const ctaUrl = httpsUrl(body.ctaUrl);
  const mediaUrl = httpsUrl(body.mediaUrl);
  const status = body.status === "scheduled" ? "scheduled" : "draft";
  const when = new Date(String(body?.scheduledAt ?? ""));
  const scheduledAt = Number.isFinite(when.getTime()) ? when : new Date();

  try {
    const post = await createPost(userId, siteId, { summary, ctaType, ctaUrl, mediaUrl, scheduledAt, status });
    if (status === "scheduled") kickLocalScheduler(); // due now → published on the immediate tick
    return NextResponse.json({ post });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (message === "summary_required") return NextResponse.json({ error: "summary_required" }, { status: 400 });
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP post create failed:", error);
    return NextResponse.json({ error: "post_create_failed" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
  try {
    await deletePost(userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "post_not_found") return NextResponse.json({ error: "post_not_found" }, { status: 404 });
    if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    console.warn("[local] GBP post delete failed:", error);
    return NextResponse.json({ error: "post_delete_failed" }, { status: 500 });
  }
}
