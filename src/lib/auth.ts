import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { decode } from "next-auth/jwt";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "./prisma";
import { ownerAuthState } from "./team/owner";
import { decideGoogleSignIn, envFlag, parseEmailList } from "./googleSignIn";

const useSecureCookies = process.env.NEXTAUTH_URL?.startsWith("https://") ?? false;


/**
 * True when the request carries a valid session cookie belonging to the owner.
 *
 * NextAuth v4 does not hand the request to `signIn`, so the cookie is read from the App Router
 * context and decoded with the same secret. A decode failure is treated as "not the owner": the
 * consequence is a refused account link, which is recoverable, while the opposite default would
 * leave the hole open.
 */
async function ownerSessionPresent(ownerId: string): Promise<boolean> {
  try {
    const store = await cookies();
    const raw = store.get(useSecureCookies ? "__Secure-next-auth.session-token" : "next-auth.session-token")?.value
      ?? store.get("next-auth.session-token")?.value;
    if (!raw) return false;
    const token = await decode({ token: raw, secret: process.env.NEXTAUTH_SECRET ?? "" });
    return token?.sub === ownerId;
  } catch (error) {
    console.warn("[auth] could not read the current session while linking a Google account:", error);
    return false;
  }
}



export const authOptions: NextAuthOptions = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: PrismaAdapter(prisma as any),
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  cookies: useSecureCookies ? {
    sessionToken: {
      name: "__Secure-next-auth.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true },
    },
  } : undefined,
  pages: {
    signIn: "/login",
  },
  providers: [
    // Team members sign in with an email and a password, never with Google.
    //
    // The reason is not technical. An agency employee's Google account carries their own Search
    // Console properties — personal sites, old projects — and signing them in through Google would
    // pull those into the agency's workspace. Work and personal data must not mix in either
    // direction, so a member account is a login, not an identity that owns anything.
    CredentialsProvider({
      id: "credentials",
      name: "Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, image: true, passwordHash: true, isOwner: true },
        }).catch(() => null);

        // Always spend a comparison, even with no user and no hash. Returning early on an unknown
        // address makes the response measurably faster and turns the login form into an account
        // enumerator.
        const hash = user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
        const valid = await bcrypt.compare(password, hash).catch(() => false);
        if (!user || !user.passwordHash || !valid) return null;

        // A password account is worthless without a live membership: revoking access is a single
        // status change, and it takes effect on the very next request.
        if (!user.isOwner) {
          const membership = await (prisma as any).membership.findFirst({
            where: { email, status: "active" },
            select: { id: true },
          }).catch(() => null);
          if (!membership) return null;
        }

        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly",
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
        },
      },
    }),
  ],

  callbacks: {
    async signIn({ user, account, profile }) {
      // A credentials sign-in has already been validated in `authorize`, and it must never reach
      // the Google linking logic below, which rewrites the session onto the owner's identity.
      if (account?.provider === "credentials") return true;
      if (account?.provider !== "google") return false;

      // The owner is the account marked `isOwner` — the same one every other part of the app uses.
      // This used to be "the first user by id", which stopped being true after an ownership
      // transfer: the previous owner kept signing in as the owner through Google, and the new owner
      // could not connect a single Google account because their session never matched.
      const owner = await ownerAuthState();
      if (owner === undefined) return "/login?error=unavailable";

      const existing = owner ? await prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId: account.providerAccountId,
          },
        },
      }) : null;

      const decision = decideGoogleSignIn({
        owner: owner ? { email: owner.email, hasPassword: owner.hasPassword } : null,
        ownerSession: owner ? await ownerSessionPresent(owner.id) : false,
        accountLinked: !!existing && existing.userId === owner?.id,
        email: user.email ?? null,
        emailVerified: (profile as { email_verified?: boolean } | undefined)?.email_verified,
        bootstrapEmails: parseEmailList(process.env.OPENGSC_OWNER_EMAIL),
        googleLoginForced: envFlag(process.env.OPENGSC_ALLOW_GOOGLE_LOGIN),
      });

      // Every refusal is decided here, on the server, before a session exists. Hiding the button on
      // /login is only courtesy: /api/auth/signin/google stays reachable, because connecting data
      // sources needs it, and this callback is what makes it lead nowhere for anyone else.
      if (decision.kind === "deny") {
        console.warn(`[auth] refused a Google sign-in (${decision.reason}):`, account.providerAccountId);
        return `/login?error=${decision.reason}`;
      }

      // No users yet → PrismaAdapter creates this one, and it becomes the owner.
      if (decision.kind === "bootstrap" || !owner) return true;

      // ── Store fresh tokens, or attach the account (link only) ─────────────
      if (existing) {
        await prisma.account.update({
          where: { id: existing.id },
          data: {
            access_token:  account.access_token,
            refresh_token: account.refresh_token ?? existing.refresh_token,
            expires_at:    account.expires_at,
            id_token:      account.id_token,
            scope:         account.scope ?? existing.scope,
          },
        });
      } else {
        // Reached only as `link`: `decideGoogleSignIn` never lets an unconnected account through a
        // login. Before that rule, anyone who found the login page could sign in with Google and
        // have their properties and OAuth tokens attached to someone else's instance.
        await prisma.account.create({
          data: {
            userId:            owner.id,
            type:              account.type,
            provider:          account.provider,
            providerAccountId: account.providerAccountId,
            refresh_token:     account.refresh_token,
            access_token:      account.access_token,
            expires_at:        account.expires_at,
            token_type:        account.token_type,
            scope:             account.scope,
            id_token:          account.id_token,
          },
        });
      }

      // Connecting an account from Settings: the owner's session is already the right one. Returning
      // a URL ends the OAuth round-trip without issuing a new session, which also keeps NextAuth
      // from trying to create a second User for a Google address that is not the owner's.
      if (decision.kind === "link") return "/settings";

      // `login`: the owner's own connected account, with Google login open (no password yet, or
      // the operator forced it). The session is issued for the owner's row, not the adapter's.
      user.id    = owner.id;
      user.email = owner.email!;
      user.name  = owner.name;
      user.image = owner.image;
      return true;
    },

    async session({ session, token }) {
      if (session?.user && token?.sub) {
        // @ts-ignore
        session.user.id = token.sub;
      }
      return session;
    },

    async jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
  },
};
