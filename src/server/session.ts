import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { type Principal, type UserRole } from "@/domain/models";
import { authOptions } from "@/server/auth/options";

export type ActiveSession = {
  user: Principal;
  expiresAt: string;
};

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

export async function requireActivePrincipal() {
  const principal = await getActivePrincipal();
  if (!principal) {
    redirect("/?reason=session-expired");
  }

  return principal;
}

export async function requireActiveRole() {
  return (await requireActivePrincipal()).role;
}
