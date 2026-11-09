import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";

// POST /api/ext/insights — the panel's OpenGSC tab: main GSC query vs title/H1, sitemap
// membership, free meta suggestions, footprint across the network. Reads only. E0 lays the
// guard; the body is wave-ext E2 (src/lib/ext/insights.ts).

export async function POST(req: Request) {
  const auth = await extAuth(req, "read");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: auth.auth.cors });
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
