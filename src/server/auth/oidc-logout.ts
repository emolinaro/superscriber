import { and, eq } from "drizzle-orm";
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { discoveryUrlFromExactIssuer } from "@/server/auth/authentik-provider";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import { authSessions, externalIdentities, oidcLogoutReplays } from "@/server/db/schema";

/**
 * Back-channel logout support (plan section 6.4.4-6.4.6).
 *
 * Auth.js v4 has no provider-specific session revocation surface, so this
 * module validates signed logout tokens itself: RS256 signature against the
 * discovered JWKS (cache honors normal behavior and refreshes exactly once
 * per request on an unknown kid), exact issuer, audience, iat window, the
 * backchannel events member, and sid or sub targeting. Replays are deduped
 * by (issuer, jti) and revocation is idempotent. Responses never reveal
 * whether an account or session exists.
 */

const LOGOUT_EVENT_KEY = "http://schemas.openid.net/event/backchannel-logout";
const IAT_SKEW_SECONDS = 600;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "json" | "status">>;

export type LogoutTokenClaims = {
  iss: string;
  sub?: string;
  sid?: string;
  jti: string;
};

export type LogoutTokenValidation =
  | { ok: true; claims: LogoutTokenClaims }
  | { ok: false; reason: string };

type RsaJwk = {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
  [property: string]: unknown;
};

type JwksCacheEntry = { keys: RsaJwk[]; fetchedAtMs: number };

function base64urlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function resolveJwksUri(
  issuer: string,
  fetchImpl: FetchLike,
): Promise<string | null> {
  try {
    const response = await fetchImpl(discoveryUrlFromExactIssuer(issuer));
    if (!response.ok) {
      return null;
    }
    const discovery = (await response.json()) as { jwks_uri?: unknown };
    return typeof discovery.jwks_uri === "string" && discovery.jwks_uri.length > 0
      ? discovery.jwks_uri
      : null;
  } catch {
    return null;
  }
}

export function createLogoutTokenValidator(options: {
  issuer: string;
  clientId: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}) {
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url));
  const now = options.now ?? (() => new Date());
  let jwksCache: JwksCacheEntry | null = null;

  async function fetchKeys(jwksUri: string): Promise<RsaJwk[] | null> {
    try {
      const response = await fetchImpl(jwksUri);
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { keys?: unknown };
      return Array.isArray(body.keys) ? (body.keys as RsaJwk[]) : null;
    } catch {
      return null;
    }
  }

  async function getKeys(jwksUri: string, forceRefresh: boolean) {
    const cached = jwksCache;
    const fresh = cached && now().getTime() - cached.fetchedAtMs < JWKS_CACHE_TTL_MS;
    if (!forceRefresh && fresh) {
      return cached.keys;
    }
    const keys = await fetchKeys(jwksUri);
    if (keys) {
      jwksCache = { keys, fetchedAtMs: now().getTime() };
    }
    return keys;
  }

  function verifyWithKey(
    token: string,
    headerB64: string,
    payloadB64: string,
    signatureB64: string,
    jwk: RsaJwk,
  ) {
    try {
      const key: KeyObject = createPublicKey({
        key: jwk as JsonWebKey,
        format: "jwk",
      });
      return createVerify("RSA-SHA256")
        .update(`${headerB64}.${payloadB64}`)
        .verify(key, signatureB64, "base64url");
    } catch {
      return false;
    }
  }

  return async function validate(token: string): Promise<LogoutTokenValidation> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, reason: "malformed" };
    }
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = base64urlJson(headerB64) as { alg?: unknown; kid?: unknown } | null;
    const claims = base64urlJson(payloadB64) as Record<string, unknown> | null;
    if (!header || !claims) {
      return { ok: false, reason: "malformed" };
    }

    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0) {
      return { ok: false, reason: "invalid_algorithm" };
    }

    const jwksUri = await resolveJwksUri(options.issuer, fetchImpl);
    if (!jwksUri) {
      return { ok: false, reason: "provider_unavailable" };
    }

    // JWKS: honor the cache, refresh exactly once on an unknown kid (6.4.6).
    let keys = await getKeys(jwksUri, false);
    if (!keys) {
      return { ok: false, reason: "provider_unavailable" };
    }
    let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA") ?? null;
    if (!jwk) {
      keys = await getKeys(jwksUri, true);
      jwk = keys?.find((key) => key.kid === header.kid && key.kty === "RSA") ?? null;
    }
    if (!jwk) {
      return { ok: false, reason: "unknown_key" };
    }

    if (!verifyWithKey(token, headerB64, payloadB64, signatureB64, jwk)) {
      return { ok: false, reason: "invalid_signature" };
    }

    if (claims.iss !== options.issuer) {
      return { ok: false, reason: "issuer_mismatch" };
    }

    const aud = claims.aud;
    const audienceOk =
      (typeof aud === "string" && aud === options.clientId) ||
      (Array.isArray(aud) && aud.includes(options.clientId));
    if (!audienceOk) {
      return { ok: false, reason: "audience_mismatch" };
    }

    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (
      typeof claims.iat !== "number" ||
      !Number.isFinite(claims.iat) ||
      Math.abs(nowSeconds - claims.iat) > IAT_SKEW_SECONDS
    ) {
      return { ok: false, reason: "invalid_iat" };
    }

    if (typeof claims.exp === "number" && claims.exp <= nowSeconds) {
      return { ok: false, reason: "expired" };
    }

    if (typeof claims.jti !== "string" || claims.jti.length === 0) {
      return { ok: false, reason: "missing_jti" };
    }

    const events = claims.events as Record<string, unknown> | null | undefined;
    if (!events || typeof events[LOGOUT_EVENT_KEY] !== "object" || events[LOGOUT_EVENT_KEY] === null) {
      return { ok: false, reason: "missing_event" };
    }

    if (claims.nonce !== undefined) {
      return { ok: false, reason: "nonce_not_allowed" };
    }

    const sub = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined;
    const sid = typeof claims.sid === "string" && claims.sid.length > 0 ? claims.sid : undefined;
    if (!sub && !sid) {
      return { ok: false, reason: "missing_target" };
    }

    return { ok: true, claims: { iss: options.issuer, sub, sid, jti: claims.jti } };
  };
}

