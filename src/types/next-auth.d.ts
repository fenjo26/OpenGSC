import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }

  interface User {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sub: string;
    /**
     * `User.passwordUpdatedAt` in milliseconds at the moment this token was signed.
     * `0` means the column was null. Absent on tokens issued before the claim existed.
     */
    pwdAt?: number;
  }
}
