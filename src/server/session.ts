import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { type Principal, type UserRole } from "@/domain/models";
import { sanitizeReturnTo } from "@/lib/safe-return-to";
import { canAccessRecording } from "@/server/access/service";
import { authOptions } from "@/server/auth/options";

export type ActiveSession = {
  user: Principal;
  expiresAt: string;
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
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.role) {
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
  };
}

export async function getActivePrincipal() {
  return (await getActiveSession())?.user ?? null;
}

export async function getActiveRole(): Promise<UserRole | null> {
  return (await getActivePrincipal())?.role ?? null;
}

export async function requireActivePrincipal(returnTo?: string) {
  const principal = await getActivePrincipal();
  if (!principal) {
    redirect(
      `/?reason=session-expired&returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}`,
    );
  }

  return principal;
}

export async function requireActiveRole() {
  return (await requireActivePrincipal()).role;
}
