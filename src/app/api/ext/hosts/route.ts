import { NextResponse } from "next/server";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { hostIntel } from "@/lib/ext/hostIntel";
import { EXT_HOSTS_MAX, type HostsRequest } from "@/lib/ext/types";
import { schemaMissing } from "@/lib/serpmon/store";

// POST /api/ext/hosts — everything OpenGSC knows about up to 100 hosts (own/PBN/DR/refdomains/
// age/SERP Monitor/links-to-us/outreach/drops) plus, when the overlay sent one, the query itself
// (own GSC rows, Rank Tracker, SERP Monitor keyword state, cached metrics). Local reads only —
// a fixed number of queries, never per host; nothing is fetched, nothing spent.

export async function POST(req: Request) {
  const auth = await extAuth(req, "read");
  if (!auth.ok) return auth.response;

  let body: HostsRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: auth.auth.cors });
  }
  if (!Array.isArray(body?.hosts) || body.hosts.length > EXT_HOSTS_MAX) {
    return NextResponse.json({ error: "too_many_hosts" }, { status: 400, headers: auth.auth.cors });
  }

  try {
    const data = await hostIntel(auth.auth.userId, {
      hosts: body.hosts,
      query: body.query != null ? String(body.query).slice(0, 500) : undefined,
      country: body.country != null ? String(body.country).slice(0, 2) : "",
      lang: body.lang != null ? String(body.lang).slice(0, 8) : "",
    });
    return NextResponse.json(data, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e) || schemaMissing(e)) {
      return NextResponse.json(
        { notMigrated: true, hosts: [], query: null, missing: { age: 0, dr: 0 } },
        { status: 200, headers: auth.auth.cors },
      );
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
