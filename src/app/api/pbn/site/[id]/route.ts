import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getSite, listPages, listLinks, updateSite, pbnSchemaMissing } from "@/lib/pbn/store";
import { siteDiskDir } from "@/lib/pbn/restore";
import { promises as fs } from "node:fs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const site = await getSite(userId, id);
    if (!site) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const [pages, links] = await Promise.all([listPages(id), listLinks(id)]);
    return NextResponse.json({
      site: { ...site, pagesFailed: safe(site.pagesFailed), cleanedStats: safe(site.cleanedStats) },
      pages: pages.map(p => ({ ...p, blocks: safe(p.blocks) })), links,
    });
  } catch (e) {
    if (pbnSchemaMissing(e)) return NextResponse.json({ error: "pbn_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** PATCH { snapshotTimestamp } — сменить снимок; клиент затем перезапускает restore. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const ts = typeof body?.snapshotTimestamp === "string" && /^\d{14}$/.test(body.snapshotTimestamp) ? body.snapshotTimestamp : "";
    if (!ts) return NextResponse.json({ error: "bad_snapshot" }, { status: 400 });
    // Новый снимок — старые файлы на диске больше не актуальны: чистим каталог, иначе restoreSite
    // засчитает уже лежащие файлы как «восстановленные» и оставит контент прошлого снимка.
    const site = await getSite(userId, id);
    if (site) { try { await fs.rm(siteDiskDir(userId, site.domain), { recursive: true, force: true }); } catch { /* каталога могло не быть */ } }
    await updateSite(userId, id, { snapshotTimestamp: ts, status: "scanning", pagesRestored: 0, diskPath: null });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (pbnSchemaMissing(e)) return NextResponse.json({ error: "pbn_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

function safe(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }
