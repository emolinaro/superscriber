import { and, eq, ne, or, sql } from "drizzle-orm";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { retireUserSessions } from "@/server/auth/session-registry";
import type { UserRole } from "@/domain/models";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  adminActionSessions,
  approvals,
  auditEvents,
  externalIdentities,
  recordingAssignments,
  revisions,
  users,
  type ExternalIdentityStatus,
} from "@/server/db/schema";

/**
 * Durable identity links (plan section 4).
 *
 * A link binds a cryptographically validated (issuer, subject) pair to an
 * existing local users.id. Matching is exact: no URL cleanup, lowercasing,
 * slash removal, or email lookup. A pair is reserved forever once used;
 * retirement never frees it. There is no first-login JIT creation.
 */

export type ExternalIdentityRecord = typeof externalIdentities.$inferSelect;

export type LinkedUserRecord = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  authVersion: number;
};

export type IdentityLinkResolution =
  | { status: "linked"; identity: ExternalIdentityRecord; user: LinkedUserRecord }
  | { status: "retired"; identity: ExternalIdentityRecord }
  | { status: "unlinked" };

function safeRecord(input: Parameters<typeof recordSecurityEvent>[0], db: AppDatabase) {
  try {
    recordSecurityEvent(input, db);
  } catch {
    // The security event stream must never break the operation it observes.
  }
}

const LINKED_USER_COLUMNS = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  isActive: users.isActive,
  authVersion: users.authVersion,
} as const;

export function resolveIdentityLink(
  issuer: string,
  subject: string,
  db: AppDatabase = getAppDb(),
): IdentityLinkResolution {
  const row = db
    .select({ identity: externalIdentities, user: LINKED_USER_COLUMNS })
    .from(externalIdentities)
    .innerJoin(users, eq(externalIdentities.userId, users.id))
    .where(and(eq(externalIdentities.issuer, issuer), eq(externalIdentities.subject, subject)))
    .get();

  if (!row) {
    return { status: "unlinked" };
  }

  if (row.identity.status === "retired") {
    return { status: "retired", identity: row.identity };
  }

  return { status: "linked", identity: row.identity, user: row.user };
}

export function applyIdentityLink(
  params: {
    userId: string;
    issuer: string;
    subject: string;
    linkedByUserId?: string | null;
    changeReason: string;
    roleMapVersion?: number | null;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): ExternalIdentityRecord {
  const user = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, params.userId))
    .get();
  if (!user) {
    throw new Error(`Cannot link an identity to unknown user ${params.userId}.`);
  }

  const existingPair = db
    .select({ id: externalIdentities.id })
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.issuer, params.issuer),
        eq(externalIdentities.subject, params.subject),
      ),
    )
    .get();
  if (existingPair) {
    throw new Error(
      "The (issuer, subject) pair is reserved forever; reuse requires a separately approved forensic data repair, not an application operation.",
    );
  }

  const existingActive = db
    .select({ id: externalIdentities.id })
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.userId, params.userId),
        eq(externalIdentities.issuer, params.issuer),
        eq(externalIdentities.status, "active"),
      ),
    )
    .get();
  if (existingActive) {
    throw new Error(
      "This user already has an active link for that issuer; relinking requires an explicit audited transaction.",
    );
  }

  const now = (params.now ?? new Date()).toISOString();
  const record: ExternalIdentityRecord = {
    id: crypto.randomUUID(),
    userId: params.userId,
    issuer: params.issuer,
    subject: params.subject,
    status: "active",
    linkedAt: now,
    linkedByUserId: params.linkedByUserId ?? null,
    retiredAt: null,
    retiredByUserId: null,
    changeReason: params.changeReason,
    lastLoginAt: null,
    lastRoleMapVersion: params.roleMapVersion ?? null,
  };

  db.insert(externalIdentities).values(record).run();

  safeRecord(
    {
      type: "identity.link.applied",
      outcome: "success",
      userId: params.userId,
      detail: "Identity link applied for the configured issuer namespace.",
      metadata: { issuer: params.issuer },
      now: params.now,
    },
    db,
  );

  return record;
}

