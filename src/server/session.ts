import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { type Principal, type UserRole } from "@/domain/models";
import { sanitizeReturnTo } from "@/lib/safe-return-to";
import { canAccessRecording } from "@/server/access/service";
import { readEmergencyContext } from "@/server/auth/break-glass";
import { authOptions } from "@/server/auth/options";

export type EmergencySessionContext = {
  correlationId: string;
  reason: string;
  absoluteExpiresAt: string;
};

export type ActiveSession = {
  user: Principal;
  expiresAt: string;
  authSessionId: string;
  /** Present only for break-glass sessions (plan section 8.4). */
  emergency?: EmergencySessionContext;
};

function parseRecordingId(pathname: string) {
  const match = /^\/recordings\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function resolveAuthorizedReturnTo(principal: Principal, returnTo?: string | null) {
  const sanitized = sanitizeReturnTo(returnTo);
  const candidate = new URL(sanitized, "https://superscriber.local");

  if (candidate.pathname === "/ingest") {
    return principal.role === "uploader" || principal.role === "admin"
      ? sanitized
      : "/workspace";
  }

  if (candidate.pathname === "/administration") {
    return principal.role === "admin" ? sanitized : "/workspace";
  }

  const recordingId = parseRecordingId(candidate.pathname);
  if (recordingId) {
    return canAccessRecording(principal, recordingId).allowed ? sanitized : "/workspace";
  }

  return sanitized;
}

export async function getActiveSession(): Promise<ActiveSession | null> {
  // getServerSession runs the Auth.js callbacks, which execute the session
  // registry checks in plan section 7.2: cookie decode, registry validation in
  // the jwt callback, and live user resolution in the session callback.
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.role || !session.authSessionId) {
    return null;
  }

  return {
    user: {
      userId: session.user.id,
      email: session.user.email ?? "",
      displayName: session.user.name ?? session.user.email ?? "Local account",
      role: session.user.role,
    },
    expiresAt: session.expires,
    authSessionId: session.authSessionId,
    emergency:
      session.authSource === "break_glass"
        ? (readEmergencyContext(session.authSessionId) ?? undefined)
        : undefined,
  };
}

export async function getActivePrincipal() {
  return (await getActiveSession())?.user ?? null;
}

export async function getActiveRole(): Promise<UserRole | null> {
  return (await getActivePrincipal())?.role ?? null;
}

/**
 * Single protected-request resolver (plan section 7.2). Any failure -
 * missing session, revoked or expired registry row, auth-version mismatch,
 * suspended user, or a registry outage - converges on the same
 * session-expired response. It never emits protected data or error internals.
 */
export async function requireAuthorizedPrincipal(returnTo?: string) {
  const principal = await getActivePrincipal();
  if (!principal) {
    redirect(
      `/?reason=session-expired&returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}`,
    );
  }

  return principal;
}

export async function requireActivePrincipal(returnTo?: string) {
  return requireAuthorizedPrincipal(returnTo);
}

export async function requireActiveRole() {
  return (await requireAuthorizedPrincipal()).role;
}
