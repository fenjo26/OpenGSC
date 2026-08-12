import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { createOutreachCampaign, createOutreachProspect, listOutreach } from "@/lib/outreach/service";

async function uid(capability: Capability = "read") {
return workspaceUserId(capability);
}

const errorStatus = (message: string) => message.endsWith("_not_found") ? 404 : message.endsWith("_exists") ? 409 : message.includes("required") || message.startsWith("invalid_") ? 400 : 500;

function outreachSchemaMissing(error: any): boolean {
  if (error?.code === "P2021" || error?.code === "P2022") return true;
  const message = String(error?.message ?? "");
  return /Outreach(?:Campaign|Prospect|StageEvent).*(?:does not exist|no such table)/i.test(message);
}

export async function GET(req: Request) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  try {
    return NextResponse.json(await listOutreach(userId, { stage: params.get("stage") || undefined, campaignId: params.get("campaignId") || undefined }));
  } catch (error: any) {
    if (outreachSchemaMissing(error)) {
      return NextResponse.json({ campaigns: [], prospects: [], backlinks: [], stats: null, notMigrated: true });
    }
    return NextResponse.json({ error: "outreach_load_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "campaign") return NextResponse.json({ campaign: await createOutreachCampaign(userId, body) }, { status: 201 });
    const result = await createOutreachProspect(userId, body);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error: any) {
    const message = String(error?.message ?? "outreach_error");
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
