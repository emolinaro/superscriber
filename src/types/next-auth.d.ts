import type { DefaultSession } from "next-auth";
import type { UserRole } from "@/domain/models";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: UserRole;
    };
  }

  interface User {
    role: UserRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: UserRole;
  }
}
