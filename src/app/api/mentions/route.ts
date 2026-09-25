import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { listMentions, mentionsSchemaMissing } from "@/lib/mentions/store";
import type { MentionLinkStatus, MentionQuery, MentionSource } from "@/lib/mentions/types";

// GET /api/mentions?siteId=&source=&state=&linkStatus=&q=&limit=&offset= (CONTRACT §4, read).
// The feed for the Mentions panel and the MCP tool. Table missing → 200 { notMigrated: true }.

const SOURCES = new Set<MentionSource>(["news", "wikipedia", "wikidata"]);
const STATES = new Set(["new", "reviewed", "dismissed", "all"]);
const LINK_STATUSES = new Set<MentionLinkStatus>(["unchecked", "linked", "unlinked", "unreachable"]);

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const p = new URL(req.url).searchParams;
  const siteId = p.get("siteId") || "";
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });

  const source = p.get("source") || undefined;
  const state = p.get("state") || undefined;
  const linkStatus = p.get("linkStatus") || undefined;
  const q: MentionQuery = {
    ...(source && (SOURCES.has(source as MentionSource) || source === "all") ? { source: source as MentionQuery["source"] } : {}),
    ...(state && STATES.has(state) ? { state: state as MentionQuery["state"] } : {}),
    ...(linkStatus && (LINK_STATUSES.has(linkStatus as MentionLinkStatus) || linkStatus === "all")
      ? { linkStatus: linkStatus as MentionQuery["linkStatus"] }
      : {}),
    ...(p.get("q") ? { q: p.get("q") ?? undefined } : {}),
    limit: Number(p.get("limit")) || undefined,
    offset: Number(p.get("offset")) || undefined,
  };

  try {
    return NextResponse.json(await listMentions(userId, siteId, q));
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    if (mentionsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "mentions_load_failed" }, { status: 500 });
  }
}
