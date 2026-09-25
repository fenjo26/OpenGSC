import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { localSchemaMissing, setGbpSelection } from "@/lib/local/store";

// PUT /api/local/gbp/select { siteId, account, location } (act) — remember which GBP account and
// location this site publishes to (LocalProfile.gbpAccount/gbpLocation). A null pair clears the
// selection. The profile must exist first — the selection without NAP data has nothing to
// publish for.

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { siteId?: string; account?: string | null; location?: string | null };
  const siteId = String(body?.siteId ?? "");
  if (!siteId) return NextResponse.json({ error: "site_id_required" }, { status: 400 });
  const account = body.account == null ? null : String(body.account).trim() || null;
  const location = body.location == null ? null : String(body.location).trim() || null;

  try {
    await setGbpSelection(userId, siteId, account, location);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    if (message === "site_not_found") return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    // update on a profile that does not exist — the UI creates the card first
    if (localSchemaMissing(error) || /no record was found/i.test(message)) {
      if (localSchemaMissing(error)) return NextResponse.json({ notMigrated: true });
      return NextResponse.json({ error: "profile_required" }, { status: 400 });
    }
    console.warn("[local] GBP select failed:", error);
    return NextResponse.json({ error: "gbp_select_failed" }, { status: 500 });
  }
}
