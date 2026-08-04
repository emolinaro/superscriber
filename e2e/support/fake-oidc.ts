import { createServer } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";

/**
 * Local fake OIDC provider for dual-mode browser tests. It implements exactly
 * the surface the app consumes: discovery over the exact issuer, RS256 JWKS,
 * authorization-code + PKCE/state/nonce flow, and a signed ID token carrying
 * the dedicated superscriber_role_group_ids claim. No TLS: this is the local
 * test harness only; production enforces HTTPS at the deployment layer.
 */

export type FakeOidcUser = {
  sub: string;
  name?: string;
  sid?: string;
  groups: string[];
};

export type FakeOidcServer = {
  issuer: string;
  port: number;
  setUser(user: FakeOidcUser | null): void;
  /** Signs a back-channel logout token with the fake's current key. */
  signLogoutToken(claims: Record<string, unknown>): string;
  close(): Promise<void>;
};

const E2E_OIDC_PORT = Number(process.env.SUPERSCRIBER_E2E_OIDC_PORT || 4105);

export const E2E_OIDC_ISSUER = `http://127.0.0.1:${E2E_OIDC_PORT}/`;

export const E2E_OIDC_GROUPS = {
  uploader: "11111111-1111-4111-8111-111111111111",
  reviewer: "22222222-2222-4222-8222-222222222222",
  approver: "33333333-3333-4333-8333-333333333333",
  admin: "44444444-4444-4444-8444-444444444444",
} as const;

export function e2eRoleMapJson() {
  return JSON.stringify({
    version: 1,
    issuer: E2E_OIDC_ISSUER,
    claim: "superscriber_role_group_ids",
    groups: E2E_OIDC_GROUPS,
  });
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

export async function startFakeOidcServer(
  options: { clientId?: string; port?: number } = {},
): Promise<FakeOidcServer> {
  const clientId = options.clientId ?? "superscriber";
  const requestedPort = options.port ?? E2E_OIDC_PORT;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const publicJwk = publicKey.export({ format: "jwk" });

  let currentUser: FakeOidcUser | null = null;
  const pendingCodes = new Map<string, { nonce: string }>();

  let issuer = `http://127.0.0.1:${requestedPort}/`;

  function signIdToken(user: FakeOidcUser, nonce: string) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid };
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: user.sub,
      aud: clientId,
      exp: nowSeconds + 300,
      iat: nowSeconds,
      nonce,
      superscriber_role_group_ids: user.groups,
    };
    if (user.sid) {
      payload.sid = user.sid;
    }
    if (user.name) {
      payload.name = user.name;
      payload.preferred_username = user.name;
    }

    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
    return `${unsigned}.${signature}`;
  }

  async function readBody(req: import("node:http").IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          userinfo_endpoint: `${issuer}userinfo`,
          jwks_uri: `${issuer}jwks`,
          end_session_endpoint: `${issuer}endsession`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "profile", "superscriber_roles"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const responseType = url.searchParams.get("response_type");
      const challengeMethod = url.searchParams.get("code_challenge_method");

      if (!redirectUri || !state || !nonce || responseType !== "code") {
        res.statusCode = 400;
        res.end("invalid authorize request");
        return;
      }
      if (challengeMethod && challengeMethod !== "S256") {
        res.statusCode = 400;
        res.end("only S256 is supported");
        return;
      }
      if (!currentUser) {
        res.statusCode = 401;
        res.end("no fake user configured");
        return;
      }

      const code = randomBytes(16).toString("hex");
      pendingCodes.set(code, { nonce });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      target.searchParams.set("iss", issuer);
      res.statusCode = 302;
      res.setHeader("location", target.toString());
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      const code = body.get("code") ?? "";
      const pending = pendingCodes.get(code);
      if (!pending || body.get("grant_type") !== "authorization_code" || !currentUser) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      pendingCodes.delete(code);

      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: randomBytes(24).toString("hex"),
          token_type: "Bearer",
          expires_in: 300,
          id_token: signIdToken(currentUser, pending.nonce),
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/userinfo") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(currentUser ? { sub: currentUser.sub } : {}));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : requestedPort;
  issuer = `http://127.0.0.1:${boundPort}/`;

  return {
    issuer,
    port: boundPort,
    setUser(user) {
      currentUser = user;
    },
    signLogoutToken(claims) {
      const header = { alg: "RS256", typ: "JWT", kid };
      const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
      return `${unsigned}.${signature}`;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
