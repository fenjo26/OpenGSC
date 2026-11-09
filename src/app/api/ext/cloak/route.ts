import { NextResponse } from "next/server";
import { extAuth, extPreflight } from "@/lib/ext/auth";

// POST /api/ext/cloak — does this URL serve the same page to Googlebot and to a browser?
// Two page fetches (bot UA + browser UA, Referer from the SERP — that is how gambling cloaking
// is usually wired) plus snippet matching. E0 lays the guard; the body is wave-ext E5.

export async function POST(req: Request) {
  const auth = await extAuth(req, "act");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ error: "not_implemented" }, { status: 501, headers: auth.auth.cors });
}

export async function OPTIONS(req: Request) {
  return extPreflight(req);
}
