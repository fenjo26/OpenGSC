import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { decode } from "next-auth/jwt";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "./prisma";

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
    async signIn({ user, account }) {
      // A credentials sign-in has already been validated in `authorize`, and it must never reach
      // the Google linking logic below, which rewrites the session onto the owner's identity.
      if (account?.provider === "credentials") return true;
      if (account?.provider !== "google") return false;

      // ── Find the owner (first user ever created) ──────────────────────────
      const owner = await prisma.user.findFirst({ orderBy: { id: "asc" } });

      if (!owner) {
        // No users yet → first login, PrismaAdapter creates the user automatically.
        return true;
      }

      // ── Check if this Google account is already linked ────────────────────
      const existing = await prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId: account.providerAccountId,
          },
        },
      });

      if (existing) {
        // Refresh tokens
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
        // A Google account that is not linked yet may only be attached by the owner, from inside an
        // active session — the "add another Google account" button in Settings.
        //
        // Before this check, anyone who found the login page could sign in with Google and have
        // their account attached to this instance as an extra Search Console connection. They never
        // received a session, so they could not read anything, but their properties and their OAuth
        // tokens landed in someone else's database uninvited.
        if (!(await ownerSessionPresent(owner.id))) {
          console.warn("[auth] rejected an unsolicited Google account link:", account.providerAccountId);
          return "/login?error=owner_only";
        }
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

      // If the OAuth email is different from the owner's email, redirect to settings 
      // instead of returning true. This prevents NextAuth from trying to create a new User 
      // and a new Account (which would crash due to the unique constraint).
      if (account.providerAccountId !== owner.email && user.email !== owner.email) {
        return "/settings";
      }

      // Reaching here means the Google account belongs to the owner, so signing in this way stays
      // available — both doors work, and which one you use is a preference. What was closed is the
      // other case: a Google account that is not the owner's no longer attaches itself to this
      // instance, and adding one is an owner action taken from inside a session.
      //
      // A password still matters, and the app asks for one, because Google is a dependency this
      // dashboard should not need in order to let its own owner in.

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
