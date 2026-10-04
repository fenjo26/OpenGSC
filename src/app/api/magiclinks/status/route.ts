import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { magicProviderInfos } from "@/lib/magiclinks/providers";
import { FieldLinkClient } from "@/lib/magiclinks/fieldlink";
import { Magic369Client } from "@/lib/magiclinks/magic369";

// GET /api/magiclinks/status — which purchase providers are wired up, and their live balances.
//
// Read-guarded: balances are the operator's own money, but they are not a secret in the sense
// API keys are, and the buy button in striking needs this to decide what it is pointing at.
// Tokens themselves never travel back — only configured booleans and figures.
//
// POST — the settings card's test button. It tests what was TYPED, not what is stored, so a
// wrong token never gets persisted in the first place (same contract as the A-Parser card's
// ping). manageSecrets, like every other route that accepts a raw provider credential.

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const providers = await magicProviderInfos(userId);
    return NextResponse.json({ providers });
  } catch (e) {
    console.error("[MagicLinks] status failed", e);
    return NextResponse.json({ error: "status_failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("manageSecrets");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json().catch(() => ({}));
  const flToken = String(b?.fieldlinkToken ?? "").trim();
  const m369Token = String(b?.magic369Token ?? "").trim();

  const [fl, m] = await Promise.all([
    flToken
      ? new FieldLinkClient(flToken).balance()
        .then(bal => ({ ok: true, balanceMinor: bal.balanceMinor, message: null as string | null }))
        .catch((e: Error) => ({ ok: false, balanceMinor: null, message: String(e?.message ?? e) }))
      : Promise.resolve({ ok: false, balanceMinor: null, message: null }),
    m369Token
      ? new Magic369Client(m369Token).balance()
        .then(bal => ({ ok: true, balanceMinor: bal.balanceMinor, message: null as string | null }))
        .catch((e: Error) => ({ ok: false, balanceMinor: null, message: String(e?.message ?? e) }))
      : Promise.resolve({ ok: false, balanceMinor: null, message: null }),
  ]);

  return NextResponse.json({
    fieldlink: { tested: !!flToken, ...fl },
    magic369: { tested: !!m369Token, ...m },
  });
}
