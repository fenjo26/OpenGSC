// N9 → Orbitra bridge: create one tracker campaign from a lead (name = the domain, unique
// alias, no streams invented). Idempotent in the friendly direction: a lead that already
// carries a campaign answers ok with `already` instead of creating a second one.

import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getLead, setLeadOrbitra } from "@/lib/leads/store";
import { createCampaignForLead, OrbitraError, readOrbitraConfig } from "@/lib/leads/orbitra";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const lead = await getLead(userId, id);
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (lead.orbitraAlias) {
    return NextResponse.json({ ok: true, already: true, campaignId: lead.orbitraCampaignId, alias: lead.orbitraAlias, url: (await readOrbitraConfig())?.url ?? "" });
  }
  const cfg = await readOrbitraConfig();
  if (!cfg) return NextResponse.json({ error: "not_configured" }, { status: 400 });
  try {
    const ref = await createCampaignForLead({ domain: lead.domain }, cfg);
    const updated = await setLeadOrbitra(userId, id, { campaignId: ref.id, alias: ref.alias });
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, campaignId: ref.id, alias: ref.alias, url: ref.url });
  } catch (e) {
    if (e instanceof OrbitraError) return NextResponse.json({ error: e.code }, { status: 502 });
    console.warn("[leads/orbitra] campaign create failed:", e);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
}
