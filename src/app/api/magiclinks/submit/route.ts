import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { workspaceUserId } from "@/lib/team/workspace";
import { fieldLinkClientFor, magic369ClientFor } from "@/lib/magiclinks/providers";
import { validateBrief, FieldLinkError, type FieldLinkBrief } from "@/lib/magiclinks/fieldlink";
import { toMagic369Rows, Magic369Error } from "@/lib/magiclinks/magic369";
import {
  recordPurchases, orderRecorded, isMagicProviderId, PROVIDER_FIELDLINK, PROVIDER_MAGIC369,
  type PurchaseInput,
} from "@/lib/magiclinks/purchases";

// POST /api/magiclinks/submit — the only route in this feature that spends money, and the only
// one that writes the purchase ledger.
//
// Both providers re-check the price at this boundary against the amount the operator confirmed
// (expectedMinor): FieldLink enforces it server-side via its 409 PRICE_CHANGED header contract,
// 369Team is checked here because its API would happily charge whatever is current. The ledger
// trace is written only after the provider accepted the order — a task without a payment is
// not a purchase.

export const dynamic = "force-dynamic";

/** A striking row's own context, riding with the selection so each ledger row lands on the
 *  right site: a purchase marker hung on somebody else's chart is worse than a missing one. */
interface ContextRow {
  siteId: string;
  targetUrl: string;
  query: string;
  anchor?: string;
}

function parseContext(raw: unknown): ContextRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    const r = c as Record<string, unknown> | null;
    return {
      siteId: String(r?.siteId ?? ""),
      targetUrl: String(r?.targetUrl ?? ""),
      query: String(r?.query ?? ""),
      anchor: r?.anchor != null ? String(r.anchor) : undefined,
    };
  }).filter(c => c.siteId && c.targetUrl);
}

function parseItems(raw: unknown): FieldLinkBrief[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "empty selection";
  const out: FieldLinkBrief[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null;
    try {
      out.push(validateBrief({
        targetUrl: String(r?.targetUrl ?? ""),
        query: String(r?.query ?? ""),
        anchor: String(r?.anchor ?? r?.query ?? ""),
        language: String(r?.language ?? ""),
        count: Number(r?.count),
      }, i));
    } catch (e) {
      return (e as Error).message;
    }
  }
  return out;
}

/** Only sites the caller owns may receive ledger rows. Unowned ids are dropped, not errors —
 *  the money already moved by the time this runs, and the operator should not lose the trace
 *  because one context row referenced a deleted site. */
