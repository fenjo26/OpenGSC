// SERP Monitor — one bounded referring-domain enrichment step for the project's pending hosts.
//
// Unlike the age/DR step this one BILLS the workspace owner's SEO-metrics units (one floored
// backlinks-stats call per registrable), so it answers on the "spend" capability, not "act".
// The step is capped at 45 s and 60 registrables; the answer carries `remaining` so the client
// can call again until it hits zero or the user presses stop. `noKey: true` means the instance
// has no SEO-metrics key at all — the UI must say so instead of spinning through the loop.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { workspaceUserId } from "@/lib/team/workspace";
import { isSchemaMissing } from "@/lib/serpmon/domains";
import { enrichHostRefdomains, pendingHostIds } from "@/lib/serpmon/enrich";

const STEP_MS = 45_000;
const STEP_LIMIT = 60; // registrables — each is one priced provider call

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let owned: { id: string } | null = null;
  try {
    owned = await prisma.serpProject.findFirst({ where: { id, userId }, select: { id: true } });
  } catch (e) {
    if (isSchemaMissing(e)) {
      return NextResponse.json({ notMigrated: true, updated: 0, remaining: 0, noKey: false, errors: 0 });
    }
    throw e;
  }
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const asked = Array.isArray(body?.hostIds)
    ? [...new Set(body.hostIds.map(Number).filter((n: number) => Number.isInteger(n)))] : [];

  // Scope the step to this project's pending hosts, narrowed further by what the client asked
  // for; host ids from the body never widen it (SerpHost is a shared dictionary).
  const projectPending = await pendingHostIds(id, "refdomains", 5000);
  const hostIds = asked.length ? projectPending.filter(h => asked.includes(h)) : projectPending;

  const result = await enrichHostRefdomains({
    userId,
    hostIds,
    limit: STEP_LIMIT,
    deadline: Date.now() + STEP_MS,
  });
  return NextResponse.json(result);
}
