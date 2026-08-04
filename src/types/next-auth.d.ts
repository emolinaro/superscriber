import type { DefaultSession } from "next-auth";
import type { UserRole } from "@/domain/models";
import type { AuthSource } from "@/server/db/schema";

declare module "next-auth" {
  interface Session {
    user?: DefaultSession["user"] & {
      id: string;
      role: UserRole;
    };
    authSource?: AuthSource;
    authSessionId?: string;
  }

  interface User {
    // Optional: OIDC-mapped users carry no trustworthy role; authority is
    // resolved by admission. Credentials authorize() always sets it.
    role?: UserRole;
    // Internal hand-off between authorize() and jwt() for completed
    // emergency MFA ceremonies; never persisted in cookies.
    breakGlassCeremonyId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    tokenVersion?: number;
    userId?: string;
    authSessionId?: string;
    authSource?: AuthSource;
    emergencyActivationId?: string;
  }
}
