// Site-identifier resolution shared by every API route that authorizes against a site.
//
// A /site/<x> page route may carry either the site's UUID (Site.id) or its domain (Site.url) —
// the dashboard client sends whatever the route gave it (`propDomain || params.id`), so both
// forms reach the API as the same "which site?" parameter. Matching both keeps /site/<uuid>
// and /site/albokl.com working alike. The two value spaces are disjoint (a cuid never looks
// like a domain and vice versa), so the OR cannot widen what matches in practice — and the
// ownership / share constraints around it stay exactly as strict as before.

/** Prisma where-fragment matching a site by UUID or domain. */
export function siteWhere(identifier: string): { OR: [{ id: string }, { url: string }] } {
  return { OR: [{ id: identifier }, { url: identifier }] };
}

export interface SiteAccessDeps {
  getSession: () => Promise<{ user?: { id?: string } } | null>;
  findFirst: (args: { where: Record<string, unknown> }) => Promise<unknown>;
}

/**
 * Resolve the site a request may act on, via session ownership or a share token.
 * Contract (covered by src/lib/siteMatch.test.ts):
 *  - share token: site must match identifier AND shareToken AND shareEnabled — owner id comes
 *    from the site itself (a share is scoped to that one site, never a session);
 *  - session: site must match identifier AND belong to the logged-in user — another user's
 *    site (by id OR domain) does not resolve;
 *  - no session and no/invalid token, or a nonexistent identifier: null.
 */
export async function resolveSiteAccess(
  req: Request,
  siteIdOrDomain: string,
  deps: SiteAccessDeps,
): Promise<{ userId: string; site: unknown } | null> {
  const session = await deps.getSession();
  const loggedInUserId = session?.user?.id;

  const { searchParams } = new URL(req.url);
  const shareToken = searchParams.get('shareToken') ?? undefined;

  if (shareToken) {
    const site = await deps.findFirst({
      where: { shareToken, shareEnabled: true, ...siteWhere(siteIdOrDomain) },
    });
    if (site) return { userId: (site as { userId: string }).userId, site };
  }

  if (loggedInUserId) {
    const site = await deps.findFirst({
      where: { userId: loggedInUserId, ...siteWhere(siteIdOrDomain) },
    });
    if (site) return { userId: loggedInUserId, site };
  }

  return null;
}
