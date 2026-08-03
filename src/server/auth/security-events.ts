import { getAppDb, type AppDatabase } from "@/server/db/client";
import { securityEvents, type SecurityEventOutcome } from "@/server/db/schema";

/**
 * Durable, redacted security audit stream (plan section 8.4).
 *
 * These events back operator diagnostics and denial forensics. Never put
 * credentials, OIDC tokens or raw claims, full request IPs, or user email
 * addresses into `detail` or `metadata`: identify users by local id only.
 */
export type SecurityEventInput = {
  type: string;
  outcome: SecurityEventOutcome;
  userId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  sourceZone?: string | null;
  detail?: string;
  metadata?: Record<string, unknown>;
  now?: Date;
};

export function recordSecurityEvent(
  input: SecurityEventInput,
  db: AppDatabase = getAppDb(),
): string {
  const id = `security-${crypto.randomUUID()}`;

  db.insert(securityEvents)
    .values({
      id,
      type: input.type,
      outcome: input.outcome,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      correlationId: input.correlationId ?? null,
      sourceZone: input.sourceZone ?? null,
      detail: input.detail ?? "",
      metadata: JSON.stringify({ version: 1, data: input.metadata ?? {} }),
      createdAt: (input.now ?? new Date()).toISOString(),
    })
    .run();

  return id;
}
