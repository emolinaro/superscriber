import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { applyIdentityLink } from "@/server/auth/identity-links";
import { USER_ROLES } from "@/domain/models";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  auditEvents,
  externalIdentities,
  recordingAssignments,
  users,
} from "@/server/db/schema";

/**
 * Institution-governed identity link import (plan section 4.3).
 *
 * Mappings contain only local user ids, exact issuer, exact subject, and a
 * change reason - never email. The dry run reports every problem it can find;
 * apply is transactional, all-or-nothing, and emits one redacted security
 * event per linked user.
 */

const importEntrySchema = z.object({
  userId: z.string().min(1),
  issuer: z.string().min(1),
  subject: z.string().min(1),
  changeReason: z.string().min(1),
  expectedRole: z.enum(USER_ROLES).optional(),
});

export const identityImportSchema = z.array(importEntrySchema).min(1);

export type IdentityImportEntry = z.infer<typeof importEntrySchema>;

export type IdentityImportReport = {
  ok: boolean;
  missingUsers: string[];
  duplicatePairs: Array<{ issuer: string; subject: string }>;
  existingActiveLinks: Array<{ issuer: string; subject: string; userId: string }>;
  reservedPairs: Array<{ issuer: string; subject: string }>;
  roleMismatches: Array<{ userId: string; expectedRole: string; currentRole: string }>;
  userSummaries: Array<{
    userId: string;
    activeAssignmentCount: number;
    auditEventCount: number;
  }>;
};

type SeenPair = { issuer: string; subject: string; count: number };

export function dryRunIdentityImport(
  rawEntries: IdentityImportEntry[],
  db: AppDatabase = getAppDb(),
): IdentityImportReport {
  const entries = identityImportSchema.parse(rawEntries);

  const report: IdentityImportReport = {
    ok: false,
    missingUsers: [],
    duplicatePairs: [],
    existingActiveLinks: [],
    reservedPairs: [],
    roleMismatches: [],
    userSummaries: [],
  };

  const seenPairs = new Map<string, SeenPair>();
  for (const entry of entries) {
    const key = `${entry.issuer}\n${entry.subject}`;
    const prior = seenPairs.get(key);
    if (prior) {
      prior.count += 1;
    } else {
      seenPairs.set(key, { issuer: entry.issuer, subject: entry.subject, count: 1 });
    }
  }
  for (const pair of seenPairs.values()) {
    if (pair.count > 1) {
      report.duplicatePairs.push({ issuer: pair.issuer, subject: pair.subject });
    }
  }

  const summarizedUsers = new Set<string>();
  for (const entry of entries) {
    const user = db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, entry.userId))
      .get();

    if (!user) {
      if (!report.missingUsers.includes(entry.userId)) {
        report.missingUsers.push(entry.userId);
      }
      continue;
    }

    if (entry.expectedRole && user.role !== entry.expectedRole) {
      report.roleMismatches.push({
        userId: entry.userId,
        expectedRole: entry.expectedRole,
        currentRole: user.role,
      });
    }

    const existing = db
      .select({
        id: externalIdentities.id,
        userId: externalIdentities.userId,
        status: externalIdentities.status,
      })
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.issuer, entry.issuer),
          eq(externalIdentities.subject, entry.subject),
        ),
      )
      .get();

    if (existing?.status === "active") {
      const already = report.existingActiveLinks.some(
        (link) => link.issuer === entry.issuer && link.subject === entry.subject,
      );
      if (!already) {
        report.existingActiveLinks.push({
          issuer: entry.issuer,
          subject: entry.subject,
          userId: existing.userId,
        });
      }
    } else if (existing?.status === "retired") {
      const already = report.reservedPairs.some(
        (pair) => pair.issuer === entry.issuer && pair.subject === entry.subject,
      );
      if (!already) {
        report.reservedPairs.push({ issuer: entry.issuer, subject: entry.subject });
      }
    }

    if (!summarizedUsers.has(entry.userId)) {
      summarizedUsers.add(entry.userId);
      const activeAssignmentCount = db
        .select({ count: sql<number>`count(*)` })
        .from(recordingAssignments)
        .where(
          and(
            eq(recordingAssignments.userId, entry.userId),
            eq(recordingAssignments.status, "active"),
          ),
        )
        .get()!.count;
      const auditEventCount = db
        .select({ count: sql<number>`count(*)` })
        .from(auditEvents)
        .where(eq(auditEvents.actorUserId, entry.userId))
        .get()!.count;
      report.userSummaries.push({
        userId: entry.userId,
        activeAssignmentCount,
        auditEventCount,
      });
    }
  }

  report.ok =
    report.missingUsers.length === 0 &&
    report.duplicatePairs.length === 0 &&
    report.existingActiveLinks.length === 0 &&
    report.reservedPairs.length === 0 &&
    report.roleMismatches.length === 0;

  return report;
}

export function applyIdentityImport(
  rawEntries: IdentityImportEntry[],
  options: { linkedByUserId?: string | null; now?: Date } = {},
  db: AppDatabase = getAppDb(),
): { applied: number } {
  const entries = identityImportSchema.parse(rawEntries);

  const report = dryRunIdentityImport(entries, db);
  if (!report.ok) {
    throw new Error(
      `Identity import dry run failed: ${JSON.stringify({
        missingUsers: report.missingUsers,
        duplicatePairs: report.duplicatePairs,
        existingActiveLinks: report.existingActiveLinks,
        reservedPairs: report.reservedPairs,
        roleMismatches: report.roleMismatches,
      })}`,
    );
  }

  db.transaction((tx) => {
    for (const entry of entries) {
      applyIdentityLink(
        {
          userId: entry.userId,
          issuer: entry.issuer,
          subject: entry.subject,
          linkedByUserId: options.linkedByUserId ?? null,
          changeReason: entry.changeReason,
          now: options.now,
        },
        tx as AppDatabase,
      );
    }
  });

  return { applied: entries.length };
}
