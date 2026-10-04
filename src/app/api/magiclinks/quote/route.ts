import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { fieldLinkClientFor, magic369ClientFor } from "@/lib/magiclinks/providers";
import { validateBrief, idempotencyKeyFor, type FieldLinkBrief } from "@/lib/magiclinks/fieldlink";
import { isMagicProviderId, PROVIDER_FIELDLINK } from "@/lib/magiclinks/purchases";

// POST /api/magiclinks/quote — price a selection WITHOUT paying for it.
//
// FieldLink: creates the task server-side first (task creation is free and idempotent by body
// hash), then quotes it. The taskId comes back so submit can reference the exact priced task.
// 369Team: there is no quote call in that API — the price comes from /balance and is computed
// here, which is also why submit re-checks it before charging.

export const dynamic = "force-dynamic";

/** What the buy modal shows and what submit echoes back as the expected amount. */
export interface QuoteResponse {
  provider: "fieldlink" | "magic369";
  taskId?: string;
  placementCount: number;
  bonusCount: number;
  amountMinor: number;
  balanceMinor: number | null;
  shortfallMinor: number;
  canSubmit: boolean;
}

const MAX_ITEMS = 50;

function parseItems(raw: unknown[]): FieldLinkBrief[] | string {
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

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const provider = isMagicProviderId(b?.provider) ? b.provider : PROVIDER_FIELDLINK;
  const rawItems = Array.isArray(b?.items) ? b.items : [];
  if (rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return NextResponse.json({ error: "bad_items", message: `1-${MAX_ITEMS} rows expected` }, { status: 400 });
  }
  const items = parseItems(rawItems);
  if (typeof items === "string") return NextResponse.json({ error: "bad_brief", message: items }, { status: 400 });

  try {
    if (provider === PROVIDER_FIELDLINK) {
      const client = await fieldLinkClientFor(userId);
      if (!client) return NextResponse.json({ error: "not_configured", message: "FieldLink token is not set" }, { status: 400 });

      const payload = { topic: `OpenGSC striking ${new Date().toISOString().slice(0, 10)}`, items };
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
    const placementCount = items.reduce((s, b2) => s + (b2.count ?? 1), 0);
    const amountMinor = placementCount * balance.priceMinor;
    const res: QuoteResponse = {
      provider,
      placementCount,
      bonusCount: 0, // 369Team has no standing bonus; the service may still add its own
      amountMinor,
      balanceMinor: balance.balanceMinor,
      shortfallMinor: Math.max(0, amountMinor - balance.balanceMinor),
      canSubmit: balance.balanceMinor >= amountMinor,
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
