import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { fieldLinkClientFor, magic369ClientFor } from "@/lib/magiclinks/providers";
import { isMagicProviderId, PROVIDER_FIELDLINK, PROVIDER_MAGIC369, PROVIDER_MAGIC369_LINKS } from "@/lib/magiclinks/purchases";
import {
  importPurchasedPlacements,
  isFieldLinkTerminal,
  isMagic369Terminal,
  markOrderTracked,
  orderOwner,
  placementsFromFieldLink,
  placementsFromMagic369,
  placementsFromMagic369Links,
} from "@/lib/magiclinks/tracking";

// GET /api/magiclinks/orders/[id]?provider=fieldlink|magic369|magic369links — one order in full: per-row
// progress, publication URLs and (FieldLink) indexing state.
//
// Opening a detail view is also the fast path of the tracking loop: the placements this order
// has already published land in SiteBacklink right here (fire-and-forget — the response does
// not wait for the import), so bought links start being verified without waiting for the hourly
// pass. The scheduler does the same for orders nobody opens.

export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const provider = new URL(_req.url).searchParams.get("provider") ?? PROVIDER_FIELDLINK;
  if (!isMagicProviderId(provider)) return NextResponse.json({ error: "bad_provider" }, { status: 400 });

  try {
    if (provider === PROVIDER_FIELDLINK) {
      const client = await fieldLinkClientFor(userId);
      if (!client) return NextResponse.json({ error: "not_configured" }, { status: 400 });
      const { order, rows } = await client.order(id);
      void (async () => {
        const owner = await orderOwner(id);
        if (!owner || owner.trackedAt) return;
        await importPurchasedPlacements({
          siteId: owner.siteId, provider: PROVIDER_FIELDLINK, orderId: id,
          placements: placementsFromFieldLink(rows),
        });
        if (isFieldLinkTerminal(order.status)) await markOrderTracked(PROVIDER_FIELDLINK, id);
      })().catch(() => { /* the import is a bonus, not the response's job */ });
      return NextResponse.json({
        provider,
        order,
        rows: rows.map(r => ({
          id: r.id,
          status: r.status,
          targetUrl: r.input?.targetUrl ?? "",
          anchor: r.input?.anchor ?? "",
          language: r.input?.language ?? "",
          quantity: r.input?.quantity ?? 1,
          isBonus: !!r.isBonus,
          destination: r.result?.destination ?? null,
          donor: r.result?.donor ?? null,
          error: r.error ?? null,
          indexing: r.indexing?.status ?? null,
        })),
      });
    }

    const client = await magic369ClientFor(userId);
    if (!client) return NextResponse.json({ error: "not_configured" }, { status: 400 });
    const links = provider === PROVIDER_MAGIC369_LINKS;
    const [order, articles, placed] = await Promise.all([
      links ? client.linkOrder(id) : client.order(id),
      links ? Promise.resolve([]) : client.orderArticles(id).catch(() => []),
      links ? client.linkOrderLinks(id).catch(() => []) : Promise.resolve([]),
    ]);
    const kind = links ? PROVIDER_MAGIC369_LINKS : PROVIDER_MAGIC369;
    void (async () => {
      const owner = await orderOwner(id);
      if (!owner || owner.trackedAt) return;
      await importPurchasedPlacements({
        siteId: owner.siteId, provider: kind, orderId: id,
        placements: links ? placementsFromMagic369Links(placed) : placementsFromMagic369(articles),
      });
      if (isMagic369Terminal(order)) await markOrderTracked(kind, id);
    })().catch(() => { /* same as above */ });
    return NextResponse.json({
      provider,
      order,
      rows: order.items.map(it => {
        // A row is done when everything it owes — paid plus bonus — is published or failed.
        const owed = it.count + it.bonusCount;
        return {
          id: `${id}:${it.url}:${it.anchor}`,
          status: it.published >= owed ? "completed"
            : it.failed >= owed ? "failed"
            : it.published + it.failed >= owed ? "partial"
            : "processing",
          targetUrl: it.url,
          anchor: it.anchor,
          language: it.language,
          text: it.text,
          quantity: it.count,
          bonusCount: it.bonusCount,
          published: it.published,
          failed: it.failed,
          isBonus: false,
          destination: null,
          donor: null,
          error: null,
          indexing: null,
        };
      }),
      articles,
      links: placed,
    });
  } catch (e: any) {
    console.error("[MagicLinks] order detail failed", e);
    return NextResponse.json(
      { error: "order_failed", message: String(e?.message ?? e) },
      { status: e?.status >= 400 && e?.status < 500 ? e.status : 502 },
    );
  }
}
