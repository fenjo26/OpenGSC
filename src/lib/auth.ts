import type { Account, NextAuthOptions, Profile } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "./prisma";
import {
  authorizeSingleOwnerGoogleSignIn,
  createOwnerSessionClaims,
  isAuthorizedOwnerSessionToken,
  type GoogleSignInAttempt,
  type SingleOwnerAuthStore,
} from "./singleOwnerAuth";

const useSecureCookies = process.env.NEXTAUTH_URL?.startsWith("https://") ?? false;

const singleOwnerAuthStore: SingleOwnerAuthStore = {
  async readIdentityState(providerAccountId) {
    const [users, account, googleAccountCount] = await Promise.all([
      prisma.user.findMany({
        orderBy: { id: "asc" },
        take: 2,
        select: { id: true, email: true, name: true, image: true },
      }),
      prisma.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId,
          },
        },
        select: {
          id: true,
          userId: true,
          provider: true,
          providerAccountId: true,
        },
      }),
      prisma.account.count({ where: { provider: "google" } }),
    ]);

    return {
      users,
      account: account
        ? {
            id: account.id,
            userId: account.userId,
            provider: account.provider,
            providerAccountId: account.providerAccountId,
          }
        : null,
      googleAccountCount,
    };
  },
  async reconcileOwnerAccount(owner, accountInput) {
    const providerAccountId = accountInput.providerAccountId;
    if (
      accountInput.type !== "oauth" ||
      accountInput.provider !== "google" ||
      !providerAccountId
    ) {
      return false;
    }

    return prisma.$transaction(async (tx) => {
      const users = await tx.user.findMany({
        orderBy: { id: "asc" },
        take: 2,
        select: { id: true, email: true },
      });
      if (
        users.length !== 1 ||
        users[0]?.id !== owner.id ||
        users[0].email !== owner.email
      ) {
        return false;
      }

      const existing = await tx.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId,
          },
        },
      });
      if (existing && existing.userId !== owner.id) return false;
      if (!existing) {
        const googleAccountCount = await tx.account.count({
          where: { provider: "google" },
        });
        if (googleAccountCount !== 0) return false;
      }

      const account = await tx.account.upsert({
        where: {
          provider_providerAccountId: {
            provider: "google",
            providerAccountId,
          },
        },
        create: {
          userId: owner.id,
          type: "oauth",
          provider: "google",
          providerAccountId,
          access_token: accountInput.accessToken,
          refresh_token: accountInput.refreshToken,
          expires_at: accountInput.expiresAt,
          id_token: accountInput.idToken,
          scope: accountInput.scope,
          token_type: accountInput.tokenType,
        },
        update: {
          access_token: accountInput.accessToken,
          refresh_token: accountInput.refreshToken ?? existing?.refresh_token,
          expires_at: accountInput.expiresAt,
          id_token: accountInput.idToken,
          scope: accountInput.scope ?? existing?.scope,
          token_type: accountInput.tokenType,
        },
      });
      await tx.account.deleteMany({
        where: {
          userId: owner.id,
          provider: "google",
          id: { not: account.id },
        },
      });

      return true;
    });
  },
};

function googleSignInAttempt(
  account: Account | null,
  profile: Profile | undefined,
): GoogleSignInAttempt {
  return {
    expectedOwnerEmail: process.env.OPENGSC_EXPECTED_OWNER_EMAIL,
    profile,
    account: account
      ? {
          type: account.type,
          provider: account.provider,
          providerAccountId: account.providerAccountId,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          idToken: account.id_token,
          scope: account.scope,
          tokenType: account.token_type,
        }
      : null,
  };
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
    async signIn({ account, profile }) {
      const authorization = await authorizeSingleOwnerGoogleSignIn(
        googleSignInAttempt(account, profile),
        singleOwnerAuthStore,
      );
      return authorization.allowed;
    },

    async session({ session, token }) {
      if (session?.user && token?.sub) {
        session.user.id = token.sub;
      }
      return session;
    },

    async jwt({ token, user, account, profile }) {
      if (user && account && profile) {
        const claims = createOwnerSessionClaims(
          googleSignInAttempt(account, profile),
          user.id,
        );
        if (!claims) throw new Error("Could not authorize owner session");
        Object.assign(token, claims);
        return token;
      }
      if (
        !isAuthorizedOwnerSessionToken(
          token,
          process.env.OPENGSC_EXPECTED_OWNER_EMAIL,
        )
      ) {
        throw new Error("Invalid or expired owner session");
      }
      return token;
    },
  },
};
