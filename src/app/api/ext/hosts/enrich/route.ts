import { NextResponse } from "next/server";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { enrichHosts } from "@/lib/ext/hostIntel";
import { EXT_ENRICH_MAX } from "@/lib/ext/types";

// POST /api/ext/hosts/enrich — age (RDAP/WHOIS) and free-DR lookup for hosts the overlay shows
// as "not in the database yet". Network, but public sources only — refdomains are NOT fetched
// here (that is a paid path and needs its own confirm flow).

export async function POST(req: Request) {
  const auth = await extAuth(req, "act");
  if (!auth.ok) return auth.response;

  let body: { hosts?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: auth.auth.cors });
  }
  const hosts = Array.isArray(body?.hosts) ? body.hosts.map(String) : [];
  if (!hosts.length || hosts.length > EXT_ENRICH_MAX) {
    return NextResponse.json({ error: "too_many_hosts" }, { status: 400, headers: auth.auth.cors });
  }

  try {
    const data = await enrichHosts(auth.auth.userId, hosts);
    return NextResponse.json(data, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e)) {
      return NextResponse.json({ error: "not_migrated" }, { status: 200, headers: auth.auth.cors });
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