async function ownedSiteIds(candidates: Iterable<string>, userId: string): Promise<Set<string>> {
  const ids = [...new Set([...candidates].filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await prisma.site.findMany({ where: { id: { in: ids }, userId }, select: { id: true } });
  return new Set(rows.map(r => r.id));
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const provider = isMagicProviderId(b?.provider) ? b.provider : PROVIDER_FIELDLINK;
  const expectedMinor = Number(b?.expectedMinor);
  if (!Number.isInteger(expectedMinor) || expectedMinor < 0) {
    return NextResponse.json({ error: "no_expected_amount" }, { status: 400 });
  }
  const context = parseContext(b?.context);
  const fallbackSiteId = String(b?.siteId ?? "");

  try {
    const owned = await ownedSiteIds([...context.map(c => c.siteId), fallbackSiteId], userId);
    if (provider === PROVIDER_FIELDLINK) {
      return await submitFieldLink(String(b?.taskId ?? ""), expectedMinor, context, fallbackSiteId, owned, userId);
    }
    return await submitMagic369(b?.items, b?.context, expectedMinor, fallbackSiteId, owned, userId);
  } catch (e: any) {
    if (e instanceof FieldLinkError || e instanceof Magic369Error) {
      if (e.code === "PRICE_CHANGED") {
        return NextResponse.json({ error: "price_changed", message: "The price changed while you were confirming. Quote again." }, { status: 409 });
      }
      if (e.status === 402) {
        return NextResponse.json({ error: "insufficient_balance", message: e.message }, { status: 402 });
      }
      return NextResponse.json({ error: "provider_error", message: e.message, code: e.code }, { status: e.status >= 400 && e.status < 500 ? e.status : 502 });
    }
    console.error("[MagicLinks] submit failed", e);
    return NextResponse.json({ error: "submit_failed", message: String(e?.message ?? e) }, { status: 500 });
  }
}

async function submitFieldLink(
  taskId: string, expectedMinor: number, context: ContextRow[],
  fallbackSiteId: string, owned: Set<string>, userId: string,
) {
  const client = await fieldLinkClientFor(userId);
  if (!client) return NextResponse.json({ error: "not_configured", message: "FieldLink token is not set" }, { status: 400 });
  if (!taskId) return NextResponse.json({ error: "no_task" }, { status: 400 });

  // The price is re-read HERE, at the pay boundary — the number on the button was true when it
  // was drawn. Submit then carries this fresh figure in the header the service itself checks.
  const quote = await client.quote(taskId);
  if (quote.amountMinor !== expectedMinor) {
    return NextResponse.json({
      error: "price_changed",
      message: "The price changed while you were confirming. Quote again.",
      quote: {
        amountMinor: quote.amountMinor, placementCount: quote.placementCount, bonusCount: quote.bonusCount,
        balanceMinor: quote.balanceMinor, shortfallMinor: quote.shortfallMinor, canSubmit: quote.canSubmit,
      },
    }, { status: 409 });
  }
  if (!quote.canSubmit) {
    return NextResponse.json({ error: "insufficient_balance", message: "Not enough credits; the order was not created" }, { status: 402 });
  }

  const res = await client.submitOrder(taskId, quote.amountMinor);
  const order = res.order;

  // The ledger is written from the briefs the SERVICE saved, not from what the browser sent —
  // a replayed submit of the same order cannot double-record what it already recorded.
  if (!(await orderRecorded(order.id))) {
    const briefs = await client.taskRows(taskId);
    // Pair keys follow our own submit convention: anchor defaults to the query.
    const siteByTarget = new Map<string, string>();
    const siteByPair = new Map<string, string>();
    const queryByPair = new Map<string, string>();
    for (const c of context) {
      if (!owned.has(c.siteId)) continue;
      siteByTarget.set(c.targetUrl, c.siteId);
      siteByPair.set(`${c.targetUrl}\n${c.anchor ?? c.query}`, c.siteId);
      queryByPair.set(`${c.targetUrl}\n${c.anchor ?? c.query}`, c.query);
    }
    const fallback = owned.has(fallbackSiteId) ? fallbackSiteId : "";

    const rows: PurchaseInput[] = briefs
      .map((brief): PurchaseInput | null => {
        const siteId = siteByPair.get(`${brief.targetUrl}\n${brief.anchor}`)
          ?? siteByPair.get(`${brief.targetUrl}\n${brief.titleKeyword ?? ""}`)
          ?? siteByTarget.get(brief.targetUrl)
          ?? fallback;
        if (!siteId) return null;
        return {
          siteId,
          targetUrl: brief.targetUrl,
          query: brief.titleKeyword || brief.anchor,
          anchor: brief.anchor,
          language: brief.language,
          quantity: Number(brief.count ?? 1),
          taskId,
          orderId: order.id,
          provider: PROVIDER_FIELDLINK,
        } satisfies PurchaseInput;
      })
      .filter((r): r is PurchaseInput => r !== null);
    if (rows.length) await recordPurchases(rows);
  }

  return NextResponse.json({ provider: PROVIDER_FIELDLINK, orderId: order.id, order, replayed: !!res.replayed });
}

async function submitMagic369(
  rawItems: unknown, rawContext: unknown, expectedMinor: number,
  fallbackSiteId: string, owned: Set<string>, userId: string,
) {
  const client = await magic369ClientFor(userId);
  if (!client) return NextResponse.json({ error: "not_configured", message: "369Team token is not set" }, { status: 400 });

  const items = parseItems(rawItems);
  if (typeof items === "string") return NextResponse.json({ error: "bad_brief", message: items }, { status: 400 });
  const context = parseContext(rawContext);
  // The raw rows keep siteId per item, aligned by index — the validated briefs strip it.
  const rawRows = (Array.isArray(rawItems) ? rawItems : []) as Array<Record<string, unknown>>;

  const balance = await client.balance();
  const total = items.reduce((s, b) => s + (b.count ?? 1), 0);
  const amountMinor = total * balance.priceMinor;
  if (amountMinor !== expectedMinor) {
    return NextResponse.json({
      error: "price_changed",
      message: "The price changed while you were confirming. Quote again.",
      quote: {
        amountMinor, placementCount: total, bonusCount: 0, balanceMinor: balance.balanceMinor,
        shortfallMinor: Math.max(0, amountMinor - balance.balanceMinor), canSubmit: balance.balanceMinor >= amountMinor,
      },
    }, { status: 409 });
  }
  if (balance.balanceMinor < amountMinor) {
    return NextResponse.json({ error: "insufficient_balance", message: "Not enough tokens; the order was not created" }, { status: 402 });
  }

  let created: Awaited<ReturnType<typeof client.createOrder>>;
  try {
    created = await client.createOrder(toMagic369Rows(items));
  } catch (e) {
    if (e instanceof Magic369Error) throw e;
    // A timeout or a cut-off AFTER the send: the service may have charged already, and the API
    // has no idempotency — retrying blind would buy twice. Say so plainly instead.
    return NextResponse.json({
      error: "order_unknown",
      message: "369Team did not answer the create call. The order may exist — check the balance before paying again.",
    }, { status: 504 });
  }

  // 369Team has no tasks, only orders; the trace is written from the same briefs that went
  // into the order, each onto the site its context row names.
  const rows: PurchaseInput[] = items
    .map((brief, i): PurchaseInput | null => {
      const siteId = String(rawRows[i]?.siteId ?? "") || fallbackSiteId;
      if (!siteId || !owned.has(siteId)) return null;
      return {
        siteId,
        targetUrl: brief.targetUrl,
        query: brief.titleKeyword || brief.anchor,
        anchor: brief.anchor,
        language: brief.language,
        quantity: Number(brief.count ?? 1),
        taskId: null,
        orderId: created.orderId,
        provider: PROVIDER_MAGIC369,
      };
    })
    .filter((r): r is PurchaseInput => r !== null);
  if (rows.length) await recordPurchases(rows);

  return NextResponse.json({
    provider: PROVIDER_MAGIC369,
    orderId: created.orderId,
    order: {
      id: created.orderId,
      status: created.status,
      rowCount: created.totalCount,
      amountMinor: created.totalPriceMinor,
      balanceAfterMinor: created.balanceAfterMinor,
    },
  });
}
