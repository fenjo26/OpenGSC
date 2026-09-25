import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { backlinksNotMigrated, buildDisavowForSite, setDisavow } from "@/lib/backlinks/store";

// The disavow contour (N2, brief §3).
//
// GET  /api/backlinks/disavow?siteId=&mode=domain|urls → text/plain; charset=utf-8 with
//      Content-Disposition: attachment; filename="disavow-<host>-<date>.txt". Owner session
//      only on purpose: the share view is read-only WITHOUT disavow — this file is the
//      operator's strategic decision, not client-report material.
// PATCH /api/backlinks/disavow { siteId, ids[] | domains[] | allToxic, disavow, note? } — the
//      ONLY writer of the disavow flag anywhere. Contract shape is { ids[], disavow, note? };
//      `domains` (the UI marks whole donors, whose row counts run to hundreds) and `allToxic`
//      (the "mark all toxic" button) are additive selection modes, never new semantics.

const MODES = new Set(["domain", "urls"]);

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get("siteId") ?? "";
  const modeRaw = searchParams.get("mode") ?? "domain";
  const mode = MODES.has(modeRaw) ? (modeRaw as "domain" | "urls") : "domain";

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    const file = await buildDisavowForSite(site.id, mode);
    return new NextResponse(file.text, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (backlinksNotMigrated(error)) {
      return NextResponse.json({ notMigrated: true, hint: "Run `npx prisma db push` to create the disavow columns." });
    }
    console.error("[backlinks-disavow] GET failed:", error);
    return NextResponse.json({ error: "disavow_read_failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body.siteId ?? "");
  const disavow = body.disavow === true;
  const note = typeof body.note === "string" ? body.note : undefined;
  const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  const domains: string[] = Array.isArray(body.domains) ? body.domains.map(String).filter(Boolean) : [];
  const allToxic = body.allToxic === true;

  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });
  if (typeof body.disavow !== "boolean") return NextResponse.json({ error: "disavow (boolean) required" }, { status: 400 });
  if (!ids.length && !domains.length && !allToxic) {
    return NextResponse.json({ error: "ids, domains or allToxic required" }, { status: 400 });
  }

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    const updated = await setDisavow(site.id, { ids, domains, allToxic, disavow, note });
    return NextResponse.json({ updated });
  } catch (error) {
    if (backlinksNotMigrated(error)) {
      return NextResponse.json({ notMigrated: true, hint: "Run `npx prisma db push` to create the disavow columns." });
    }
    if (String((error as Error)?.message) === "ids_or_domains_required") {
      return NextResponse.json({ error: "ids_or_domains_required" }, { status: 400 });
    }
    console.error("[backlinks-disavow] PATCH failed:", error);
    return NextResponse.json({ error: "disavow_patch_failed" }, { status: 500 });
  }
}
