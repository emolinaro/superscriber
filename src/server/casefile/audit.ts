import { type AuditEvent, type AuditMetadata, type Principal } from "@/domain/models";
import type { AppDatabase } from "@/server/db/client";
import { serializeAuditMetadata, toAuditEvent } from "@/server/db/mappers";
import { auditEvents } from "@/server/db/schema";

export type ActorContext = {
  actorRole: AuditEvent["actorRole"];
  actorUserId: AuditEvent["actorUserId"];
  actorDisplayName: AuditEvent["actorDisplayName"];
  effectiveRole: AuditEvent["effectiveRole"];
  adminActionSessionId: AuditEvent["adminActionSessionId"];
};

function systemActorContext(): ActorContext {
  return {
    actorRole: "system",
    actorUserId: null,
    actorDisplayName: null,
    effectiveRole: "system",
    adminActionSessionId: null,
  };
}

export function actorContextForPrincipal(principal: Principal): ActorContext {
  return {
    actorRole: principal.role,
    actorUserId: principal.userId,
    actorDisplayName: principal.displayName,
    effectiveRole: principal.role,
    adminActionSessionId: null,
  };
}

export function insertAuditEvent(
  db: AppDatabase,
  params: {
    workspaceId: string;
    recordingId: string | null;
    actor: ActorContext | null;
    type: AuditEvent["type"];
    detail: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  },
): AuditEvent {
  const actor = params.actor ?? systemActorContext();
  const metadata = {
    version: 1,
    data: { ...params.metadata },
  } satisfies AuditMetadata;

  const row = {
    id: crypto.randomUUID(),
    workspaceId: params.workspaceId,
    recordingId: params.recordingId,
    actorRole: actor.actorRole,
    actorUserId: actor.actorUserId,
    actorDisplayName: actor.actorDisplayName,
    effectiveRole: actor.effectiveRole,
    adminActionSessionId: actor.adminActionSessionId,
    type: params.type,
    detail: params.detail,
    metadata: serializeAuditMetadata(metadata),
    createdAt: params.createdAt,
  } satisfies typeof auditEvents.$inferInsert;

  db.insert(auditEvents).values(row).run();
  return toAuditEvent(row);
}
