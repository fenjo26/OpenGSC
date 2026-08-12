import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery, rawExec } from "@/lib/db/raw";

// Server-side backup of the SEO Tools history. localStorage stays the working cache;
// this survives browser-data resets. Raw SQL so it works without regenerating the client.
// GET               → { records: [...] } (newest first)
// PUT { records }   → upsert the given records (client pushes its current list)
// DELETE ?id=X      → delete one record;  DELETE ?all=1 → wipe the user's history

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

export async function GET() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const rows: any[] = await rawQuery(
      `SELECT id, type, keyword, status, data, meta, createdAt FROM "SeoHistory"
       WHERE userId = ? ORDER BY createdAt DESC LIMIT 100`, userId);
    const records = rows.map(r => ({
      id: r.id, type: r.type, keyword: r.keyword, status: r.status,
      createdAt: new Date(r.createdAt).getTime(),
      data: safeParse(r.data), meta: r.meta ? safeParse(r.meta) : undefined,
    }));
    return NextResponse.json({ records });
  } catch {
    return NextResponse.json({ records: [], notMigrated: true });
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return s; } }

export async function PUT(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }
  const records: any[] = Array.isArray(body?.records) ? body.records.slice(0, 100) : [];
  if (!records.length) return NextResponse.json({ ok: true, saved: 0 }); // never wipe on empty push
  let saved = 0;
  try {
    for (const r of records) {
      if (!r?.id || !r?.type || r.data == null) continue;
      const dataJson = JSON.stringify(r.data);
      if (dataJson.length > 1_500_000) continue; // sanity cap per record
      await runUpsert({
        table: "SeoHistory",
        conflict: ["id"],
        values: {
          id: String(r.id), userId, type: String(r.type),
          keyword: String(r.keyword ?? ""), status: String(r.status ?? "completed"),
          data: dataJson, meta: r.meta != null ? JSON.stringify(r.meta) : null,
          createdAt: new Date(Number(r.createdAt) || Date.now()).toISOString(),
          updatedAt: new Date().toISOString(),
        },
        // `userId`, `type` and `createdAt` are inserted but never updated: this is a backup of a
        // record the browser owns, and its identity must not drift when the copy is refreshed.
        update: { data: "set", meta: "set", status: "set", keyword: "set", updatedAt: "set" },
      });
      saved++;
    }
    return NextResponse.json({ ok: true, saved });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  try {
    if (searchParams.get("all") === "1") {
      await rawExec(`DELETE FROM "SeoHistory" WHERE userId = ?`, userId);
    } else {
      const id = String(searchParams.get("id") ?? "");
      if (!id) return NextResponse.json({ error: "no_id" }, { status: 400 });
      await rawExec(`DELETE FROM "SeoHistory" WHERE userId = ? AND id = ?`, userId, id);
    }
  } catch { /* table missing */ }
  return NextResponse.json({ ok: true });
}
