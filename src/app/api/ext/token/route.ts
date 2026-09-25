import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { rawExec, rawQuery } from "@/lib/db/raw";
import { newExtToken } from "@/lib/ext/auth";
import { normalizeAllowedIdsInput } from "@/lib/ext/origin";

// /api/ext/token — browser-extension token management for the Settings card
// (ExtensionTokenCard). The ONLY /api/ext route guarded by the session instead of the Bearer
// token: the person who can open Settings is the person who may mint the token the extension
// then uses. Same shape and convention as /api/settings/mcp-token, raw SQL so an instance that
// hasn't run `prisma db push` degrades to a message instead of a 500.
//
// GET    → { token: string | null, allowedIds: string }   (extAllowedIds, newline-joined)
// POST   → generate or rotate the token; returns { token }
// DELETE → revoke the token (extension gets 401 everywhere immediately)
// PUT    → save extAllowedIds { allowedIds: string }; invalid lines are dropped and reported

const MANAGE = "manageSecrets" as const;

async function uid(): Promise<string | null> {
  return workspaceUserId(MANAGE);
}

export async function GET() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const rows: { extToken?: string | null; extAllowedIds?: string | null }[] = await rawQuery(
      `SELECT extToken, extAllowedIds FROM "User" WHERE id = ?`, userId,
    );
    return NextResponse.json({ token: rows?.[0]?.extToken ?? null, allowedIds: rows?.[0]?.extAllowedIds ?? "" });
  } catch {
    return NextResponse.json({ token: null, allowedIds: "", notMigrated: true });
  }
}

export async function POST() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const token = newExtToken();
  try {
    await rawExec(`UPDATE "User" SET extToken = ? WHERE id = ?`, token, userId);
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}

export async function DELETE() {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await rawExec(`UPDATE "User" SET extToken = NULL WHERE id = ?`, userId);
  } catch { /* column missing — nothing to revoke */ }
  return NextResponse.json({ ok: true });
}

export async function PUT(req: Request) {
  const userId = await uid();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { value, kept, dropped } = normalizeAllowedIdsInput(String(body.allowedIds ?? ""));
  try {
    await rawExec(`UPDATE "User" SET extAllowedIds = ? WHERE id = ?`, value, userId);
    return NextResponse.json({ allowedIds: value, kept, dropped });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}
