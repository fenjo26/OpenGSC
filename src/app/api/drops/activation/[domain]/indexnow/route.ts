import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { schemaMissing } from "@/lib/drops/store";
import { getAsset } from "@/lib/drops/activationStore";
import { pushIndexnow } from "@/lib/drops/indexnowPush";

export const dynamic = "force-dynamic";

/**
 * Push the asset's stored legacy URLs to IndexNow, chunked by INDEXNOW_BATCH, and
 * record the run once. Honest scope: this reaches Bing/Yandex (and minor engines)
 * only — Google does not read IndexNow, so this is never a Google-indexing step.
 * What Google actually does with the host is what the crawl-log route measures (T6).
 */
export async function POST(req: Request, { params }: { params: Promise<{ domain: string }> }) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { domain } = await params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    let limit: number | undefined;
    if (body?.limit != null) {
      if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 0) {
        return NextResponse.json({ error: "bad_limit" }, { status: 400 });
      }
      limit = body.limit;
    }

    const found = await getAsset(userId, domain);
    if (!found) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

    const rows = limit != null ? found.urls.slice(0, limit) : found.urls;
    const urls = rows.map(r => r.url);
    if (!urls.length) return NextResponse.json({ error: "no_urls" }, { status: 400 });

    // ensureAsset always generates one; a row that predates it (or was made by hand)
    // cannot be pushed under a made-up key — the deployed key file would not match.
    const key = found.asset.indexnowKey;
    if (!key) return NextResponse.json({ error: "no_key" }, { status: 400 });

    return NextResponse.json(
      await pushIndexnow(userId, found.asset.id, { domain: found.asset.domain, key, urls }),
    );
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
