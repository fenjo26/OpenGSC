import { NextResponse } from 'next/server';
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from '@/lib/prisma';
import {
  parseBacklinkImport, buildImportPlan, parseBacklinkFilters, buildBacklinkWhere,
  parseBacklinkSort, nofollowFilterCondition,
} from "@/lib/seo/backlinkImport";
import type { BacklinkListResponse, BacklinkListStats, BacklinkRow, BacklinkSource, PageStatus, PlacementStatus } from "@/lib/seo/backlinkTypes";

// Backlinks v2 (T5). Reads and writes go to SiteBacklink — the old `Backlink` model still
// exists behind /api/backlinks/check-alive and /api/backlinks/check-xr, which stay on it
// untouched per the task split; T0's migration copied their data here.
//
// Pre-T0 the generated client has no siteBacklink model; the cast keeps this route compiling
// before that merge lands (same pattern as placementRunner).
const store = () => (prisma as any).siteBacklink;

const PAGE_SIZES = [50, 100, 250, 500];
const IMPORT_ROW_CAP = 5000;

function toRow(b: any): BacklinkRow {
  return {
    id: b.id,
    urlFrom: b.urlFrom,
    urlTo: b.urlTo,
    domainFrom: b.domainFrom,
    favorite: b.favorite,
    source: (b.source ?? "manual") as BacklinkSource,
    sources: (b.sources ?? "").split(",").filter(Boolean),
    apiSeen: b.apiSeen,
    apiLost: b.apiLost,
    apiAnchor: b.apiAnchor,
    apiDr: b.apiDr,
    apiDofollow: b.apiDofollow,
    apiSponsored: b.apiSponsored,
    apiUgc: b.apiUgc,
    apiContent: b.apiContent,
    apiJsCrawl: b.apiJsCrawl,
    apiFirstSeen: b.apiFirstSeen,
    checkStatus: (b.checkStatus ?? "unchecked") as PlacementStatus,
    checkAnchor: b.checkAnchor,
    checkRel: b.checkRel,
    checkNofollow: b.checkNofollow,
    checkSponsored: b.checkSponsored,
    checkUgc: b.checkUgc,
    checkTargetOk: b.checkTargetOk,
    checkError: b.checkError,
    checkedAt: b.checkedAt ? new Date(b.checkedAt).toISOString() : null,
    pageStatus: (b.pageStatus ?? "unknown") as PageStatus,
    pageTitle: b.pageTitle,
    xrStatus: b.xrStatus,
    addedAt: new Date(b.addedAt).toISOString(),
  };
}

// GET /api/backlinks?siteDbId=&page=&pageSize=&status=&rel=&source=&domain=&drMin=&drMax=&favorite=&lost=&sort=
// pageSize may also be "all" (used by the tab's CSV export: the filter, not the visible page,
// is what the user expects in the file). `stats` is computed over the whole filtered set —
// "137 пропавших" must be the real number, not "how many fit on the page".
export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteDbId = searchParams.get('siteDbId') ?? '';
  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const parsedFilters = parseBacklinkFilters(searchParams);
  if (!parsedFilters.ok) return NextResponse.json({ error: parsedFilters.error }, { status: 400 });
  const filters = parsedFilters;

  const pageSizeRaw = searchParams.get('pageSize') ?? '50';
  const exportAll = pageSizeRaw === 'all';
  const pageSize = exportAll ? 50 : (PAGE_SIZES.includes(Number(pageSizeRaw)) ? Number(pageSizeRaw) : 50);
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const where = buildBacklinkWhere(siteDbId, filters);
  const orderBy = parseBacklinkSort(searchParams);

  const [rawRows, total, byStatus, apiLost, favorites, nofollow] = await prisma.$transaction([
    store().findMany({
      where, orderBy,
      ...(exportAll ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
    }),
    store().count({ where }),
    store().groupBy({ by: ['checkStatus'], where, _count: { _all: true } }),
    store().count({ where: { AND: [where, { apiLost: true }] } }),
    store().count({ where: { AND: [where, { favorite: true }] } }),
    store().count({ where: { AND: [where, nofollowFilterCondition] } }),
  ]);

  const statusCount = (name: string) =>
    (byStatus.find((s: any) => s.checkStatus === name)?._count?._all ?? 0) as number;

  const stats: BacklinkListStats = {
    total,
    found: statusCount('found'),
    missing: statusCount('missing'),
    blocked: statusCount('blocked'),
    unchecked: statusCount('unchecked'),
    apiLost,
    favorites,
    nofollow,
  };

  const body: BacklinkListResponse = {
    rows: (rawRows as any[]).map(toRow),
    total,
    page,
    pageSize,
    stats,
  };
  return NextResponse.json(body);
}

