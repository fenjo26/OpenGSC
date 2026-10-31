import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { redistributeQueue } from "@/lib/indexer/redistribute";

// Re-spread queue rows across active doorway domains. Body { domainId } empties that one
// doorway onto the others; no domainId (or "all") reshuffles the whole queue. Rows are
// re-created as pending — see lib/indexer/redistribute for the move/merge/dedupe semantics.
export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raw = typeof body?.domainId === "string" ? body.domainId : "";
    const domainId = raw && raw !== "all" ? raw : undefined;

    const result = await redistributeQueue(userId, domainId ? { domainId } : {});
    if (!result.ok) {
      const error =
        result.reason === "domain_not_found"
          ? "Domain not found."
          : result.reason === "no_indexer_domains"
            ? "No active doorway domains."
            : result.reason === "no_alternative_domains"
              ? "No other active doorway domains to move pages to."
              : "Nothing to redistribute.";
      return NextResponse.json({ error, reason: result.reason }, { status: result.reason === "domain_not_found" ? 404 : 400 });
    }

    return NextResponse.json({
      success: true,
      moved: result.moved,
      merged: result.merged,
      kept: result.kept,
      deduped: result.deduped,
      domainsUsed: result.domainsUsed,
    });
  } catch {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
