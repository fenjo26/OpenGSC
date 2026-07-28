import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MCP_TOOLS } from "@/lib/mcp/tools";

// GET /api/mcp/tools — the tool registry as plain JSON.
//
// Not part of the MCP protocol: a client discovers tools by POSTing a `tools/list`
// JSON-RPC message to /api/mcp. This exists for two other reasons.
//
// Debugging. When a connection fails, the first thing anyone does is open the URL in a
// browser or curl it, and getting a login page (the bug this endpoint was added
// alongside) or a bare 405 gives no way to tell "wrong token" from "wrong URL" from
// "server broken". Here, a correct token returns the tools and a wrong one says so.
//
// The settings UI. **Settings → API & MCP** used to render a hand-maintained array of
// tool names, which is a copy of the registry that nothing keeps in sync — it had drifted
// to roughly half the real list. It now reads this endpoint instead, so the panel cannot
// go stale again. That is why a logged-in session is accepted as well as a bearer token:
// the owner browsing their own settings page has no reason to paste their MCP token to
// see which tools exist.

async function authUserId(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const token = bearer || req.headers.get("x-api-key")?.trim() || "";
  if (token.startsWith("ogsc_")) {
    try {
      const rows: any[] = await prisma.$queryRawUnsafe(`SELECT id FROM "User" WHERE mcpToken = ?`, token);
      if (rows?.[0]?.id) return rows[0].id;
    } catch {
      // mcpToken column missing (prisma db push not run yet) — fall through to the session.
    }
  }
  // No token, or a token that matched nothing: accept the owner's own browser session.
  // Wrapped because this is the fallback branch — if the session lookup fails for any
  // reason, the honest answer is "not authorized", not a 500 on a diagnostic endpoint
  // whose whole purpose is to be readable when something else is already broken.
  try {
    const session = await getServerSession(authOptions);
    return ((session?.user as any)?.id as string) ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const userId = await authUserId(req);
  if (!userId) {
    return NextResponse.json({
      error: "unauthorized",
      message: "Pass your MCP token as 'Authorization: Bearer ogsc_…', or open this while signed in. Generate a token in OpenGSC → Settings → API & MCP.",
    }, { status: 401 });
  }

  const byCost = (c: string) => MCP_TOOLS.filter(t => (t.cost ?? "local") === c).map(t => t.name);
  return NextResponse.json({
    count: MCP_TOOLS.length,
    costs: {
      local: byCost("local"),
      quota: byCost("quota"),
      net: byCost("net"),
      paid: byCost("paid"),
    },
    tools: MCP_TOOLS.map(t => ({
      name: t.name,
      cost: t.cost ?? "local",
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    note: "MCP clients should not use this endpoint — POST a JSON-RPC 'tools/list' to /api/mcp instead. This is here for debugging a connection.",
  });
}