/**
 * Revokes local provider sessions matching a back-channel logout target.
 * sid targets exactly that provider session family; sub resolves through the
 * identity link (any status) to its local user and revokes that user's
 * provider sessions. Local-credentials sessions are never touched.
 */
export function revokeProviderSessions(
  target: { issuer: string } & ({ sid: string } | { sub: string }),
  db: AppDatabase = getAppDb(),
): { revoked: number } {
  const nowIso = new Date().toISOString();
  let ids: Array<{ id: string; userId: string; identityId: string | null }>;

  if ("sid" in target) {
    ids = db
      .select({ id: authSessions.id, userId: authSessions.userId, identityId: authSessions.externalIdentityId })
      .from(authSessions)
      .where(
        and(eq(authSessions.authSource, "authentik"), eq(authSessions.providerSid, target.sid)),
      )
      .all()
      .filter((row) => row.id) as typeof ids;

    // An sid alone cannot prove the issuer namespace; scope to sessions whose
    // identity link belongs to the configured issuer.
    const scoped = ids.filter((row) => {
      if (!row.identityId) {
        return false;
      }
      const identity = db
        .select({ issuer: externalIdentities.issuer })
        .from(externalIdentities)
        .where(eq(externalIdentities.id, row.identityId))
        .get();
      return identity?.issuer === target.issuer;
    });
    ids = scoped;
  } else {
    const identity = db
      .select({ userId: externalIdentities.userId })
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.issuer, target.issuer),
          eq(externalIdentities.subject, target.sub),
        ),
      )
      .get();
    if (!identity) {
      return { revoked: 0 };
    }

    ids = db
      .select({ id: authSessions.id, userId: authSessions.userId, identityId: authSessions.externalIdentityId })
      .from(authSessions)
      .where(
        and(eq(authSessions.userId, identity.userId), eq(authSessions.authSource, "authentik")),
      )
      .all() as typeof ids;
  }

  const active = ids.filter((row) => {
    const session = db
      .select({ status: authSessions.status })
      .from(authSessions)
      .where(eq(authSessions.id, row.id))
      .get();
    return session?.status === "active";
  });

  let revoked = 0;
  for (const row of active) {
    db.update(authSessions)
      .set({ status: "revoked", revokedAt: nowIso, revokedReason: "backchannel_logout" })
      .where(eq(authSessions.id, row.id))
      .run();
    revoked += 1;
  }

  return { revoked };
}

/**
 * Marks an (issuer, jti) pair seen. Returns false on replay.
 */
export function claimLogoutReplaySlot(
  issuer: string,
  jti: string,
  db: AppDatabase = getAppDb(),
): boolean {
  try {
    db.insert(oidcLogoutReplays)
      .values({
        id: crypto.randomUUID(),
        issuer,
        jti,
        seenAt: new Date().toISOString(),
      })
      .run();
    return true;
  } catch {
    return false;
  }
}

export function recordBackchannelLogoutEvent(
  input: {
    outcome: "success" | "denied";
    detail: string;
    metadata?: Record<string, unknown>;
    userId?: string | null;
  },
  db: AppDatabase = getAppDb(),
) {
  try {
    recordSecurityEvent(
      {
        type: "oidc.backchannel_logout",
        outcome: input.outcome,
        userId: input.userId ?? null,
        detail: input.detail,
        metadata: input.metadata ?? {},
      },
      db,
    );
  } catch {
    // The event stream must never break the logout endpoint.
  }
}
