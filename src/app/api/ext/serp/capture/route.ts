import { NextResponse } from "next/server";
import { extAuth, extPreflight, extTablesMissing } from "@/lib/ext/auth";
import { saveCapture, validateCapture } from "@/lib/ext/serpCapture";
import { schemaMissing } from "@/lib/serpmon/store";

// POST /api/ext/serp/capture — save one Google results page the user chose to capture from the
// browser. Writes SerpCapture only (never SerpSnapshot — see the model comment); fills the
// SerpUrl/SerpHost dictionaries and enriches brand-new hosts in the background.

export async function POST(req: Request) {
  const auth = await extAuth(req, "write");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: auth.auth.cors });
  }

  const parsed = validateCapture(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: auth.auth.cors });
  }

  try {
    const data = await saveCapture(auth.auth.userId, parsed.value);
    return NextResponse.json(data, { headers: auth.auth.cors });
  } catch (e) {
    if (extTablesMissing(e) || schemaMissing(e)) {
      return NextResponse.json({ error: "not_migrated" }, { status: 200, headers: auth.auth.cors });
    }
    throw e;
  }
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
