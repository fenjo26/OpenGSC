import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { gbpAuthorizeUrl, gbpConfigured, gbpRedirectUri, reqOrigin } from "@/lib/local/gbp";

// GET /api/local/gbp/connect (act) — start the Business Profile OAuth flow: 302 to Google with
// a one-time state in a short-lived cookie. Scope is business.manage ONLY (brief §6); the
// tokens land in User.gbpToken and never reach the browser. The existing sign-in
// (src/lib/auth.ts) is not touched — this is a separate flow with its own redirect URI.

const STATE_COOKIE = "gbp_oauth_state";

export async function GET(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!gbpConfigured()) return NextResponse.json({ error: "gbp_not_configured" }, { status: 503 });

  const origin = reqOrigin(req);
  const state = crypto.randomUUID().replace(/-/g, "");
  const res = NextResponse.redirect(gbpAuthorizeUrl(gbpRedirectUri(origin), state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax", // a top-level redirect from Google must carry it back
    path: "/api/local/gbp",
    maxAge: 600,
    secure: origin.startsWith("https"),
  });
  return res;
}
