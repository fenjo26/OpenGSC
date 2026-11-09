import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";

// POST /api/ext/hosts — everything OpenGSC knows about up to 100 hosts (+ the query itself when
// called from the SERP overlay), in a fixed number of DB reads. E0 lays the guard; the body is
// wave-ext E5 (src/lib/ext/hostIntel.ts). Local data only — nothing is fetched, nothing spent.

export async function POST(req: Request) {
  const auth = await extAuth(req, "read");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: auth.auth.cors });
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
