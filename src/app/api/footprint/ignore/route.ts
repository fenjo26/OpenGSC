import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { workspaceUserId } from "@/lib/team/workspace";
import { parseIgnoreList, invalidateFootprintCache } from "@/lib/footprint/store";

// POST /api/footprint/ignore (CONTRACT §4, act) — "Fine, hide": the operator marks a skeleton
// as acceptable, it leaves the report and stops blocking the generator. Reversible: the same
// body with ignored:false removes it again (the page's "show hidden" rows offer exactly that).
// The list lives on User.footprintIgnore (JSON string[]); the cache is dropped so both the
// report and the generator see the change immediately.

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { skeleton?: unknown; ignored?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const skeleton = String(body.skeleton ?? "").trim();
  if (!skeleton) return NextResponse.json({ error: "skeleton_required" }, { status: 400 });
  const hide = body.ignored !== false; // default true — the button that posts here says "hide"

  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { footprintIgnore: true } });
    const current = new Set(parseIgnoreList(user?.footprintIgnore));
    if (hide) current.add(skeleton);
    else current.delete(skeleton);
    const list = [...current].slice(0, 5000); // sanity ceiling; the list is human-curated
    await prisma.user.update({ where: { id: userId }, data: { footprintIgnore: JSON.stringify(list) } });
    invalidateFootprintCache();
    return NextResponse.json({ ignored: list.length, hidden: hide });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (/footprintIgnore|no such column/i.test(message)) {
      return NextResponse.json({ notMigrated: true });
    }
    console.warn("[footprint] ignore failed:", error);
    return NextResponse.json({ error: "footprint_ignore_failed" }, { status: 500 });
  }
}
