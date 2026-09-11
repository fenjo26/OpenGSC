import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { getUserSettings } from "@/lib/mcp/shared";
import { dynadotCreds, dynadotSearch } from "@/lib/drops/dynadot";

// GET/POST /api/drops/registrar — configure and test the registrar second opinion.
//
// Guarded on `manageSecrets`, which is owner-only in lib/team/roles.ts. That is stricter than the
// rest of the drops module (`write`) and deliberately so: this route accepts an API key in the
// request body so the settings panel can test a key before saving it, and that key can register
// domains — it spends real money. The set of people allowed to hand this server a credential and
// have it make an authenticated call should be exactly the set of people who own the account.

export const dynamic = "force-dynamic";

/** A name that is certainly registered, and a name that is certainly not. */
const PROBE_TAKEN = "dynadot.com";
function probeFree(): string {
  // Random rather than fixed: a fixed probe name would eventually be registered by somebody, and
  // the connection test would start reporting a broken key on a working one.
  return `opengsc-probe-${Math.random().toString(36).slice(2, 12)}.com`;
}

export async function GET() {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const settings = await getUserSettings(userId);
  const fromEnv = Boolean((process.env.DYNADOT_API_KEY ?? "").trim());
  const configured = Boolean(dynadotCreds(settings));
  // The key itself is never returned — only whether one exists and where it came from. A
  // settings screen needs to show state, not re-display a secret it already has locally.
  return NextResponse.json({ configured, fromEnv });
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const op = String(body?.op ?? "ping");
  if (op !== "ping") return NextResponse.json({ error: "unknown_op" }, { status: 400 });

  const typed = String(body?.apiKey ?? "").trim();
  const creds = typed ? { apiKey: typed } : dynadotCreds(await getUserSettings(userId));
  if (!creds) return NextResponse.json({ error: "no_key" }, { status: 400 });

  const taken = await dynadotSearch(PROBE_TAKEN, creds, { keepRaw: true });
  const free = await dynadotSearch(probeFree(), creds, { keepRaw: true });

  // Both probes are returned raw on purpose, and this is the only place that happens.
  //
  // The response envelope could not be verified against a live account while this was written —
  // the documented fields are stable, the wrapper around them is not — so `findResultNode` walks
  // the body looking for them instead of assuming a path. Showing the operator exactly what
  // their account returns is what turns that tolerance into certainty: if the parser reads these
  // two probes correctly, it reads everything.
  return NextResponse.json({
    ok: taken.outcome.verdict !== "refused" && free.outcome.verdict !== "refused",
    probes: [
      { domain: PROBE_TAKEN, expected: "unavailable", got: taken.outcome, raw: taken.raw },
      { domain: "(random, certainly free)", expected: "available", got: free.outcome, raw: free.raw },
    ],
  });
}
