import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { fieldLinkClientFor, magic369ClientFor } from "@/lib/magiclinks/providers";
import { idempotencyKeyFor } from "@/lib/magiclinks/fieldlink";
import { quoteArticles, quoteLinks } from "@/lib/magiclinks/magic369";
import { parseRequestItems } from "@/lib/magiclinks/requestItems";
import { isMagicProviderId, PROVIDER_FIELDLINK, PROVIDER_MAGIC369_LINKS, type MagicProviderId } from "@/lib/magiclinks/purchases";

// POST /api/magiclinks/quote — price a selection WITHOUT paying for it.
//
// FieldLink: creates the task server-side first (task creation is free and idempotent by body
// hash), then quotes it. The taskId comes back so submit can reference the exact priced task.
// 369Team: there is no quote call in that API — the prices come from /balance and are computed
// here, which is also why submit re-checks them before charging. Articles are priced by the
// volume tier the WHOLE order's paid count falls into (price_tiers); homepage links at the flat
// link_price. The bonus (+30% / +20% per row) is an estimate — the spec gives no rounding.

export const dynamic = "force-dynamic";

/** What the buy modal shows and what submit echoes back as the expected amount. */
export interface QuoteResponse {
  provider: MagicProviderId;
  taskId?: string;
  placementCount: number;
  /** Estimated for 369Team (rate × count per row, rounded down); exact for FieldLink. */
  bonusCount: number;
  /** Price of one paid placement this order gets (369Team: the applicable tier). */
  unitMinor?: number;
  amountMinor: number;
  balanceMinor: number | null;
  shortfallMinor: number;
  canSubmit: boolean;
}

const MAX_ITEMS = 50;

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const provider = isMagicProviderId(b?.provider) ? b.provider : PROVIDER_FIELDLINK;
  const rawItems = Array.isArray(b?.items) ? b.items : [];
  if (rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return NextResponse.json({ error: "bad_items", message: `1-${MAX_ITEMS} rows expected` }, { status: 400 });
  }
  const items = parseRequestItems(rawItems, { links: provider === PROVIDER_MAGIC369_LINKS });
  if (typeof items === "string") return NextResponse.json({ error: "bad_brief", message: items }, { status: 400 });

  try {
    if (provider === PROVIDER_FIELDLINK) {
      const client = await fieldLinkClientFor(userId);
      if (!client) return NextResponse.json({ error: "not_configured", message: "FieldLink token is not set" }, { status: 400 });

      // FieldLink gets exactly the brief shape it always got: the idempotency key hashes it.
      const briefs = items.map(it => ({ targetUrl: it.targetUrl, anchor: it.anchor, titleKeyword: it.titleKeyword, language: it.language, count: it.count }));
      const payload = { topic: `OpenGSC striking ${new Date().toISOString().slice(0, 10)}`, items: briefs };
      const created = await client.createPosts(payload, idempotencyKeyFor(payload));
      const taskId = created.taskId ?? created.task?.id;
      if (!taskId) return NextResponse.json({ error: "no_task" }, { status: 502 });
      const q = await client.quote(taskId);
      const res: QuoteResponse = {
        provider,
        taskId,
        placementCount: q.placementCount,
        bonusCount: q.bonusCount,
        amountMinor: q.amountMinor,
        balanceMinor: q.balanceMinor,
        shortfallMinor: q.shortfallMinor,
        canSubmit: q.canSubmit,
      };
      return NextResponse.json(res);
    }

    const client = await magic369ClientFor(userId);
    if (!client) return NextResponse.json({ error: "not_configured", message: "369Team token is not set" }, { status: 400 });

    const balance = await client.balance();
    const counts = items.map(it => it.count ?? 1);
    const q = provider === PROVIDER_MAGIC369_LINKS ? quoteLinks(balance, counts) : quoteArticles(balance, counts);
    if (!q) {
      return NextResponse.json({ error: "no_link_price", message: "369Team did not report link_price in /balance" }, { status: 502 });
    }
    const res: QuoteResponse = {
      provider,
      placementCount: q.paid,
      bonusCount: q.bonus,
      unitMinor: q.priceMinor,
      amountMinor: q.amountMinor,
      balanceMinor: balance.balanceMinor,
      shortfallMinor: Math.max(0, q.amountMinor - balance.balanceMinor),
      canSubmit: balance.balanceMinor >= q.amountMinor,
    };
    return NextResponse.json(res);
  } catch (e: any) {
    console.error("[MagicLinks] quote failed", e);
    return NextResponse.json(
      { error: "quote_failed", message: String(e?.message ?? e), code: e?.code },
      { status: e?.status >= 400 && e?.status < 500 ? e.status : 502 },
    );
  }
}
