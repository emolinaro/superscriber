import { getAppDb, type AppDatabase } from "@/server/db/client";
import { securityEvents, type SecurityEventOutcome } from "@/server/db/schema";

/**
 * Durable, redacted security audit stream (plan section 8.4).
 *
 * These events back operator diagnostics and denial forensics. Never put
 * credentials, OIDC tokens or raw claims, full request IPs, or user email
 * addresses into `detail` or `metadata`: identify users by local id only.
 * Defense in depth: blocked metadata keys are dropped rather than recorded.
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

const BLOCKED_METADATA_KEY = /password|secret|token|authorization|credential|email/i;

function sanitizeMetadata(metadata: Record<string, unknown>) {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (BLOCKED_METADATA_KEY.test(key) || typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) {
      continue;
    }
    // A string value that looks like an email address is never recorded.
    if (typeof value === "string" && value.includes("@")) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

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
      metadata: JSON.stringify({ version: 1, data: sanitizeMetadata(input.metadata ?? {}) }),
      createdAt: (input.now ?? new Date()).toISOString(),
    })
    .run();

  return id;
}
