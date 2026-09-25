import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { gbpExchangeCode, gbpRedirectUri, reqOrigin } from "@/lib/local/gbp";

// GET /api/local/gbp/callback — Google lands here with ?code&state (or ?error). The state must
// match the cookie /connect set; then the code is exchanged and the tokens stored on the user,
// and the browser goes back to /local with a one-word verdict in ?gbp= for the banner.

const STATE_COOKIE = "gbp_oauth_state";

function cookieValue(req: Request, name: string): string {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function back(verdict: string, origin: string): NextResponse {
  const res = NextResponse.redirect(`${origin.replace(/\/+$/, "")}/local?gbp=${verdict}`);
  res.cookies.delete(STATE_COOKIE); // one-shot either way
  return res;
}

export async function GET(req: Request) {
  const origin = reqOrigin(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const denied = url.searchParams.get("error");

  if (denied) return back("denied", origin);
  if (!code || !state || state !== cookieValue(req, STATE_COOKIE)) return back("state", origin);

  const userId = await workspaceUserId("act");
  if (!userId) return back("unauthorized", origin);

  const ok = await gbpExchangeCode(userId, code, gbpRedirectUri(origin));
  return back(ok ? "connected" : "failed", origin);
}
