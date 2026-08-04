import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { loadAuthConfig, type AuthConfig } from "@/server/auth/auth-config";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  authControl,
  authSessions,
  breakGlassRecoveryCodes,
  externalIdentities,
  securityEvents,
  webauthnCredentials,
  type SecurityEventOutcome,
} from "@/server/db/schema";

/**
 * Redacted operator observability (plan section 8.4 + slice 7).
 *
 * One summary for operators: auth mode, session counts by source, OIDC
 * admission outcomes over 24h, break-glass readiness facts. No secrets,
 * subjects, emails, tokens, or client IPs - only counts and local ids.
 */
export type AuthHealthSummary = {
  mode: AuthConfig["mode"];
  oidcConfigured: boolean;
  configError: string | null;
  sessions: {
    active: number;
    bySource: Record<string, number>;
  };
  oidcAdmission24h: {
    allowed: number;
    denied: number;
  };
  backchannel24h: {
    processed: number;
    denied: number;
  };
  identityLinks: {
    active: number;
    retired: number;
  };
  breakGlass: {
    designated: boolean;
    enrolledKeyCount: number;
    recoveryCodeCount: number;
  };
};

export function getAuthHealthSummary(
  db: AppDatabase = getAppDb(),
  options: { now?: Date; env?: Record<string, string | undefined> } = {},
): AuthHealthSummary {
  const env = options.env ?? process.env;
  const declared = env.SUPERSCRIBER_AUTH_MODE?.trim() || "local";
  let mode: AuthConfig["mode"] =
    declared === "dual" || declared === "authentik-primary" ? declared : "local";
  let oidcConfigured = false;
  let configError: string | null = null;
  try {
    const config = loadAuthConfig(env);
    mode = config.mode;
    oidcConfigured = config.mode !== "local";
  } catch (error) {
    // Coarse only: never surface file paths or material in health output.
    configError = error instanceof Error && error.message.includes("requires these settings")
      ? "incomplete OIDC settings"
      : "invalid auth configuration";
  }

  const now = options.now ?? new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const activeSessions = db
    .select({ authSource: authSessions.authSource, count: sql<number>`count(*)` })
    .from(authSessions)
    .where(eq(authSessions.status, "active"))
    .groupBy(authSessions.authSource)
    .all();

  const bySource: Record<string, number> = {};
  let activeTotal = 0;
  for (const row of activeSessions) {
    bySource[row.authSource] = row.count;
    activeTotal += row.count;
  }

  const countEvents = (type: string, outcome: SecurityEventOutcome) =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.type, type),
          eq(securityEvents.outcome, outcome),
          gt(securityEvents.createdAt, dayAgo),
        ),
      )
      .get()!.count;

  const linkCounts = db
    .select({ status: externalIdentities.status, count: sql<number>`count(*)` })
    .from(externalIdentities)
    .groupBy(externalIdentities.status)
    .all();

  const designation = db
    .select({ breakGlassUserId: authControl.breakGlassUserId })
    .from(authControl)
    .where(eq(authControl.id, 1))
    .get();

  return {
    mode,
    oidcConfigured,
    configError,
    sessions: { active: activeTotal, bySource },
    oidcAdmission24h: {
      allowed: countEvents("oidc.admission.allowed", "success"),
      denied: countEvents("oidc.admission.denied", "denied"),
    },
    backchannel24h: {
      processed: countEvents("oidc.backchannel_logout", "success"),
      denied: countEvents("oidc.backchannel_logout", "denied"),
    },
    identityLinks: {
      active: linkCounts.find((row) => row.status === "active")?.count ?? 0,
      retired: linkCounts.find((row) => row.status === "retired")?.count ?? 0,
    },
    breakGlass: {
      designated: Boolean(designation),
      enrolledKeyCount: designation
        ? db
            .select({ count: sql<number>`count(*)` })
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.userId, designation.breakGlassUserId))
            .get()!.count
        : 0,
      recoveryCodeCount: designation
        ? db
            .select({ count: sql<number>`count(*)` })
            .from(breakGlassRecoveryCodes)
            .where(
              and(
                eq(breakGlassRecoveryCodes.breakGlassUserId, designation.breakGlassUserId),
                isNull(breakGlassRecoveryCodes.usedAt),
                isNull(breakGlassRecoveryCodes.rotatedAt),
              ),
            )
            .get()!.count
        : 0,
    },
  };
}
