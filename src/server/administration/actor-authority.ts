import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { authSessions, users } from "@/server/db/schema";

/**
 * Live authority revalidation for governed admin mutations: the actor's
 * durable session must be active, version-matched, and unexpired, and the
 * actor row must still be an active admin. Callers supply their typed denial.
 */
export function revalidateAdminActor(
  db: AppDatabase,
  params: { actorUserId: string; actorAuthSessionId: string },
  nowIso: string,
  deny: () => never,
): typeof users.$inferSelect {
  const row = db
    .select({
      session: authSessions,
      actor: users,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(eq(authSessions.id, params.actorAuthSessionId))
    .get();

  const nowMs = Date.parse(nowIso);
  const idleExpiresAt = row ? Date.parse(row.session.idleExpiresAt) : NaN;
  const absoluteExpiresAt = row ? Date.parse(row.session.absoluteExpiresAt) : NaN;

  if (
    !row ||
    row.session.userId !== params.actorUserId ||
    row.session.status !== "active" ||
    row.session.authVersion !== row.actor.authVersion ||
    !Number.isFinite(idleExpiresAt) ||
    !Number.isFinite(absoluteExpiresAt) ||
    nowMs >= idleExpiresAt ||
    nowMs >= absoluteExpiresAt ||
    !row.actor.isActive ||
    row.actor.role !== "admin"
  ) {
    deny();
  }

  return row!.actor;
}
