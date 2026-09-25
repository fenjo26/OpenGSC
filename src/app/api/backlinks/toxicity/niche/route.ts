import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { backlinksNotMigrated, readNiche, writeNiche } from "@/lib/backlinks/store";
import { MARKER_GROUPS } from "@/lib/backlinks/toxicity";

// PUT /api/backlinks/toxicity/niche { siteId, niche: string[] } — save the site's own niche.
// The niche is the contract's §0.1 escape hatch: marker groups that are NOT toxic for this
// site. Elements are validated against the marker vocabulary — a whole group code
// ("gambling_zh") or a prefix that covers a family ("gambling" → all three gambling groups).
// Junk is rejected rather than silently ignored: a typo like "gamblng" would otherwise turn a
// gambling site's whole profile toxic again and the operator would never see why.

function validNicheElement(el: string): boolean {
  if (!/^[a-z][a-z0-9_]*$/i.test(el)) return false;
  return MARKER_GROUPS.some((code) => code === el || code.startsWith(`${el}_`));
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const siteId = String(body.siteId ?? "");
  const raw: unknown[] = Array.isArray(body.niche) ? body.niche : [];
  if (!siteId) return NextResponse.json({ error: "siteId required" }, { status: 400 });
  if (!body.niche || !raw.length) return NextResponse.json({ error: "niche (string[]) required" }, { status: 400 });

  const niche = [...new Set(raw.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean))];
  if (niche.length > MARKER_GROUPS.length) {
    return NextResponse.json({ error: "too_many_niche_groups" }, { status: 400 });
  }
  const invalid = niche.filter((el) => !validNicheElement(el));
  if (invalid.length) {
    return NextResponse.json({ error: "invalid_niche_groups", invalid, valid: [...MARKER_GROUPS] }, { status: 400 });
  }

  const site = await prisma.site.findFirst({ where: { id: siteId, userId }, select: { id: true } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  try {
    await writeNiche(site.id, niche);
    return NextResponse.json({ niche: await readNiche(site.id) });
  } catch (error) {
    if (backlinksNotMigrated(error)) {
      return NextResponse.json({ notMigrated: true, hint: "Run `npx prisma db push` to add the backlinkNiche column." });
    }
    console.error("[backlinks-toxicity] niche save failed:", error);
    return NextResponse.json({ error: "niche_save_failed" }, { status: 500 });
  }
}
