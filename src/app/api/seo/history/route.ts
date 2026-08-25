import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery, rawExec } from "@/lib/db/raw";

// The SEO Tools History store. SeoHistory IS the source of truth (the browser's localStorage
// is a cache of the newest records), so reads paginate instead of capping what exists.
// GET ?index=1       → { rows } — EVERY record, thin (no data/meta): powers client-side search,
//                      filters and exact counts without shipping megabytes of article bodies
// GET ?limit&offset  → { records, total } (newest first, data included)
// GET ?ids=a,b,c     → { records } — full bodies for up to 100 ids (score badges per page)
// GET ?id=X          → { record } (single record, for detail pages past the local cache)
// PUT { records }    → upsert the given records (client pushes only its dirty ids)
// DELETE ?id=X       → delete one record;  DELETE ?all=1 → wipe the user's history

const COLS = `id, type, keyword, status, data, meta, createdAt`;

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

function mapRow(r: any) {
  return {
    id: r.id, type: r.type, keyword: r.keyword, status: r.status,
    createdAt: new Date(r.createdAt).getTime(),
    data: safeParse(r.data), meta: r.meta ? safeParse(r.meta) : undefined,
  };
}

function thinRow(r: any) {
  return { id: r.id, type: r.type, keyword: r.keyword, status: r.status, createdAt: new Date(r.createdAt).getTime() };
}

// Numeric-clamped and interpolated, not parameterised: LIMIT ?/OFFSET ? placeholders are
// rejected by some MySQL driver modes, and the clamp guarantees these are integers.
const lim = (v: number | null, dflt: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(1, Math.floor(n)));
};

export async function GET(req: Request) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  try {
    if (sp.get("index")) {
      const rows: any[] = await rawQuery(
        `SELECT id, type, keyword, status, createdAt FROM "SeoHistory" WHERE userId = ? ORDER BY createdAt DESC, id DESC`, userId);
      return NextResponse.json({ rows: rows.map(thinRow), total: rows.length });
    }
    const idsParam = sp.get("ids");
    if (idsParam) {
      const ids = idsParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 100);
      if (!ids.length) return NextResponse.json({ records: [] });
      const ph = ids.map(() => "?").join(",");
      const rows: any[] = await rawQuery(
        `SELECT ${COLS} FROM "SeoHistory" WHERE userId = ? AND id IN (${ph})`, userId, ...ids);
      return NextResponse.json({ records: rows.map(mapRow) });
    }
    const id = sp.get("id");
    if (id) {
      const one: any[] = await rawQuery(
        `SELECT ${COLS} FROM "SeoHistory" WHERE id = ? AND userId = ? LIMIT 1`, id, userId);
      return NextResponse.json({ record: one.length ? mapRow(one[0]) : null });
    }
    const limit = lim(Number(sp.get("limit")), 50, 200);
    const offset = Math.max(0, Math.floor(Number(sp.get("offset")) || 0));
    const rows: any[] = await rawQuery(
      `SELECT ${COLS} FROM "SeoHistory" WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, userId);
    const counted: any[] = await rawQuery(
      `SELECT COUNT(*) as c FROM "SeoHistory" WHERE userId = ?`, userId);
    return NextResponse.json({ records: rows.map(mapRow), total: Number(counted[0]?.c ?? rows.length) });
  } catch {
    return NextResponse.json({ records: [], total: 0, notMigrated: true });
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return s; } }

export async function PUT(req: Request) {
  const userId = await uid("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }
  const records: any[] = Array.isArray(body?.records) ? body.records.slice(0, 200) : [];
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
        // `userId`, `type` and `createdAt` are inserted but never updated: the browser cache
        // only refreshes content it owns, and a record's identity must not drift on refresh.
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
