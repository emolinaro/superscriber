import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAuthentikProvider,
  discoveryUrlFromExactIssuer,
  readSecretFile,
} from "@/server/auth/authentik-provider";
import type { OidcAuthConfig } from "@/server/auth/oidc-admission";

const ISSUER = "https://auth.example.com/application/o/superscriber/";

describe("Authentik provider construction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-oidc-provider-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function config(): OidcAuthConfig {
    const clientSecretFile = join(dir, "client-secret");
    writeFileSync(clientSecretFile, "test-client-secret\n");
    return {
      mode: "dual",
      oidc: { issuer: ISSUER, clientId: "superscriber", clientSecretFile },
      roleMap: {
        version: 1,
        issuer: ISSUER,
        claim: "superscriber_role_group_ids",
        groups: {
          uploader: "11111111-1111-4111-8111-111111111111",
          reviewer: "22222222-2222-4222-8222-222222222222",
          approver: "33333333-3333-4333-8333-333333333333",
          admin: "44444444-4444-4444-8444-444444444444",
        },
      },
    };
  }

  it("derives the discovery URL by appending .well-known to the exact issuer", () => {
    expect(discoveryUrlFromExactIssuer(ISSUER)).toBe(
      "https://auth.example.com/application/o/superscriber/.well-known/openid-configuration",
    );
    expect(discoveryUrlFromExactIssuer("http://127.0.0.1:4105/")).toBe(
      "http://127.0.0.1:4105/.well-known/openid-configuration",
    );
  });

  it("reads the client secret only from the mounted file, trimmed", () => {
    expect(readSecretFile(config().oidc.clientSecretFile)).toBe("test-client-secret");
    const empty = join(dir, "empty-secret");
    writeFileSync(empty, "  \n");
    expect(() => readSecretFile(empty)).toThrow(/empty/i);
    expect(() => readSecretFile(join(dir, "missing"))).toThrow(/secret/i);
  });

  it("builds a hardened OAuth config: PKCE+state+nonce, id token, RS256, strict scopes", () => {
    const provider = buildAuthentikProvider(config());

    expect(provider.id).toBe("authentik");
    expect(provider.type).toBe("oauth");
    expect(provider.idToken).toBe(true);
    expect(provider.checks).toEqual(["pkce", "state", "nonce"]);
    expect(provider.wellKnown).toBe(
      "https://auth.example.com/application/o/superscriber/.well-known/openid-configuration",
    );

    const authorization = provider.authorization as {
      params: Record<string, string>;
    };
    expect(authorization.params.response_type).toBe("code");
    expect(authorization.params.scope).toBe("openid profile superscriber_roles");
    expect(authorization.params.scope).not.toContain("email");
    expect(authorization.params.scope).not.toContain("offline_access");

    const client = provider.client as Record<string, string>;
    expect(client.id_token_signed_response_alg).toBe("RS256");
    expect(client.token_endpoint_auth_method).toBe("client_secret_basic");

    expect(provider.clientId).toBe("superscriber");
    expect(provider.clientSecret).toBe("test-client-secret");
  });

  it("maps claims to a minimal user placeholder with no authority attached", () => {
    const provider = buildAuthentikProvider(config());
    const profile = provider.profile as (claims: Record<string, unknown>) => unknown;

    // The mapped object carries no role; authority is resolved by admission.
    expect(profile({ sub: "sub-1", name: "Ada" })).toEqual({ id: "sub-1", name: "Ada" });
    expect(profile({ sub: "sub-2", preferred_username: "grace" })).toEqual({
      id: "sub-2",
      name: "grace",
    });
    expect(profile({ sub: "sub-3" })).toEqual({ id: "sub-3", name: null });
    expect(JSON.stringify(profile({ sub: "s" }))).not.toContain("role");
  });
});
