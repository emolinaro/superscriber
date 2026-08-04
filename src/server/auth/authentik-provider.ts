import { readFileSync } from "node:fs";
import type { OAuthConfig } from "next-auth/providers/oauth";
import type { OidcAuthConfig } from "@/server/auth/oidc-admission";

/**
 * Hardened Authentik provider construction (plan section 6.1-6.2).
 *
 * Auth.js 4.24 ships an Authentik provider whose defaults use PKCE and state
 * without nonce and do not force the ID-token callback path; this local
 * configuration is explicit instead. Authority is never taken from provider
 * data: profile() maps claims to a minimal placeholder, and admission
 * resolves the local user and role exactly.
 */

export type AuthentikIdTokenClaims = {
  iss: string;
  sub: string;
  name?: string;
  preferred_username?: string;
  sid?: string;
  superscriber_role_group_ids?: string[];
  [key: string]: unknown;
};

/** OIDC Discovery 1.0: append the well-known suffix to the exact issuer. */
export function discoveryUrlFromExactIssuer(issuer: string): string {
  return `${issuer}.well-known/openid-configuration`;
}

export function readSecretFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`OIDC client secret file is not readable: ${path}`);
  }

  const secret = raw.trim();
  if (!secret) {
    throw new Error(`OIDC client secret file is empty: ${path}`);
  }

  return secret;
}

export function buildAuthentikProvider(
  config: OidcAuthConfig,
): OAuthConfig<AuthentikIdTokenClaims> {
  return {
    id: "authentik",
    name: "Authentik",
    type: "oauth",
    wellKnown: discoveryUrlFromExactIssuer(config.oidc.issuer),
    idToken: true,
    checks: ["pkce", "state", "nonce"],
    authorization: {
      params: {
        response_type: "code",
        scope: "openid profile superscriber_roles",
      },
    },
    client: {
      id_token_signed_response_alg: "RS256",
      token_endpoint_auth_method: "client_secret_basic",
    },
    clientId: config.oidc.clientId,
    clientSecret: readSecretFile(config.oidc.clientSecretFile),
    profile(claims) {
      // No role, email, or issuer/subject authority is attached here; the
      // admission resolver re-derives everything from the validated claims.
      return {
        id: String(claims.sub),
        name: (claims.name ?? claims.preferred_username ?? null) as string | null,
      };
    },
  };
}
