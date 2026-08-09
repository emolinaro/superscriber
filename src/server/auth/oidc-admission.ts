import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { resolveAuthSecret } from "@/server/auth/secret";
import type { AuthConfig } from "@/server/auth/auth-config";
import { resolveIdentityLink } from "@/server/auth/identity-links";
import { resolveMappedRole } from "@/server/auth/role-mapping";
import { recordSecurityEvent } from "@/server/auth/security-events";
import type { UserRole } from "@/domain/models";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import { externalIdentities } from "@/server/db/schema";

/**
 * OIDC admission resolver (plan section 6.3).
 *
 * The same idempotent resolver runs in the Auth.js signIn callback and again
 * in the first-login jwt callback, so no callback-order or mutation assumption
 * can issue an unsafe token. Side effects (identity touch, security event)
 * happen only when `recordEvent` is set, which the jwt path owns.
 *
 * Denials are generic in the browser and specific in redacted security
 * events; nothing here reveals whether an email, subject, user, or group
 * exists.
 */

export type OidcAuthConfig = Extract<AuthConfig, { mode: "dual" | "authentik-primary" }>;

export type OidcDenialReason =
  | "malformed_claims"
  | "issuer_mismatch"
  | "identity_not_linked"
  | "identity_retired"
  | "user_inactive"
  | "missing_claim"
  | "invalid_claim"
  | "zero_role"
  | "multi_role"
  | "role_mismatch"
  | "unavailable";

export type OidcAdmission =
  | {
      ok: true;
      userId: string;
      identityId: string;
      role: UserRole;
      mapVersion: number;
      providerSid: string | null;
    }
  | { ok: false; reason: OidcDenialReason };

function hashMatchedGroup(groupId: string) {
  return createHmac("sha256", resolveAuthSecret()).update(groupId).digest("hex");
}

export function resolveOidcAdmission(
  input: {
    claims: Record<string, unknown>;
    config: OidcAuthConfig;
    recordEvent?: boolean;
    recordDeniedEvent?: boolean;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): OidcAdmission {
  const { claims, config } = input;
  const recordEvent = input.recordEvent ?? true;
  const recordDeniedEvent = input.recordDeniedEvent ?? recordEvent;
  const now = input.now ?? new Date();

  const deny = (reason: OidcDenialReason, userId: string | null = null): OidcAdmission => {
    if (recordDeniedEvent) {
      try {
        recordSecurityEvent(
          {
            type: "oidc.admission.denied",
            outcome: "denied",
            userId,
            detail: "OIDC sign-in denied.",
            metadata: { reason, issuer: config.oidc.issuer },
            now,
          },
          db,
        );
      } catch {
        // Deny must never be blocked by the event stream.
      }
    }
    return { ok: false, reason };
  };

  try {
    const iss = claims.iss;
    const sub = claims.sub;
    if (typeof iss !== "string" || typeof sub !== "string" || sub.length === 0) {
      return deny("malformed_claims");
    }

    // Byte-for-byte match against the configured canonical issuer (4.2).
    if (iss !== config.oidc.issuer) {
      return deny("issuer_mismatch");
    }

    const resolution = resolveIdentityLink(iss, sub, db);
    if (resolution.status === "unlinked") {
      return deny("identity_not_linked");
    }
    if (resolution.status === "retired") {
      return deny("identity_retired");
    }

    const { user, identity } = resolution;
    if (!user.isActive) {
      return deny("user_inactive", user.id);
    }

    const roleResolution = resolveMappedRole(claims[config.roleMap.claim], config.roleMap);
    if (!roleResolution.ok) {
      return deny(roleResolution.reason, user.id);
    }

    // Local-role agreement: never silently grant or downgrade (5.2 step 6).
    if (roleResolution.role !== user.role) {
      return deny("role_mismatch", user.id);
    }

    if (recordEvent) {
      db.update(externalIdentities)
        .set({
          lastLoginAt: now.toISOString(),
          lastRoleMapVersion: roleResolution.mapVersion,
        })
        .where(eq(externalIdentities.id, identity.id))
        .run();

      try {
        recordSecurityEvent(
          {
            type: "oidc.admission.allowed",
            outcome: "success",
            userId: user.id,
            detail: "OIDC sign-in admitted.",
            metadata: {
              issuer: config.oidc.issuer,
              role: roleResolution.role,
              mapVersion: roleResolution.mapVersion,
              matchedGroupHash: hashMatchedGroup(roleResolution.matchedGroupId),
            },
            now,
          },
          db,
        );
      } catch {
        // The event stream must not block a valid admission.
      }
    }

    return {
      ok: true,
      userId: user.id,
      identityId: identity.id,
      role: roleResolution.role,
      mapVersion: roleResolution.mapVersion,
      providerSid: typeof claims.sid === "string" ? claims.sid : null,
    };
  } catch {
    return deny("unavailable");
  }
}
