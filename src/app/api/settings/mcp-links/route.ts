import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { dbAny } from "@/lib/prisma";
import { displayOf, newToken, storedFormOf } from "@/lib/security/apiTokens";
import { LINK_TOKEN_PREFIX } from "@/lib/mcp/tokenScope";

// Connector links (Settings → API & MCP): separate MCP tokens meant to travel in a URL, for
// clients such as Claude Desktop whose connector dialog has no header field. Read + free actions
// by default; publishing and spending are opt-in per link. See src/lib/mcp/tokenScope.ts.
//
// GET    → { links: [...] }                       — never a token; only the display prefix
// POST   { label, allowWrite, allowSpend } → { link, token }   — the one time the token is shown
// DELETE ?id=                                    — revoke one link
//
// Owner-only (manageSecrets), like the main token. Degrades to { notMigrated: true } until
// `prisma db push` has created the McpLink table.

const MANAGE = "manageSecrets" as const;
const MAX_LINKS = 20;

interface LinkRow {
  id: string; label: string; tokenHash: string; allowWrite: boolean; allowSpend: boolean;
  createdAt: Date; lastUsedAt: Date | null; lastIp: string | null;
}

function dto(r: LinkRow) {
  return {
    id: r.id,
    label: r.label,
    display: displayOf(r.tokenHash),
    allowWrite: !!r.allowWrite,
    allowSpend: !!r.allowSpend,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    lastIp: r.lastIp,
  };
}

export async function GET() {
  const userId = await workspaceUserId(MANAGE);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const rows: LinkRow[] = await dbAny.mcpLink.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return NextResponse.json({ links: rows.map(dto) });
  } catch {
    return NextResponse.json({ links: [], notMigrated: true });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId(MANAGE);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
  const token = newToken(LINK_TOKEN_PREFIX);
  try {
    const count: number = await dbAny.mcpLink.count({ where: { userId } });
    if (count >= MAX_LINKS) return NextResponse.json({ error: "too_many_links" }, { status: 409 });
    const row: LinkRow = await dbAny.mcpLink.create({
      data: {
        userId,
        label,
        tokenHash: storedFormOf(token),
        allowWrite: body.allowWrite === true,
        allowSpend: body.allowSpend === true,
      },
    });
    return NextResponse.json({ link: dto(row), token });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const userId = await workspaceUserId(MANAGE);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
  try {
    const { count } = await dbAny.mcpLink.deleteMany({ where: { id, userId } });
    if (!count) return NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "not_migrated" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
