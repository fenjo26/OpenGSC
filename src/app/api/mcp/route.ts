import { NextResponse } from "next/server";
import { MCP_TOOLS, findTool, type McpTool } from "@/lib/mcp/tools";
import { effectiveCapabilities, statusGrantsAccess, type Capability, type WorkspaceRole } from "@/lib/team/roles";
import { workspaceOwner } from "@/lib/team/workspace";
import { rawQuery } from "@/lib/db/raw";
import { resolveMcpCredential } from "@/lib/mcp/tokenAuth";
import { refusal, type TokenGrant } from "@/lib/mcp/tokenScope";
import pkg from "../../../../package.json";

// MCP (Model Context Protocol) endpoint — Streamable HTTP transport, stateless mode.
// Lets AI agents (Claude Code, Cursor, Codex, any MCP client) query this instance's
// SEO data with the user's MCP token (Settings → API & MCP).
//
// Connect from Claude Code:
//   claude mcp add --transport http opengsc https://your-domain.com/api/mcp \
//     --header "Authorization: Bearer <token>"
//
// Protocol: JSON-RPC 2.0 over POST. We answer every request with a plain JSON body
// (the spec explicitly allows servers to respond with application/json instead of an
// SSE stream), keep no session state, and support: initialize, ping, tools/list,
// tools/call. Notifications get 202 Accepted.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "opengsc", version: pkg.version };

const INSTRUCTIONS =
  "OpenGSC — self-hosted Google Search Console dashboard with rank tracking, AI-answer-engine (AEO) visibility, content decay and CTR analysis, backlinks, a competitor Link Monitor plus manual Outreach Workspace, a built-in site-audit crawler, separate GEO audits, a private indexer network, and an AI SEO content suite. " +
  "Call get_capabilities first: it reports which modules actually hold data and groups every tool by what calling it costs. Then list_sites for exact site identifiers.\n\n" +
  "Cost tiers, and they matter:\n" +
  "• local — reads the instance's own database. Free, instant, the large majority of tools.\n" +
  "• quota — query_gsc_live, inspect_url, get_analytics call Google on the owner's OAuth: free, but they spend a daily quota. Prefer the local equivalent when it answers the question.\n" +
  "• net — fetches a third-party page over HTTP.\n" +
  "• paid — spends the OWNER'S OWN AI credits. These refuse to run without confirm: true. Ask the human before setting it.\n\n" +
  "To optimize a page, the intended path is free: get_optimization_brief returns that URL's queries, striking-distance keywords, CTR gaps, decay trend, cannibalization conflicts, audit issues and current content in one call — write the new version yourself, then verify it with analyze_text (deterministic uniqueness, invented-number detection and heading-structure check, no model involved). start_rewrite_job and start_generation_job exist for when the user specifically wants the app's own pipeline. Both bill the user, and both are ASYNCHRONOUS — they return a job id, and you poll get_generation_job. Never expect a paid tool to hand back finished text in its own response: a page takes minutes to rewrite, far longer than any client will hold a tool call open.";

/*
 * Where the token comes from (src/lib/mcp/tokenAuth.ts → extractMcpToken).
 *
 * The header is the right place and every CLI client uses it. Claude Desktop cannot:
 * its "Add custom connector" dialog takes a URL, and the only auth fields behind
 * Advanced settings are OAuth Client ID and Client Secret. So a URL parameter is still
 * accepted — but a URL ends up in access logs, browser history, connector configs,
 * screenshots and support chats, so what it can do is limited (tokenScope.ts): the main
 * token sent in a URL only reads and runs free actions, and Claude Desktop users get a
 * connector link (McpLink) whose rights the owner chooses and can revoke on its own.
 */

/**
 * An MCP token belongs to a person, and that person has a role. A member's agent therefore reads
 * the owner's data — there is no other data on the instance — but inherits the same ceiling as the
 * member: a viewer's agent cannot start a paid job just because it was handed a token. The ceiling
 * is the member's *effective* capabilities — role matrix plus the owner's per-member overrides —
 * so an agent and a signed-in member can never disagree about what is allowed.
 */
async function tokenWorkspace(actorId: string): Promise<{ ownerId: string; role: WorkspaceRole; capabilities: readonly Capability[] } | null> {
  const owner = await workspaceOwner();
  if (!owner) return null;
  if (owner.id === actorId) return { ownerId: owner.id, role: "owner", capabilities: effectiveCapabilities("owner", null) };
  const resolve = (row: { role: string }) => {
    const role = String(row.role) as WorkspaceRole;
    return {
      ownerId: owner.id,
      role,
      capabilities: effectiveCapabilities(role, (row as { capabilities?: string | null }).capabilities ?? null),
    };
  };
  try {
    const rows = await rawQuery<{ role: string; status: string; capabilities?: string | null }[]>(
      `SELECT role, status, capabilities FROM "Membership" WHERE ownerId = ? AND userId = ? LIMIT 1`,
      owner.id, actorId,
    );
    const row = rows?.[0];
    if (!row || !statusGrantsAccess(String(row.status))) return null;
    return resolve(row);
  } catch {
    // The capabilities column may lag a `db push` — re-read without it; overrides read as absent.
    try {
      const rows = await rawQuery<{ role: string; status: string }[]>(
        `SELECT role, status FROM "Membership" WHERE ownerId = ? AND userId = ? LIMIT 1`,
        owner.id, actorId,
      );
      const row = rows?.[0];
      if (!row || !statusGrantsAccess(String(row.status))) return null;
      return resolve(row);
    } catch {
      return null; // no Membership table yet: only the owner can hold a working token
    }
  }
}

