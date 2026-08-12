import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import type { Capability } from "@/lib/team/roles";
import { randomBytes } from "crypto";
import { rawQuery, rawExec } from "@/lib/db/raw";

// MCP access token management (Settings → API & MCP).
// GET    → { token: string | null }
// POST   → generate (or rotate) the token; returns { token }
// DELETE → revoke the token
// Raw SQL so it degrades gracefully on a DB that hasn't run `prisma db push` yet
// (same convention as seo-sync / linkwatch).

async function uid(capability: Capability = "read"): Promise<string | null> {
return workspaceUserId(capability);
}

export async function GET() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const rows: any[] = await rawQuery(`SELECT mcpToken FROM "User" WHERE id = ?`, userId);
    return NextResponse.json({ token: rows?.[0]?.mcpToken ?? null });
  } catch {
    return NextResponse.json({ token: null, notMigrated: true });
  }
}

export async function POST() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const token = "ogsc_" + randomBytes(24).toString("hex");
  try {
    await rawExec(`UPDATE "User" SET mcpToken = ? WHERE id = ?`, token, userId);
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}

export async function DELETE() {
  const userId = await uid("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await rawExec(`UPDATE "User" SET mcpToken = NULL WHERE id = ?`, userId);
  } catch { /* table/column missing — nothing to revoke */ }
  return NextResponse.json({ ok: true });
}
