import { NextResponse } from "next/server";
import { ownerAuthState } from "@/lib/team/owner";
import { envFlag, googleLoginOpen } from "@/lib/googleSignIn";

// GET /api/auth/login-options — which sign-in doors the login page should show.
//
// Public on purpose (it sits under /api/auth, which the proxy never gates): the page is rendered for
// people who are not signed in. It reveals two bits — whether this instance has an owner yet, and
// whether Google is still a login — both of which anyone could learn by clicking the button.
//
// This route decides nothing. The same rule is enforced in the NextAuth `signIn` callback, so a
// stale or forged answer here can only change what the page shows, never who gets in.
export async function GET() {
  const owner = await ownerAuthState();
  const forced = envFlag(process.env.OPENGSC_ALLOW_GOOGLE_LOGIN);
  // On a lookup failure show both doors and let the server refuse: hiding the password form would
  // lock out a working password owner over a transient error.
  const body = owner === undefined
    ? { ownerExists: true, google: true, password: true }
    : { ownerExists: owner !== null, google: googleLoginOpen(owner, forced), password: owner !== null };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
