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
    role: UserRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    tokenVersion?: number;
    userId?: string;
    authSessionId?: string;
    authSource?: AuthSource;
  }
}
