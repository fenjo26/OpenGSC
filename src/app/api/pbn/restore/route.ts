import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { makePbnFetch, restoreSite, siteDiskDir, wipeDirIfNewSnapshot } from "@/lib/pbn/restore";
import { createOrGetSite, updateSite, replacePages, pbnSchemaMissing } from "@/lib/pbn/store";

export const dynamic = "force-dynamic";

/**
 * POST { domain, snapshotTimestamp, pageCap? } — один возобновляемый слайс восстановления.
 * Возвращает { done, remaining, pagesRestored } — клиент вызывает повторно, пока done=false
 * (архив вежливо ждёт ~1.5с на страницу, 100 страниц не влезают в один бюджет запроса).
 */
export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase() : "";
    const snapshotTimestamp = typeof body?.snapshotTimestamp === "string" ? body.snapshotTimestamp : "";
    if (!domain || !/^\d{14}$/.test(snapshotTimestamp)) return NextResponse.json({ error: "domain_and_snapshot_required" }, { status: 400 });
    const pageCap = Number(body?.pageCap) || undefined;

    const site = await createOrGetSite(userId, domain);
    const diskDir = siteDiskDir(userId, domain);
    // Другой снимок — прежняя выкачка недействительна: чистим каталог ДО restoreSite, иначе
    // файлы прошлого снимка засчитаются как восстановленные (смешение контента двух эпох).
    await wipeDirIfNewSnapshot(site.snapshotTimestamp, snapshotTimestamp, diskDir);
    await updateSite(userId, site.id, { status: "fetching", snapshotTimestamp });

    const fetch = await makePbnFetch(userId);
    const r = await restoreSite(domain, snapshotTimestamp, diskDir, fetch, { pageCap, deadlineMs: 40_000 });
    await replacePages(site.id, r.pages);
    await updateSite(userId, site.id, {
      status: r.done ? (r.pagesRestored > 0 ? (r.pagesFailed.length ? "partial" : "ready") : "error") : "fetching",
      pagesRequested: r.pagesRequested, pagesRestored: r.pagesRestored,
      pagesFailed: JSON.stringify(r.pagesFailed), cleanedStats: JSON.stringify(r.cleanedStats),
      diskPath: diskDir,
    });
    return NextResponse.json({ siteId: site.id, done: r.done, remaining: r.remaining, pagesRestored: r.pagesRestored, pagesFailed: r.pagesFailed, cleanedStats: r.cleanedStats });
  } catch (e) {
    if (pbnSchemaMissing(e)) return NextResponse.json({ error: "pbn_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
