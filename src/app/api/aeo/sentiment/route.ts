import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import {
  sentimentEstimate, runSentiment, sentimentAutoEnabled, sentimentSchemaMissing,
} from "@/lib/visibility/sentimentStore";

// N7 — sentiment of the answers the AEO tracker already stores.
//
// GET  is the price tag: how many answers a run would analyse and what it roughly costs in
//      tokens, without touching the provider.
// POST is the spend: one cheap LLM call per answer, on the provider configured in SEO Tools.
//      Processes up to 100 answers per call; the client loops while `remaining > 0`.

// GET /api/aeo/sentiment?siteId=…&days=7|30|90
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") || "";
  const days = parseInt(searchParams.get("days") || "30", 10) || 30;

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    const estimate = await sentimentEstimate(userId, siteId, days);
    if (!estimate) return NextResponse.json({ error: "Site not found" }, { status: 404 });
    return NextResponse.json({ ...estimate, auto: await sentimentAutoEnabled(userId, siteId) });
  } catch (e) {
    if (sentimentSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    throw e;
  }
}

// POST /api/aeo/sentiment  { siteId, days?, scope?: "us" | "all" }
// scope "us"    — answers where OUR brand is cited/mentioned (per-answer badge + our distribution).
// scope "all"   — the same answers plus every answer naming a tracked competitor; one call per
//                 answer either way (the verdicts come back per brand in that one call).
export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const siteId = String(b.siteId ?? "");
  const days = parseInt(String(b.days ?? "30"), 10) || 30;
  const scope: "us" | "all" = b.scope === "all" ? "all" : "us";

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    const r = await runSentiment(userId, siteId, days, scope);
    if (!r) return NextResponse.json({ error: "Site not found" }, { status: 404 });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (sentimentSchemaMissing(e)) return NextResponse.json({ notMigrated: true });
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "no_ai_key") return NextResponse.json({ error: "no_ai_key" }, { status: 400 });
    throw e;
  }
}