// POST /api/backlinks — { siteDbId, text, origin: "csv" | "manual" }
// The dialog previews client-side with the same pure parser this handler applies, so what the
// user saw is exactly what gets written. Writes only the operator field group (CONTRACT §1):
// urlFrom/urlFromNorm/urlTo/note/priceNote/source/sources — api* and check* are untouchable.
export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const text: string = typeof body.text === 'string' ? body.text : '';
  const origin: 'csv' | 'manual' = body.origin === 'csv' ? 'csv' : 'manual';

  if (!siteDbId || !text.trim())
    return NextResponse.json({ error: 'siteDbId and text required' }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const parsed = parseBacklinkImport(text);
  if (parsed.rows.length === 0)
    return NextResponse.json({ error: 'no valid urls', skipped: parsed.skippedRows }, { status: 400 });
  if (parsed.rows.length > IMPORT_ROW_CAP)
    return NextResponse.json({ error: `too many rows (${parsed.rows.length}, max ${IMPORT_ROW_CAP})` }, { status: 400 });

  const existingRaw = await store().findMany({
    where: { siteId: siteDbId },
    select: { id: true, urlFromNorm: true, urlTo: true, sources: true, note: true, priceNote: true },
  });
  const existing = (existingRaw as any[]).map(r => ({
    id: r.id,
    urlNorm: r.urlFromNorm,
    urlTo: r.urlTo,
    sources: String(r.sources ?? '').split(',').filter(Boolean),
    note: r.note ?? '',
    priceNote: r.priceNote ?? '',
  }));

  const plan = buildImportPlan(parsed, existing, origin);

  try {
    await prisma.$transaction([
      ...(plan.creates.length
        ? [store().createMany({ data: plan.creates.map(c => ({ ...c, siteId: siteDbId })) })]
        : []),
      ...plan.updates.map((u: any) => store().update({ where: { id: u.id }, data: u })),
    ], { timeout: 60000 });
  } catch (e: any) {
    // P2002 = a concurrent import created the same row between our snapshot and the write.
    if (e?.code === 'P2002') return NextResponse.json({ error: 'duplicate_import_race' }, { status: 409 });
    throw e;
  }

  return NextResponse.json({
    added: plan.creates.length,
    updated: plan.updates.length,
    skipped: parsed.skippedRows,
    duplicates: parsed.duplicates,
  });
}

// PATCH /api/backlinks — { siteDbId, id | ids, favorite }
// Favourites live in the DB, not localStorage: they must survive a browser change and be
// visible to the second person in the workspace.
export async function PATCH(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const ids: string[] = body.ids ?? (body.id ? [body.id] : []);
  const favorite = body.favorite === true;
  if (!siteDbId || ids.length === 0 || typeof body.favorite !== 'boolean')
    return NextResponse.json({ error: 'siteDbId, ids and favorite required' }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  const res = await store().updateMany({ where: { siteId: siteDbId, id: { in: ids } }, data: { favorite } });
  return NextResponse.json({ updated: res.count });
}

// DELETE /api/backlinks — { siteDbId, ids? , filter? }
// `filter` is the same object the GET accepts, so "delete everything the current filter
// matches" really means everything — the client confirms the affected count (stats.total)
// before calling. With neither ids nor filter nothing is deleted: an empty body must not
// be a whole-table wipe.
export async function DELETE(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const siteDbId: string = body.siteDbId;
  const ids: string[] = body.ids ?? [];
  const filterObj = (body.filter && typeof body.filter === 'object' && !Array.isArray(body.filter)) ? body.filter : null;

  if (!siteDbId) return NextResponse.json({ error: 'siteDbId required' }, { status: 400 });
  if (ids.length === 0 && !filterObj)
    return NextResponse.json({ error: 'ids or filter required' }, { status: 400 });

  const site = await prisma.site.findFirst({ where: { id: siteDbId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

  let where: Record<string, unknown>;
  if (ids.length > 0) {
    where = { siteId: siteDbId, id: { in: ids } };
  } else {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(filterObj!)) {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    }
    const parsed = parseBacklinkFilters(sp);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    where = buildBacklinkWhere(siteDbId, parsed);
  }

  const res = await store().deleteMany({ where });
  return NextResponse.json({ deleted: res.count });
}
