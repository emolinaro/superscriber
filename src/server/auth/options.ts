import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { loadAuthConfig } from "@/server/auth/auth-config";
import { buildAuthentikProvider } from "@/server/auth/authentik-provider";
import { resolveOidcAdmission } from "@/server/auth/oidc-admission";
import { resolveAuthSecret } from "@/server/auth/secret";
import { verifyLocalCredentials } from "@/server/auth/service";
import {
  createAuthSession,
  TOKEN_SCHEMA_VERSION,
  validateAuthSession,
} from "@/server/auth/session-registry";
import { loginCredentialsSchema } from "@/server/auth/validation";
import type { AuthSource } from "@/server/db/schema";

/**
 * Auth.js is only the cookie transport. The cookie token carries a schema
 * version, the local user id, and a pointer to the durable auth_sessions row.
 * It never carries role or active state: those are resolved live from the
 * local database on every session read (plan sections 2.1 and 7.2), so stale
 * cookies cannot retain authority.
 */
function resolveProviders(): NextAuthOptions["providers"] {
  const providers: NextAuthOptions["providers"] = [
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
  ];

  const config = loadAuthConfig();
  if (config.mode !== "local") {
    providers.push(buildAuthentikProvider(config));
  }

  return providers;
}

export const authOptions: NextAuthOptions = {
  secret: resolveAuthSecret(),
  session: {
    strategy: "jwt",
    // Matches the registry's normal absolute session bound.
    maxAge: 8 * 60 * 60,
  },
  pages: {
    signIn: "/",
    // OAuth denials and failures land on the same auth surface; the page maps
    // every error code to one generic message.
    error: "/",
  },
  providers: resolveProviders(),
  callbacks: {
    async signIn({ account, profile }) {
      // Credentials users are already validated by authorize(). OIDC claims
      // go through the admission resolver (first of two checks; the jwt
      // callback repeats it at mint time).
      if (account?.provider !== "authentik") {
        return true;
      }

      try {
        const config = loadAuthConfig();
        if (config.mode === "local") {
          return false;
        }

        const admission = resolveOidcAdmission({
          claims: (profile ?? {}) as Record<string, unknown>,
          config,
          recordEvent: false,
        });
        return admission.ok;
      } catch {
        return false;
      }
    },
    async jwt({ token, user, account, profile }) {
      if (user && account?.provider === "authentik") {
        // Second admission check at token-mint time (plan 6.3): no
        // callback-order or mutation assumption can issue an unsafe token.
        try {
          const config = loadAuthConfig();
          if (config.mode === "local") {
            return {};
          }

          const claims = (profile ?? {}) as Record<string, unknown>;
          const admission = resolveOidcAdmission({ claims, config });
          if (!admission.ok) {
            return {};
          }

          const created = createAuthSession({
            userId: admission.userId,
            authSource: "authentik",
            providerSid: admission.providerSid,
            externalIdentityId: admission.identityId,
          });

          token.tokenVersion = TOKEN_SCHEMA_VERSION;
          token.userId = admission.userId;
          token.authSessionId = created.id;
          token.authSource = "authentik";
          delete token.role;
          return token;
        } catch {
          return {};
        }
      }

      if (user) {
        // Fresh credentials sign-in: mint the durable registry row and keep
        // only its pointer in the cookie token.
        try {
          const authSource =
            (user as { authSource?: AuthSource }).authSource ?? "local";
          const created = createAuthSession({
            userId: user.id,
            authSource,
            providerSid: (user as { providerSid?: string | null }).providerSid ?? null,
          });

          token.tokenVersion = TOKEN_SCHEMA_VERSION;
          token.userId = user.id;
          token.authSessionId = created.id;
          token.authSource = created.authSource;
          delete token.role;
          return token;
        } catch {
          return {};
        }
      }

      // Existing token: legacy or malformed tokens are unusable (7.4), and a
      // registry row that fails validation marks the token unusable (7.2).
      if (
        token.tokenVersion !== TOKEN_SCHEMA_VERSION ||
        typeof token.userId !== "string" ||
        typeof token.authSessionId !== "string"
      ) {
        return {};
      }

      const validation = validateAuthSession(token.authSessionId);
      if (!validation.ok) {
        return {};
      }

      token.authSource = validation.session.authSource;
      return token;
    },
    async session({ session, token }) {
      if (
        token.tokenVersion === TOKEN_SCHEMA_VERSION &&
        typeof token.authSessionId === "string"
      ) {
        const validation = validateAuthSession(token.authSessionId);
        if (validation.ok) {
          session.user = {
            id: validation.user.id,
            email: validation.user.email,
            name: validation.user.displayName,
            role: validation.user.role,
          };
          session.authSource = validation.session.authSource;
          session.authSessionId = validation.session.id;
          return session;
        }
      }

      // Fail closed: return a session without any identity claims.
      delete session.user;
      delete session.authSource;
      delete session.authSessionId;
      return session;
    },
  },
};
