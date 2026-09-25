import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { createOutreachProspect } from "@/lib/outreach/service";
import { mentionForOutreach, mentionsSchemaMissing } from "@/lib/mentions/store";

// POST /api/mentions/[id]/outreach (CONTRACT §4, act) → { prospectId }.
// Calls the SAME server-side service the MCP save_outreach_prospect tool uses, so a mention
// becomes a prospect exactly like a Link Monitor find: same dedupe (userId+domain), same
// "saving an existing prospect returns it" semantics, same stage history.

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const GOOGLE_NEWS_RE = /(^|\.)news\.google\.com$/i;

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  try {
    const mention = await mentionForOutreach(userId, id);
    if (!mention) return NextResponse.json({ error: "mention_not_found" }, { status: 404 });

    // A news mention whose Google redirect was never expanded has no publisher domain to
    // file the prospect under — news.google.com is not the outlet. Check the link first.
    const domain = hostOf(mention.url);
    if (mention.source === "news" && GOOGLE_NEWS_RE.test(domain)) {
      return NextResponse.json({ error: "check_link_first" }, { status: 409 });
    }

    const date = (mention.publishedAt ?? mention.firstSeenAt).slice(0, 10);
    const { prospect } = await createOutreachProspect(userId, {
      domain,
      sourceUrl: mention.url,
      sourceTitle: mention.title,
      // Evidence, per the brief: title, URL, date, link status — the pitch research starts
      // from what the mention itself says. English: operator notes, not UI copy.
      notes: `Brand mention · ${mention.publisher || mention.source} · ${date} · link: ${mention.linkStatus}`.slice(0, 5000),
      ...(mention.linkStatus === "unlinked"
        ? { pitchAngle: `Unlinked brand mention of ${mention.siteHost} — ask for a link (${date})` }
        : {}),
    });
    return NextResponse.json({ prospectId: prospect.id });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "mention_not_found") return NextResponse.json({ error: "mention_not_found" }, { status: 404 });
    if (message === "prospect_domain_required") return NextResponse.json({ error: "no_publisher_domain" }, { status: 400 });
    if (mentionsSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
    return NextResponse.json({ error: "outreach_save_failed" }, { status: 500 });
  }
}
