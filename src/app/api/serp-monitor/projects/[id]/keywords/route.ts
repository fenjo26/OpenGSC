import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { addKeywords, getProject, removeKeywords } from "@/lib/serpmon/store";
import { MAX_IMPORT_BYTES, readJson, serpmonError, tooLarge, unauthorized } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/serp-monitor/projects/[id]/keywords — import a pasted list, add or replace. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return unauthorized();
    const { id } = await params;
    const body = await readJson(req);
    if (!body) return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });

    const raw = typeof body.raw === "string" ? body.raw : "";
    if (!raw.trim()) return NextResponse.json({ error: "Nothing to import" }, { status: 400 });
    if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) return tooLarge();
    const mode = body.mode === "replace" ? "replace" as const : body.mode === "add" ? "add" as const : null;
    if (!mode) return NextResponse.json({ error: "mode must be \"add\" or \"replace\"" }, { status: 400 });

    const result = await addKeywords(userId, id, raw, mode);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ import: result });
  } catch (e) {
    return serpmonError(e);
  }
}

/** DELETE /api/serp-monitor/projects/[id]/keywords — remove keywords (their snapshots cascade). */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const userId = await workspaceUserId("act");
    if (!userId) return unauthorized();
    const { id } = await params;
    const body = await readJson(req);
    const idsRaw = Array.isArray(body?.ids) ? (body!.ids as unknown[]) : [];
    const ids = idsRaw.filter((x): x is string => typeof x === "string");
    if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });

    const removed = await removeKeywords(userId, id, ids);
    if (removed === 0 && (await getProject(userId, id)) === null) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ removed });
  } catch (e) {
    return serpmonError(e);
  }
}
