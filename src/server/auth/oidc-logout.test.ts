import { generateKeyPairSync, createSign, randomBytes, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLogoutTokenValidator,
  revokeProviderSessions,
} from "@/server/auth/oidc-logout";
import { applyIdentityLink } from "@/server/auth/identity-links";
import { createAuthSession } from "@/server/auth/session-registry";
import { openAppDatabase } from "@/server/db/client";

const ISSUER = "https://auth.example.com/application/o/superscriber/";
const CLIENT_ID = "superscriber";
const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return { privateKey, kid, jwk };
}

function signJwt(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  header: Record<string, unknown>,
) {
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

function logoutClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    jti: "jti-1",
    events: { [LOGOUT_EVENT]: {} },
    sid: "sid-1",
    ...overrides,
  };
}

function fakeFetch(jwkFetcher: () => Record<string, unknown> | null) {
  return async (url: string | URL) => {
    const href = String(url);
    if (href.endsWith("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          jwks_uri: "https://keys.example.com/jwks.json",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (href === "https://keys.example.com/jwks.json") {
      const jwk = jwkFetcher();
      if (!jwk) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("logout token validation", () => {
  it("accepts a well-formed RS256 logout token via discovered JWKS", async () => {
    const key = makeKey();
    const validate = createLogoutTokenValidator({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetchImpl: fakeFetch(() => key.jwk),
    });

    const token = signJwt(logoutClaims(), key.privateKey, {
      alg: "RS256",
      typ: "JWT",
      kid: key.kid,
    });

    const result = await validate(token);
    expect(result).toMatchObject({ ok: true, claims: { sid: "sid-1", jti: "jti-1" } });
  });

  it("rejects a tampered signature and non-RS256 algorithms", async () => {
    const key = makeKey();
    const validate = createLogoutTokenValidator({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetchImpl: fakeFetch(() => key.jwk),
    });

    const token = signJwt(logoutClaims(), key.privateKey, {
      alg: "RS256",
      typ: "JWT",
      kid: key.kid,
    });
    const tampered = token.replace(/.$/, token.endsWith("A") ? "B" : "A");
    expect((await validate(tampered)).ok).toBe(false);

    const noneToken = `${base64url(JSON.stringify({ alg: "none", kid: key.kid }))}.${base64url(JSON.stringify(logoutClaims()))}.`;
    expect((await validate(noneToken)).ok).toBe(false);

    const hs = signJwt(logoutClaims(), key.privateKey, {
      alg: "HS256",
      typ: "JWT",
      kid: key.kid,
    });
    expect((await validate(hs)).ok).toBe(false);
  });

  it("refreshes JWKS once on an unknown kid (rotation), then denies unknown kids", async () => {
    const oldKey = makeKey();
    const newKey = makeKey();
    let fetches = 0;
    let rotated = false;
    const validate = createLogoutTokenValidator({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetchImpl: fakeFetch(() => {
        fetches += 1;
        return (rotated ? newKey : oldKey).jwk;
      }),
    });

    // Prime the cache with the old key.
    const oldToken = signJwt(logoutClaims(), oldKey.privateKey, {
      alg: "RS256",
      typ: "JWT",
      kid: oldKey.kid,
    });
    expect((await validate(oldToken)).ok).toBe(true);
    const fetchesAfterPrime = fetches;

    // Key rotates: new kid appears in JWKS.
    rotated = true;
    const newToken = signJwt(logoutClaims({ jti: "jti-2" }), newKey.privateKey, {
      alg: "RS256",
      typ: "JWT",
      kid: newKey.kid,
    });
    expect((await validate(newToken)).ok).toBe(true);
    expect(fetches).toBeGreaterThan(fetchesAfterPrime);

    // A kid that never shows up is denied after one refresh.
    const ghostKey = makeKey();
    const ghostToken = signJwt(logoutClaims({ jti: "jti-3" }), ghostKey.privateKey, {
      alg: "RS256",
      typ: "JWT",
      kid: ghostKey.kid,
    });
    expect((await validate(ghostToken)).ok).toBe(false);
  });

  it("denies issuer, audience, and claim-shape violations", async () => {
    const key = makeKey();
    const validate = createLogoutTokenValidator({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetchImpl: fakeFetch(() => key.jwk),
    });
    const sign = (claims: Record<string, unknown>) =>
      signJwt(claims, key.privateKey, { alg: "RS256", typ: "JWT", kid: key.kid });

    expect((await validate(sign(logoutClaims({ iss: ISSUER.slice(0, -1) })))).ok).toBe(false);
    expect((await validate(sign(logoutClaims({ aud: "other-client" })))).ok).toBe(false);
    expect((await validate(sign(logoutClaims({ aud: undefined })))).ok).toBe(false);
    expect((await validate(sign(logoutClaims({ events: {} })))).ok).toBe(false);
    expect((await validate(sign(logoutClaims({ iat: "soon" })))).ok).toBe(false);
    expect(
      (await validate(sign(logoutClaims({ iat: Math.floor(Date.now() / 1000) + 3600 })))).ok,
    ).toBe(false);
    expect((await validate(sign(logoutClaims({ jti: undefined })))).ok).toBe(false);
    expect((await validate(sign(logoutClaims({ sid: undefined, sub: undefined })))).ok).toBe(false);
    expect((await validate(sign(logoutClaims({ nonce: "n" })))).ok).toBe(false);
  });

  it("accepts aud as an array containing the client id", async () => {
    const key = makeKey();
    const validate = createLogoutTokenValidator({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetchImpl: fakeFetch(() => key.jwk),
    });
    const token = signJwt(logoutClaims({ aud: ["other", CLIENT_ID] }), key.privateKey, {
      alg: "RS256",
      typ: "JWT",
      kid: key.kid,
    });
    expect((await validate(token)).ok).toBe(true);
  });

  it("fails closed when discovery or JWKS is unreachable", async () => {
    const key = makeKey();
    const validate = createLogoutTokenValidator({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetchImpl: fakeFetch(() => null),
    });
    const token = signJwt(logoutClaims(), key.privateKey, {
      alg: "RS256",
      typ: "JWT",
      kid: key.kid,
    });
    expect(await validate(token)).toEqual({ ok: false, reason: "provider_unavailable" });
  });
});

describe("provider session revocation", () => {
  function setup() {
    const bundle = openAppDatabase(":memory:");
    const now = "2026-08-03T12:00:00.000Z";
    const insert = bundle.sqlite.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'reviewer', 1, ?, ?)`,
    );
    insert.run("user-1", "one@example.com", "One", now, now);
    insert.run("user-2", "two@example.com", "Two", now, now);

    const link1 = applyIdentityLink(
      { userId: "user-1", issuer: ISSUER, subject: "sub-1", changeReason: "t" },
      bundle.db,
    );
    const link2 = applyIdentityLink(
      { userId: "user-2", issuer: ISSUER, subject: "sub-2", changeReason: "t" },
      bundle.db,
    );
    return { bundle, link1, link2 };
  }

  it("revokes exactly the sessions matching the provider sid, idempotently", () => {
    const { bundle, link1, link2 } = setup();
    const { db, sqlite } = bundle;

    createAuthSession(
      { userId: "user-1", authSource: "authentik", providerSid: "sid-a", externalIdentityId: link1.id },
      db,
    );
    createAuthSession(
      { userId: "user-1", authSource: "authentik", providerSid: "sid-b", externalIdentityId: link1.id },
      db,
    );
    createAuthSession(
      { userId: "user-2", authSource: "authentik", providerSid: "sid-c", externalIdentityId: link2.id },
      db,
    );

    const first = revokeProviderSessions({ issuer: ISSUER, sid: "sid-a" }, db);
    expect(first).toEqual({ revoked: 1 });

    const again = revokeProviderSessions({ issuer: ISSUER, sid: "sid-a" }, db);
    expect(again).toEqual({ revoked: 0 });

    const rows = sqlite
      .prepare(`SELECT provider_sid AS sid, status FROM auth_sessions ORDER BY provider_sid`)
      .all() as Array<{ sid: string; status: string }>;
    expect(rows).toEqual([
      { sid: "sid-a", status: "revoked" },
      { sid: "sid-b", status: "active" },
      { sid: "sid-c", status: "active" },
    ]);
  });

  it("revokes all provider sessions for a subject via the identity link", () => {
    const { bundle, link1 } = setup();
    const { db } = bundle;

    const oidcSession = createAuthSession(
      { userId: "user-1", authSource: "authentik", providerSid: "sid-a", externalIdentityId: link1.id },
      db,
    );
    const localSession = createAuthSession({ userId: "user-1", authSource: "local" }, db);

    const result = revokeProviderSessions({ issuer: ISSUER, sub: "sub-1" }, db);
    expect(result.revoked).toBe(1);

    // The provider only governs its own sessions; the local credentials
    // session of the same user is unaffected by back-channel logout.
    const { sqlite } = bundle;
    const states = sqlite
      .prepare(`SELECT id, status FROM auth_sessions`)
      .all() as Array<{ id: string; status: string }>;
    expect(states.find((row) => row.id === oidcSession.id)?.status).toBe("revoked");
    expect(states.find((row) => row.id === localSession.id)?.status).toBe("active");
  });

  it("revokes nothing and stays quiet for unknown sid or subject", () => {
    const { bundle } = setup();
    expect(revokeProviderSessions({ issuer: ISSUER, sid: "ghost" }, bundle.db)).toEqual({
      revoked: 0,
    });
    expect(revokeProviderSessions({ issuer: ISSUER, sub: "ghost" }, bundle.db)).toEqual({
      revoked: 0,
    });
  });
});
