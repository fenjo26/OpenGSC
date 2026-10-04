import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { fieldLinkClientFor, magic369ClientFor } from "@/lib/magiclinks/providers";
import { listUserPurchases, providerName, PROVIDER_FIELDLINK, PROVIDER_MAGIC369 } from "@/lib/magiclinks/purchases";

// GET /api/magiclinks/orders — every purchase order this workspace made, both providers, one
// list, newest first.
//
// FieldLink exposes an order list in its API, so those rows are read live. 369Team does not —
// its history exists only in our ledger, so the ledger's distinct order ids are the list and
// each one's live progress is fetched per id (bounded by how many orders were actually made).

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ledger = await listUserPurchases(userId, 2000);

  // Per-order ledger context: sites touched, links bought, first query — provider APIs know
  // nothing about our striking rows, this is the half only we have.
  const contextByOrder = new Map<string, { quantity: number; hosts: string[]; queries: string[]; createdAt: string }>();
  for (const r of ledger) {
    let c = contextByOrder.get(r.orderId);
    if (!c) {
      c = { quantity: 0, hosts: [], queries: [], createdAt: r.createdAt.toISOString() };
      contextByOrder.set(r.orderId, c);
    }
    c.quantity += r.quantity;
    const host = hostOf(r.targetUrl);
    if (host && !c.hosts.includes(host)) c.hosts.push(host);
    if (r.query && !c.queries.includes(r.query)) c.queries.push(r.query);
    if (r.createdAt.toISOString() < c.createdAt) c.createdAt = r.createdAt.toISOString();
  }

  const orders: Record<string, unknown>[] = [];
  const errors: Record<string, string> = {};

  const fieldlink = await fieldLinkClientFor(userId);
  if (fieldlink) {
    try {
      const remote = await fieldlink.listOrders(100);
      for (const o of remote) {
        const ctx = contextByOrder.get(o.id);
        orders.push({
          provider: PROVIDER_FIELDLINK, providerName: providerName(PROVIDER_FIELDLINK),
          orderId: o.id,
          createdAt: o.createdAt ?? ctx?.createdAt ?? null,
          status: o.status,
          rowCount: o.rowCount,
          completedCount: o.completedCount,
          failedCount: o.failedCount,
          amountMinor: o.billing?.amountMinor ?? null,
          hosts: ctx?.hosts ?? [], quantity: ctx?.quantity ?? 0, queries: ctx?.queries ?? [],
        });
      }
    } catch (e: any) {
      errors.fieldlink = String(e?.message ?? e);
    }
  }

  const m369 = await magic369ClientFor(userId);
  if (m369) {
    // Only orders the ledger knows — without a list endpoint, anything else is unguessable.
    const ids = [...new Set(ledger.filter(r => r.provider === PROVIDER_MAGIC369).map(r => r.orderId))].slice(0, 50);
    const results = await Promise.allSettled(ids.map(id => m369.order(id)));
    for (const res of results) {
      if (res.status === "rejected") continue;
      const o = res.value;
      const ctx = contextByOrder.get(o.id);
      orders.push({
        provider: PROVIDER_MAGIC369, providerName: providerName(PROVIDER_MAGIC369),
        orderId: o.id,
        createdAt: o.createdAt ?? ctx?.createdAt ?? null,
        status: o.status,
        rowCount: o.progress.total,
        completedCount: o.progress.published,
        failedCount: o.progress.failed,
        amountMinor: o.totalPriceMinor,
        hosts: ctx?.hosts ?? [], quantity: ctx?.quantity ?? 0, queries: ctx?.queries ?? [],
      });
    }
    const firstErr = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (firstErr) errors.magic369 = String(firstErr.reason?.message ?? firstErr.reason);
  }

  orders.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return NextResponse.json({ orders, errors });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}
