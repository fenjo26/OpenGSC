import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  listDropGroups, createDropGroup, renameDropGroup, deleteDropGroup, schemaMissing,
} from "@/lib/drops/store";

// CRUD for the drops catalogue's curated groups ("выкупить в октябре", "отложить"). Rows are
// attached from the candidates route's bulk actions; deleting a group here leaves its rows in
// the catalogue ungrouped (FK is SetNull), which is the only semantics that makes sense — the
// group is a bookmark, the rows are the collection.

export async function GET() {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json(await listDropGroups(userId));
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const name = String(body?.name ?? "");
    if (!name.trim()) return NextResponse.json({ error: "name_required" }, { status: 400 });
    return NextResponse.json(await createDropGroup(userId, name));
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const id = String(body?.id ?? "");
    const name = String(body?.name ?? "");
    if (!id || !name.trim()) return NextResponse.json({ error: "id_and_name_required" }, { status: 400 });
    const ok = await renameDropGroup(userId, id, name);
    return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
    const ok = await deleteDropGroup(userId, id);
    return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
  } catch (e) {
    if (schemaMissing(e)) return NextResponse.json({ error: "drops_not_migrated" }, { status: 503 });
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
