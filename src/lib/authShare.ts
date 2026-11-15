import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { Site } from '@/generated/prisma';
import { resolveSiteAccess } from '@/lib/siteMatch';

export { siteWhere } from '@/lib/siteMatch';

export async function verifyAuthOrShare(
  req: Request,
  siteIdOrDomain: string,
  // Historically callers declared id vs url; the resolver accepts BOTH forms (see siteMatch),
  // so this is kept only for call-site compatibility and is ignored.
  _isDomain = false
): Promise<{ userId: string; site: Site } | null> {
  const r = await resolveSiteAccess(req, siteIdOrDomain, {
    getSession: () => getServerSession(authOptions),
    findFirst: (args) => prisma.site.findFirst(args as Parameters<typeof prisma.site.findFirst>[0]),
  });
  return r as { userId: string; site: Site } | null;
}
