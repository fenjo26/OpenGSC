import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { fieldLinkClientFor, magic369ClientFor } from "@/lib/magiclinks/providers";
import { isMagicProviderId, PROVIDER_FIELDLINK } from "@/lib/magiclinks/purchases";

// GET /api/magiclinks/orders/[id]/csv?provider=… — the publication URLs of a paid order, as a
// CSV. FieldLink publishes destination per completed row; 369Team exposes an articles list.

export const dynamic = "force-dynamic";

function csv(rows: string[][]): string {
  return rows.map(r => r.map(cell => {
    const v = String(cell ?? "");
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")).join("\r\n");
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const provider = new URL(_req.url).searchParams.get("provider") ?? PROVIDER_FIELDLINK;
  if (!isMagicProviderId(provider)) return NextResponse.json({ error: "bad_provider" }, { status: 400 });

  let rows: string[][];
  try {
    if (provider === PROVIDER_FIELDLINK) {
      const client = await fieldLinkClientFor(userId);
      if (!client) return NextResponse.json({ error: "not_configured" }, { status: 400 });
      const { rows: orderRows } = await client.order(id);
      rows = [["url", "anchor", "status", "published_url"],
        ...orderRows
          .filter(r => r.result?.destination)
          .map(r => [r.input?.targetUrl ?? "", r.input?.anchor ?? "", r.status, r.result?.destination ?? ""])];
    } else {
      const client = await magic369ClientFor(userId);
      if (!client) return NextResponse.json({ error: "not_configured" }, { status: 400 });
      const articles = await client.orderArticles(id);
      rows = [["url", "anchor", "published_url", "published_at"],
        ...articles.map(a => [a.url, a.anchor, a.publishedUrl, a.publishedAt ?? ""])];
    }
  } catch (e: any) {
    console.error("[MagicLinks] csv failed", e);
    return NextResponse.json({ error: "csv_failed", message: String(e?.message ?? e) }, { status: 502 });
  }

  return new NextResponse(csv(rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="magic-${provider}-${id}.csv"`,
      "cache-control": "no-store",
    },
  });
}
