import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getNotFoundUrls } from "@/lib/indexing/checkQueue";

// The copy/export list — every not_indexed verdict of the run, deduped, one per line. No
// errors, no unchecked URLs: the button label promises exactly the URLs the provider answered
// "not found" on (ui-labels-must-match-action-scope).
//
//   GET ?siteId=       — optional cut to one site's URLs; absent = the whole run.
//   ?format=txt        — text/plain, one URL per line (the copy button and the .txt download
//                        both fetch this; the JSON shape below is for programmatic callers).

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const sp = new URL(req.url).searchParams;

  try {
    const urls = await getNotFoundUrls(userId, id, sp.get("siteId") ?? undefined);
    if (!urls) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (sp.get("format") === "txt") {
      return new NextResponse(urls.join("\n") + (urls.length ? "\n" : ""), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return NextResponse.json({ urls, count: urls.length });
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? "");
    if (/SerpCheck|does not exist|no such table|no such column/i.test(msg)) {
      return NextResponse.json({ notMigrated: true }, { status: 503 });
    }
    console.error("[index-check:not-found]", e);
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
}
