import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { fetchSubscriptionInfo, MetricsProvider } from "@/lib/seo/metrics";
import { readUsage } from "@/lib/seo/metricsStore";

// POST /api/metrics/subscription { provider, apiKey, baseUrl }
//
// Free proxy to Ahrefs' `/v3/subscription-info/limits-and-usage`: the real balance, the reset
// date and the key's expiry date. Screens use it to say "37 600 of 50 000 left · resets 01.09"
// instead of quoting our own spending estimate as if it were the provider's number.
//
// The call costs 0 units and is cached 10 minutes in-process by `fetchSubscriptionInfo`, so
// rendering a placard never opens a gateway round-trip.
//
// Failure shape: HTTP 200 with `gatewayStatus` and no `info`. A gateway refusal is data the UI
// needs to branch on (401 = wrong key for this host, 402 = out of units) — mirroring it as our
// own HTTP status would only collapse it into the same "request failed" the fetch already
// reports, which is exactly the indistinguishability this route exists to remove.

export async function POST(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const provider = (b.provider === "semrush" ? "semrush" : "ahrefs") as MetricsProvider;
  const apiKey = String(b.apiKey ?? "").trim();
  const baseUrl = String(b.baseUrl ?? "").trim() || undefined;
  if (!apiKey) return NextResponse.json({ error: "no_key", gatewayStatus: null, info: null });

  const res = await fetchSubscriptionInfo({ provider, apiKey, baseUrl });

  return NextResponse.json({
    info: res.info,
    // Distinct codes, not a flattened "failed": 401 and 402 say completely different things
    // about what the user should do next.
    gatewayStatus: res.status,
    ...(res.error ? { error: res.error } : {}),
    // Our own month counter rides along, so a caller whose gateway balance is unavailable can
    // fall back to the estimate in the same response instead of a second request.
    usage: await readUsage(userId, provider),
  });
}