export function retireIdentityLink(
  params: {
    identityId: string;
    retiredByUserId?: string | null;
    changeReason: string;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): ExternalIdentityRecord {
  const existing = db
    .select()
    .from(externalIdentities)
    .where(eq(externalIdentities.id, params.identityId))
    .get();
  if (!existing) {
    throw new Error(`Unknown identity link ${params.identityId}.`);
  }
  if (existing.status === "retired") {
    return existing;
  }

  const now = (params.now ?? new Date()).toISOString();
  db.update(externalIdentities)
    .set({
      status: "retired",
      retiredAt: now,
      retiredByUserId: params.retiredByUserId ?? null,
      changeReason: params.changeReason,
    })
    .where(eq(externalIdentities.id, params.identityId))
    .run();

  safeRecord(
    {
      type: "identity.link.retired",
      outcome: "success",
      userId: existing.userId,
      detail: "Identity link retired; the pair remains reserved.",
      metadata: { issuer: existing.issuer },
      now: params.now,
    },
    db,
  );

  return {
    ...existing,
    status: "retired",
    retiredAt: now,
    retiredByUserId: params.retiredByUserId ?? null,
    changeReason: params.changeReason,
  };
}

/**
 * Plan 4.4: a subject change for the same human retires the old link and
 * inserts the new one in one audited transaction.
 */
export function relinkIdentity(
  params: {
    userId: string;
    issuer: string;
    newSubject: string;
    actorUserId?: string | null;
    changeReason: string;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): { retired: ExternalIdentityRecord; link: ExternalIdentityRecord } {
  return db.transaction((tx) => {
    const active = tx
      .select()
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.userId, params.userId),
          eq(externalIdentities.issuer, params.issuer),
          eq(externalIdentities.status, "active"),
        ),
      )
      .get();
    if (!active) {
      throw new Error(
        `User ${params.userId} has no active link for that issuer to relink.`,
      );
    }

    const retired = retireIdentityLink(
      {
        identityId: active.id,
        retiredByUserId: params.actorUserId ?? null,
        changeReason: params.changeReason,
        now: params.now,
      },
      tx as AppDatabase,
    );

    const link = applyIdentityLink(
      {
        userId: params.userId,
        issuer: params.issuer,
        subject: params.newSubject,
        linkedByUserId: params.actorUserId ?? null,
        changeReason: params.changeReason,
        now: params.now,
      },
      tx as AppDatabase,
    );

    return { retired, link };
  });
}

/**
 * Plan 4.4: Authentik account disabled/deleted -> revoke local sessions and
 * deactivate the local user in one transaction. Link and audit history are
 * preserved; login stays denied.
 */
export function offboardLinkedUser(
  params: {
    userId: string;
    actorUserId?: string | null;
    changeReason: string;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): { revokedSessionCount: number } {
  const result = db.transaction((tx) => {
    tx.update(users)
      .set({ isActive: false, updatedAt: (params.now ?? new Date()).toISOString() })
      .where(eq(users.id, params.userId))
      .run();

    const { revokedCount } = retireUserSessions(
      { userId: params.userId, reason: "offboarded" },
      tx as AppDatabase,
    );
    return { revokedSessionCount: revokedCount };
  });

  safeRecord(
    {
      type: "identity.offboarded",
      outcome: "success",
      userId: params.userId,
      detail: "External identity offboarded; sessions revoked and user deactivated.",
      metadata: { revokedSessionCount: result.revokedSessionCount },
      now: params.now,
    },
    db,
  );

  return result;
}

/**
 * Plan 4.4: local user deletion is rejected while identity, assignment,
 * revision, approval, action-session, or audit references exist. Operators
 * use deactivation, not deletion.
 */
export function assertUserDeletionBlocked(userId: string, db: AppDatabase = getAppDb()): void {
  const linkCount = db
    .select({ count: sql<number>`count(*)` })
    .from(externalIdentities)
    .where(eq(externalIdentities.userId, userId))
    .get()!.count;
  if (linkCount > 0) {
    throw new Error(
      "Local user deletion is prohibited while an identity link exists; use deactivation.",
    );
  }

  const auditCount = db
    .select({ count: sql<number>`count(*)` })
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, userId))
    .get()!.count;
  if (auditCount > 0) {
    throw new Error(
      "Local user deletion is prohibited while audit events reference the user; use deactivation.",
    );
  }

  const assignmentCount = db
    .select({ count: sql<number>`count(*)` })
    .from(recordingAssignments)
    .where(eq(recordingAssignments.userId, userId))
    .get()!.count;
  if (assignmentCount > 0) {
    throw new Error(
      "Local user deletion is prohibited while recording assignments reference the user; use deactivation.",
    );
  }

  const revisionCount = db
    .select({ count: sql<number>`count(*)` })
    .from(revisions)
    .where(or(eq(revisions.createdByUserId, userId), eq(revisions.submittedByUserId, userId)))
    .get()!.count;
  if (revisionCount > 0) {
    throw new Error(
      "Local user deletion is prohibited while revisions reference the user; use deactivation.",
    );
  }

  const approvalCount = db
    .select({ count: sql<number>`count(*)` })
    .from(approvals)
    .where(eq(approvals.actorUserId, userId))
    .get()!.count;
  if (approvalCount > 0) {
    throw new Error(
      "Local user deletion is prohibited while approvals reference the user; use deactivation.",
    );
  }

  const actionSessionCount = db
    .select({ count: sql<number>`count(*)` })
    .from(adminActionSessions)
    .where(eq(adminActionSessions.adminUserId, userId))
    .get()!.count;
  if (actionSessionCount > 0) {
    throw new Error(
      "Local user deletion is prohibited while admin action sessions reference the user; use deactivation.",
    );
  }
}
