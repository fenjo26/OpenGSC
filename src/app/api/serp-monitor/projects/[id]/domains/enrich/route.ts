// SERP Monitor — one bounded enrichment step (age and/or DR) for the project's pending hosts.
//
// The step is capped at 45 s and 100 hosts; the answer carries `remaining` so the client can
// call again until it hits zero or the user presses stop. `keyFound: false` means the instance
// has no Ahrefs key at all — the UI should say so instead of spinning through the loop.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { workspaceUserId } from "@/lib/team/workspace";
import { isSchemaMissing } from "@/lib/serpmon/domains";
import { enrichPendingHosts, pendingHostIds, serpmonDrKeyFound } from "@/lib/serpmon/enrich";

const STEP_MS = 45_000;
const STEP_LIMIT = 100;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let owned: { id: string } | null = null;
  try {
    owned = await prisma.serpProject.findFirst({ where: { id, userId }, select: { id: true } });
  } catch (e) {
    if (isSchemaMissing(e)) {
      return NextResponse.json({ notMigrated: true, age: 0, dr: 0, errors: 0, remaining: 0 });
    }
    throw e;
  }
  if (!owned) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const what = body?.what === "age" || body?.what === "dr" ? body.what : "both";
  const asked = Array.isArray(body?.hostIds)
    ? [...new Set(body.hostIds.map(Number).filter((n: number) => Number.isInteger(n)))] : [];

  // Scope the step to this project's pending hosts, narrowed further by what the client asked
  // for; host ids from the body never widen it (SerpHost is a shared dictionary).
  const projectPending = await pendingHostIds(id, what, 5000);
  const hostIds = asked.length ? projectPending.filter(h => asked.includes(h)) : projectPending;

  const result = await enrichPendingHosts({
    limit: STEP_LIMIT,
    deadline: Date.now() + STEP_MS,
    userId,
    hostIds,
    what,
  });
  const remaining = (await pendingHostIds(id, what, 5000)).length;
  const keyFound = what === "dr" || what === "both" ? await serpmonDrKeyFound(userId) : undefined;

  return NextResponse.json({
    age: result.age,
    dr: result.dr,
    errors: result.errors,
    remaining,
    ...(keyFound !== undefined ? { keyFound } : {}),
  });
}
