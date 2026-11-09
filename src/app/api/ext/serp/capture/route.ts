import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";

// POST /api/ext/serp/capture — save one Google results page the user chose to capture from the
// browser. Writes SerpCapture only (never SerpSnapshot — see the model comment). E0 lays the
// guard; the body is wave-ext E5 (src/lib/ext/serpCapture.ts).

export async function POST(req: Request) {
  const auth = await extAuth(req, "write");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: auth.auth.cors });
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
