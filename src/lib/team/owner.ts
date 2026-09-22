import { prisma } from "@/lib/prisma";

/**
 * The account that owns this instance's data.
 *
 * `isOwner` is the explicit marker, but instances created before the column existed have it unset,
 * so the first user by id — the rule `auth.ts` used before it read this marker — is adopted and written back once.
 * Doing this lazily avoids a data migration in an updater that only runs `prisma db push`.
 */
export async function workspaceOwner(): Promise<{ id: string; email: string | null; name: string | null } | null> {
  try {
    const marked = await prisma.user.findFirst({
      where: { isOwner: true },
      select: { id: true, email: true, name: true },
    });
    if (marked) return marked;
  } catch {
    // Column not migrated yet: fall through to the historical rule.
    return prisma.user.findFirst({ orderBy: { id: "asc" }, select: { id: true, email: true, name: true } });
  }
  const first = await prisma.user.findFirst({ orderBy: { id: "asc" }, select: { id: true, email: true, name: true } });
  if (!first) return null;
  await prisma.user.update({ where: { id: first.id }, data: { isOwner: true } }).catch(() => { /* raced with another request */ });
  return first;
}

/**
 * The owner as the sign-in rules need them: identity plus whether a password exists.
 *
 * Read by the NextAuth `signIn` callback and by the public `/api/auth/login-options` route, so both
 * decide from the same row. A failed lookup returns `undefined` rather than `null`: `null` means "no
 * owner, this is a fresh instance", and confusing the two would hand ownership to whoever signs in
 * during a database hiccup.
 */
export async function ownerAuthState(): Promise<
  { id: string; email: string | null; name: string | null; image: string | null; hasPassword: boolean } | null | undefined
> {
  try {
    const owner = await workspaceOwner();
    if (!owner) return null;
    const row = await prisma.user.findUnique({ where: { id: owner.id }, select: { image: true, passwordHash: true } });
    return { ...owner, image: row?.image ?? null, hasPassword: !!row?.passwordHash };
  } catch (error) {
    console.error("[auth] could not resolve the workspace owner:", error);
    return undefined;
  }
}
