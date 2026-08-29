// Request gate for the whole app — formerly `src/middleware.ts`.
//
// Renamed for Next.js 16, which deprecated the `middleware` convention in favour of `proxy`.
// The functionality is unchanged, but the runtime is not: proxy runs on **Node.js**, and unlike
// middleware that is not configurable. That removes the constraint this file used to work
// around — Prisma could now run here — but the MCP token check stays in the route regardless,
// because a per-request database lookup on the gate that fronts every request is a cost with no
// matching benefit. See docs/ARCHITECTURE.md §6.

import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

/**
 * The header the matched path travels on.
 *
 * Spelled out again in `src/lib/team/workspace.ts`, which reads it, rather than imported from
 * here: this file imports next-auth/middleware, and a route bundle has no business pulling that
 * in to learn a string. The two are asserted equal in workspaceCallContext.test.ts.
 */
export const ROUTE_HEADER = "x-opengsc-route";

/**
 * The request headers a route handler sees, carrying the path this request matched.
 *
 * A handler cannot see its own matched path — `headers()` returns HTTP headers, and the route is
 * not one of them — but the proxy can, and it runs in front of every route. So it writes the
 * path down, which is the only honest value for the provider log's `feature`: anything else
 * would be a name someone chose for a route rather than the route.
 *
 * Any inbound value is deleted before ours is written. `set` would replace it anyway; the
 * `delete` is here so that remains true of this function rather than of Headers' semantics. The
 * field is only a label, but a label an outsider can forge is worse than none — it puts a name
 * of their choosing on the rows an operator reads to see what a user was doing.
 */
export function withRouteHeader(req: { headers: Headers; nextUrl: { pathname: string } }): Headers {
  const headers = new Headers(req.headers);
  headers.delete(ROUTE_HEADER);
  headers.set(ROUTE_HEADER, req.nextUrl.pathname);
  return headers;
}

export default withAuth(
  function proxy(req) {
    return NextResponse.next({ request: { headers: withRouteHeader(req) } });
  },
  {
    callbacks: {
      // Allow, in addition to authenticated owners:
      //   • the public guest dashboard pages  (/share/[siteId]/[token])
      //   • API calls that carry a shareToken  (each such route re-validates the token
      //     against site.shareToken + shareEnabled, so this is not a bypass — endpoints
      //     without shareToken support still enforce their own getServerSession check)
      //   • the MCP endpoint, which authenticates with a Bearer token instead of a
      //     session cookie. Without this, withAuth answers an agent's POST with a 307
      //     to /api/auth/signin and the client gets the HTML login page instead of
      //     JSON-RPC — the route's own Bearer check never gets to run. The check is
      //     not skipped, only moved: /api/mcp validates User.mcpToken itself and
      //     answers a JSON-RPC 401 when it is missing or wrong.
      authorized: ({ token, req }) => {
        const { pathname, searchParams } = req.nextUrl;
        if (pathname === "/api/indexer/webhook") return true;
        if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) return true;
        //   • /.well-known/* — MCP clients probe /.well-known/oauth-protected-resource and
        //     /.well-known/oauth-authorization-server before connecting, to discover whether
        //     the server wants OAuth. Nothing serves those paths here, so the correct answer
        //     is 404 = "no OAuth, use the token you were given". Behind withAuth they instead
        //     answered 307 to the HTML login page, which a client can read as an OAuth server
        //     that exists, sending it into an authorization flow this server cannot complete.
        //     The connector then fails with nothing useful in the error.
        if (pathname.startsWith("/.well-known/")) return true;
        // Accepting an invitation happens before the account exists, so it cannot require a session.
        if (pathname === "/join" || pathname === "/api/team/accept") return true;
        if (pathname.startsWith("/share/")) return true;
        if (pathname.startsWith("/api/") && searchParams.has("shareToken")) return true;
        return !!token;
      },
    },
  }
);

// Protect all routes except /login and /api/auth
export const config = {
  matcher: [
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico|favicon.svg|logo.svg|.*\\.svg$|.*\\.png$|.*\\.ico$).*)",
  ],
};
