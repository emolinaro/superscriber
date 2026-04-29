import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { type UserRole } from "@/domain/models";
import { verifyLocalCredentials } from "@/server/auth/service";
import { resolveAuthSecret } from "@/server/auth/secret";
import { loginCredentialsSchema } from "@/server/auth/validation";

export const authOptions: NextAuthOptions = {
  secret: resolveAuthSecret(),
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 12,
  },
  pages: {
    signIn: "/",
  },
  providers: [
    CredentialsProvider({
      name: "Local account",
      credentials: {
        email: {
          label: "Email",
          type: "email",
        },
        password: {
          label: "Password",
          type: "password",
        },
      },
      async authorize(rawCredentials) {
        const parsed = loginCredentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          return null;
        }

        const user = await verifyLocalCredentials(parsed.data);
        if (!user) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.displayName,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.role = (user as { role: UserRole }).role;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.userId ?? token.sub ?? "");
        session.user.role = token.role as UserRole;
        session.user.name = token.name ?? session.user.name;
        session.user.email =
          typeof token.email === "string" ? token.email : session.user.email;
      }

      return session;
    },
  },
};
