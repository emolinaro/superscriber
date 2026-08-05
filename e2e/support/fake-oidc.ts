import { createServer } from "node:http";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";

/**
 * Canonical fake OIDC provider for unit, route, local E2E, and container E2E.
 *
 * Tests always drive the provider through its HTTP control channel so
 * behavior is identical in every hosting mode (in-process or container netns
 * sidecar). The container sidecar runs scripts/fake-oidc-sidecar-entry.ts,
 * bundled to plain ESM by scripts/run-e2e-appliance.sh (esbuild) so the app
 * image's stock node can execute it.
 */

export type FakeOidcUser = {
  sub: string;
  name?: string;
  sid?: string;
  groups: string[];
};

export const E2E_OIDC_PORT = Number(process.env.SUPERSCRIBER_E2E_OIDC_PORT || 4105);
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

export type OidcControl = {
  setUser(user: FakeOidcUser | null): Promise<void>;
  signLogoutToken(claims: Record<string, unknown>): Promise<string>;
  failAuthorizeOnce(error: string): Promise<void>;
};

export function oidcControl(baseUrl: string): OidcControl {
  const base = baseUrl.replace(/\/$/, "");

  async function post(path: string, body: unknown) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`fake oidc control ${path} failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  return {
    async setUser(user) {
      await post("/__control/set-user", { user });
    },
    async signLogoutToken(claims) {
      const result = await post("/__control/sign-logout-token", { claims });
      return String(result.token);
    },
    async failAuthorizeOnce(error) {
      await post("/__control/fail-authorize", { error, once: true });
    },
  };
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

export type FakeOidcServer = {
  issuer: string;
  port: number;
  control: OidcControl;
  close(): Promise<void>;
};

export async function startFakeOidcServer(
  options: { clientId?: string; port?: number } = {},
): Promise<FakeOidcServer> {
  const clientId = options.clientId ?? "superscriber";
  const requestedPort = options.port ?? E2E_OIDC_PORT;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;

  let currentUser: FakeOidcUser | null = null;
  let authorizeError: { error: string; once: boolean } | null = null;
  const pendingCodes = new Map<string, { nonce: string }>();
  let issuer = `http://127.0.0.1:${requestedPort}/`;

  function signJwt(payload: Record<string, unknown>) {
    const header = { alg: "RS256", typ: "JWT", kid };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
    return `${unsigned}.${signature}`;
  }

  function signIdToken(user: FakeOidcUser, nonce: string) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: issuer,
      sub: user.sub,
      aud: clientId,
      exp: nowSeconds + 300,
      iat: nowSeconds,
      nonce,
      superscriber_role_group_ids: user.groups ?? [],
    };
    if (user.sid) {
      payload.sid = user.sid;
    }
    if (user.name) {
      payload.name = user.name;
      payload.preferred_username = user.name;
    }
    return signJwt(payload);
  }

  async function readBody(req: import("node:http").IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);

    if (req.method === "POST" && url.pathname === "/__control/set-user") {
      const body = JSON.parse((await readBody(req)) || "{}") as { user?: FakeOidcUser | null };
      currentUser = body.user ?? null;
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/__control/sign-logout-token") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        claims?: Record<string, unknown>;
      };
      return json(res, 200, { token: signJwt(body.claims ?? {}) });
    }

    if (req.method === "POST" && url.pathname === "/__control/fail-authorize") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        error?: string;
        once?: boolean;
      };
      authorizeError = { error: body.error ?? "access_denied", once: body.once !== false };
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
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
      });
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      return json(res, 200, { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] });
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");

      if (!redirectUri || !state || !nonce || url.searchParams.get("response_type") !== "code") {
        res.statusCode = 400;
        return res.end("invalid authorize request");
      }
      if (!currentUser) {
        res.statusCode = 401;
        return res.end("no fake user configured");
      }

      const target = new URL(redirectUri);
      target.searchParams.set("state", state);

      if (authorizeError) {
        target.searchParams.set("error", authorizeError.error);
        if (authorizeError.once) {
          authorizeError = null;
        }
        res.statusCode = 302;
        res.setHeader("location", target.toString());
        return res.end();
      }

      const code = randomBytes(16).toString("hex");
      pendingCodes.set(code, { nonce });
      target.searchParams.set("code", code);
      target.searchParams.set("iss", issuer);
      res.statusCode = 302;
      res.setHeader("location", target.toString());
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      const code = body.get("code") ?? "";
      const pending = pendingCodes.get(code);
      if (!pending || body.get("grant_type") !== "authorization_code" || !currentUser) {
        return json(res, 400, { error: "invalid_grant" });
      }
      pendingCodes.delete(code);
      return json(res, 200, {
        access_token: randomBytes(24).toString("hex"),
        token_type: "Bearer",
        expires_in: 300,
        id_token: signIdToken(currentUser, pending.nonce),
      });
    }

    if (req.method === "GET" && url.pathname === "/userinfo") {
      return json(res, 200, currentUser ? { sub: currentUser.sub } : {});
    }

    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "0.0.0.0", () => resolve());
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : requestedPort;
  issuer = `http://127.0.0.1:${boundPort}/`;

  return {
    issuer,
    port: boundPort,
    control: oidcControl(issuer),
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
