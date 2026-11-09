import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";

// POST /api/ext/hosts/enrich — age (RDAP/WHOIS) and free-DR lookup for hosts the overlay shows
// as "not in the database yet". Network, but public sources only — refdomains are NOT fetched
// here (that is a paid path and needs its own confirm flow). E0 lays the guard; body is wave-ext
// E5 (src/lib/ext/hostIntel.ts → enrichHosts).

export async function POST(req: Request) {
  const auth = await extAuth(req, "act");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: auth.auth.cors });
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
