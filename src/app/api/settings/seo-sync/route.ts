import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { rawQuery, rawExec } from "@/lib/db/raw";

// Server-side backup of the browser-stored SEO Tools settings (API keys, providers,
// models, policies). The browser stays the working copy; this endpoint just persists a
// JSON snapshot per user so clearing site data doesn't lose the configuration.
// Raw SQL (not prisma.user.update) so it works without regenerating the Prisma client.

export async function GET() {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const rows: any[] = await rawQuery(`SELECT seoSettings FROM "User" WHERE id = ?`, userId);
    const raw = rows?.[0]?.seoSettings;
    return NextResponse.json({ settings: raw ? JSON.parse(raw) : null });
  } catch {
    return NextResponse.json({ settings: null }); // column not migrated yet — behave as empty
  }
}

export async function PUT(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }
  const settings = body?.settings;
  if (!settings || typeof settings !== "object") return NextResponse.json({ error: "no_settings" }, { status: 400 });
  const json = JSON.stringify(settings);
  if (json.length > 200_000) return NextResponse.json({ error: "too_large" }, { status: 413 });
  try {
    await rawExec(`UPDATE "User" SET seoSettings = ? WHERE id = ?`, json, userId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 }); // run: npx prisma db push
  }
}
