import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getAeoDomainLists, saveAeoDomainLists } from "@/lib/visibility/domainListStore";

// R+, Wave A — the operator-editable per-category domain lists the citation classifier consults
// as an overlay on its built-in defaults (plan §7.4). Instance-wide, so no siteId: GET/PUT with
// the workspace auth the sibling AEO routes use; the save path sanitizes every entry (the store
// drops what is not a bare host), and the response echoes the CLEAN lists so the editor shows
// what actually stuck rather than what was typed.

// GET /api/aeo/domain-lists → { lists: { forum: [...], … } } (empty object before first save)
export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ lists: await getAeoDomainLists() });
}

// PUT /api/aeo/domain-lists  { lists: { forum: [...], … } }
// Saving empty lists (or an empty object) clears the overlay — reset is the same gesture as edit.
export async function PUT(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  try {
    const lists = await saveAeoDomainLists(b?.lists);
    return NextResponse.json({ ok: true, lists });
  } catch (e) {
    // InstanceSetting predates the wave, but a not-yet-pushed schema on some install still
    // deserves the honest "not migrated" the other AEO routes answer with, not a 500.
    const v = e as { code?: string; message?: string };
    if (v?.code === "P2025" || v?.code === "P2021" || /no such table/i.test(String(v?.message ?? ""))) {
      return NextResponse.json({ notMigrated: true });
    }
    throw e;
  }
}
