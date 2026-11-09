import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";

// POST /api/ext/meta-fit — suggest title/description inside the audit band. Without allowLlm
// it is pure string work ("act"); with allowLlm it may spend up to 2 repair calls on the
// instance owner's AI credits ("spend" + confirm). E0 lays the guard; the body is wave-ext E2.

export async function POST(req: Request) {
  const auth = await extAuth(req, "act");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: auth.auth.cors });
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
