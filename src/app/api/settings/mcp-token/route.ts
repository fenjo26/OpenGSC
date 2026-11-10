import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { rawQuery, rawExec } from "@/lib/db/raw";
import { displayOf, newToken, storedFormOf } from "@/lib/security/apiTokens";
import { readMainUsage, resetMainUsage } from "@/lib/mcp/tokenAuth";
import { MAIN_TOKEN_PREFIX } from "@/lib/mcp/tokenScope";

// MCP access token management (Settings → API & MCP).
// GET    → { exists, display, usage }      — never the token itself: only its hash is stored
// POST   → generate (or rotate) the token; returns { token } — the one time it is shown
// DELETE → revoke the token
// Raw SQL so it degrades gracefully on a DB that hasn't run `prisma db push` yet
// (same convention as seo-sync / linkwatch).

const MANAGE = "manageSecrets" as const;

export async function GET() {
  const userId = await workspaceUserId(MANAGE);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const rows = await rawQuery<Array<{ mcpToken: string | null }>>(`SELECT mcpToken FROM "User" WHERE id = ?`, userId);
    const display = displayOf(rows?.[0]?.mcpToken);
    const usage = display ? await readMainUsage(userId) : null;
    return NextResponse.json({
      exists: !!display,
      display,
      usage: usage ? { lastUsedAt: usage.lastUsedAt, lastIp: usage.lastIp } : null,
    });
  } catch {
    return NextResponse.json({ exists: false, display: null, usage: null, notMigrated: true });
  }
}

export async function POST() {
  const userId = await workspaceUserId(MANAGE);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const token = newToken(MAIN_TOKEN_PREFIX);
  try {
    await rawExec(`UPDATE "User" SET mcpToken = ? WHERE id = ?`, storedFormOf(token), userId);
    await resetMainUsage(userId);
    return NextResponse.json({ token, display: displayOf(storedFormOf(token)) });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}

export async function DELETE() {
  const userId = await workspaceUserId(MANAGE);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await rawExec(`UPDATE "User" SET mcpToken = NULL WHERE id = ?`, userId);
  } catch { /* table/column missing — nothing to revoke */ }
  await resetMainUsage(userId);
  return NextResponse.json({ ok: true });
}
