import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";

// POST /api/ext/serp/action — the overlay's buttons: track the query in Rank Tracker, add it to
// a SERP Monitor project, or put a host on drops-watch. All local writes, one body shape per
// `kind`. E0 lays the guard; the body is wave-ext E5.

export async function POST(req: Request) {
  const auth = await extAuth(req, "write");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: auth.auth.cors });
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