// Translate the registry's `cost` into the protocol's own hints, so a client that shows
// tool badges or asks for confirmation on non-read-only calls gets the right signal
// without parsing our prose. openWorldHint is true for anything that leaves the box.
function describeTool(t: McpTool) {
  const cost = t.cost ?? "local";
  const readOnly = t.readOnly ?? cost !== "paid";
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.name,
      readOnlyHint: readOnly,
      destructiveHint: t.destructive ?? false,
      idempotentHint: t.idempotent ?? (readOnly && cost === "local"),
      openWorldHint: t.openWorld ?? cost !== "local",
    },
    _meta: { cost },
  };
}

/** A JSON-RPC 2.0 message; `tools/call` params carry the tool name and its `arguments` object. */
type RpcMsg = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> & { arguments?: Record<string, unknown> } };

const rpcResult = (id: RpcMsg["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcMsg["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

type CallScope = { role: WorkspaceRole; capabilities: readonly Capability[]; grant: TokenGrant };

async function handleMessage(msg: RpcMsg, userId: string, ws: CallScope): Promise<object | null> {
  const { id, method, params } = msg;

  // Notifications (no id) get no response body.
  if (id === undefined && method?.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS.map(describeTool) });

    case "tools/call": {
      const name = String(params?.name ?? "");
      const tool = findTool(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      // The registry already declares what a call costs, so the permission follows from the tool
      // rather than from a second list that can drift out of sync with it — then the credential
      // may narrow it further (a token sent in a URL, a connector link; see tokenScope.ts).
      const refused = refusal(name, tool, ws.role, ws.capabilities, ws.grant);
      if (refused) {
        return rpcResult(id, { content: [{ type: "text", text: refused }], isError: true });
      }
      try {
        const result = await tool.handler(userId, params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
      } catch (e) {
        // Tool-level errors go back as tool results (isError) so the agent can read and react.
        return rpcResult(id, { content: [{ type: "text", text: String((e as Error)?.message ?? e) }], isError: true });
      }
    }

    // Optional protocol surface we don't implement — empty lists keep clients happy.
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(req: Request) {
  const credential = await resolveMcpCredential(req);
  const person = credential ? await tokenWorkspace(credential.actorId) : null;
  const userId = person?.ownerId ?? null;
  const workspace: CallScope | null = person && credential
    ? { role: person.role, capabilities: person.capabilities, grant: credential.grant }
    : null;
  if (!userId || !workspace) {
    return NextResponse.json(rpcError(null, -32001, "Unauthorized: pass your MCP token as 'Authorization: Bearer <token>' (generate one in OpenGSC → Settings → API & MCP)"), { status: 401 });
  }

  let body: RpcMsg | RpcMsg[];
  try { body = await req.json(); } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(m => handleMessage(m, userId, workspace)))).filter(Boolean);
    if (!responses.length) return new Response(null, { status: 202 });
    return NextResponse.json(responses);
  }

  const response = await handleMessage(body, userId, workspace);
  if (!response) return new Response(null, { status: 202 }); // notification
  return NextResponse.json(response);
}

// Stateless server: no SSE stream to resume, no session to delete.
//
// The spec requires 405 when a client opens a GET expecting an SSE stream, so that
// branch stays. Everything else reaching GET is a human with curl or a browser
// checking whether the endpoint is alive — answering those with a bare
// "Method Not Allowed" string is what makes a misconfigured token look like a dead
// endpoint. They get JSON describing how to talk to it instead.
export async function GET(req: Request) {
  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  const userId = (await resolveMcpCredential(req))?.actorId ?? null;
  return NextResponse.json({
    server: SERVER_INFO,
    protocolVersion: PROTOCOL_VERSION,
    transport: "streamable-http (stateless JSON-RPC 2.0 over POST)",
    authenticated: !!userId,
    toolCount: MCP_TOOLS.length,
    hint: userId
      ? "Authenticated. POST JSON-RPC here, e.g. {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}. GET /api/mcp/tools lists the tools as plain JSON."
      : "No valid MCP token. Send 'Authorization: Bearer ogsc_…' (generate one in OpenGSC → Settings → API & MCP).",
  }, { status: userId ? 200 : 401 });
}
export async function DELETE() {
  return new Response(null, { status: 200 });
}
