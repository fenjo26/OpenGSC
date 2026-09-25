// N9 — proposal generation and export for one lead.
//
//   POST { include?: string[], lang } → deterministic markdown into Lead.proposal
//   GET  ?lang=                      → branded HTML (User.reportBranding, N8 — read only)
//                                       for download and browser printing
//
// No LLM anywhere in this path: every sentence comes from the findings dictionary, and the
// no-forecast rule (N9 brief §4) is enforced by generateProposal + its test.

import { NextResponse } from "next/server";
import { rawQuery } from "@/lib/db/raw";
import { workspaceUserId } from "@/lib/team/workspace";
import { generateProposal, parseBranding, proposalToHtml } from "@/lib/leads/proposal";
import { readWidgetSettings } from "@/lib/leads/settings";
import { getLead, LeadStoreError, updateLead } from "@/lib/leads/store";
import { normalizeLeadLang } from "@/lib/leads/types";


export const dynamic = "force-dynamic";

/** User.reportBranding (N8's white-label JSON), read tolerantly and never written. */
async function ownerBranding(userId: string): Promise<string | null> {
  try {
    const rows = await rawQuery<{ reportBranding?: string | null }[]>(
      `SELECT reportBranding FROM "User" WHERE id = ?`, userId,
    );
    return rows?.[0]?.reportBranding ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const body = await req.json().catch(() => ({})) as { include?: unknown; lang?: unknown };
  const lead = await getLead(userId, id);
  if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const widget = await readWidgetSettings(userId);
  const include = Array.isArray(body.include)
    ? body.include.map(code => String(code)).filter(Boolean)
    : undefined;
  const proposal = generateProposal({
    domain: lead.domain,
    score: lead.score,
    findings: lead.findings,
    lang: normalizeLeadLang(body.lang),
    aboutCompany: widget.settings.aboutCompany,
    include,
  });
  try {
    await updateLead(userId, id, { proposal });
  } catch (error) {
    if (error instanceof LeadStoreError) {
      return NextResponse.json({ error: error.code }, { status: error.code === "not_found" ? 404 : 500 });
    }
    throw error;
  }
  return NextResponse.json({ proposal });
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const lead = await getLead(userId, id);
  if (!lead || !lead.proposal) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const branding = parseBranding(await ownerBranding(userId));
  const html = proposalToHtml(lead.proposal, branding, `${lead.domain} — proposal`);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `inline; filename="proposal-${lead.domain}.html"`,
    },
  });
}
