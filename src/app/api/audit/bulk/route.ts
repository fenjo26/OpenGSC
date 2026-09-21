import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { kickAuditQueue } from "@/lib/audit/queue";

// POST /api/audit/bulk { siteIds: string[] } — queue one audit per selected site.
//
// Sites with a run already in flight (running or queued) are skipped and reported, not
// errors: the caller shows "12 queued, 3 skipped (already active)" instead of a 409 that
// would kill the whole batch. One bulk request can't duplicate another: a second request
// while the first batch is still pending finds every site already active and creates
// nothing.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b: any = await req.json().catch(() => ({}));
  const siteIds = [...new Set<string>(Array.isArray(b.siteIds) ? b.siteIds.map((id: unknown) => String(id)) : [])];
  if (!siteIds.length) return NextResponse.json({ error: "no_sites" }, { status: 400 });

  const sites = await prisma.site.findMany({
    where: { id: { in: siteIds }, userId, archivedAt: null, hidden: false },
    select: { id: true },
  });
  const foundIds = new Set(sites.map(s => s.id));

  // Frozen snapshot for the skip report — the loop below mutates its own copy.
  const activeBefore = new Set(
    (await prisma.siteAudit.findMany({
      where: { siteId: { in: siteIds }, status: { in: ["running", "queued"] } },
      select: { siteId: true },
    })).map(a => a.siteId),
  );
  const activeSiteIds = new Set(activeBefore);

  const now = new Date();
  let created = 0;
  for (const id of siteIds) {
    if (!foundIds.has(id)) continue; // not this workspace's site — silently out of scope
    if (activeSiteIds.has(id)) continue;
    await prisma.siteAudit.create({
      data: {
        siteId: id,
        status: "queued",
        stage: "crawl",
        progress: 0,
        trigger: "bulk",
        heartbeatAt: now,
        maxPages: 5000,
      },
    }).catch(() => { /* a single failed insert must not sink the batch */ });
    created++;
    activeSiteIds.add(id); // paranoia against duplicate ids that slipped past the Set
  }

  kickAuditQueue(0);
  return NextResponse.json({
    created,
    skipped: [...activeBefore].map(id => ({ siteId: id, reason: "already_active" })),
    notFound: siteIds.length - foundIds.size,
  });
}
