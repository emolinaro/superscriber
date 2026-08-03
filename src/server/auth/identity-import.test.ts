import { describe, expect, it } from "vitest";
import {
  applyIdentityImport,
  dryRunIdentityImport,
  type IdentityImportEntry,
} from "@/server/auth/identity-import";
import {
  applyIdentityLink,
  resolveIdentityLink,
  retireIdentityLink,
} from "@/server/auth/identity-links";
import { openAppDatabase } from "@/server/db/client";

const ISSUER = "https://auth.example.com/application/o/superscriber/";
const NOW = new Date("2026-08-03T12:00:00.000Z");

function setup() {
  const bundle = openAppDatabase(":memory:");
  const insert = bundle.sqlite.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'hash', ?, 1, ?, ?)`,
  );
  insert.run("user-a", "a@example.com", "User A", "reviewer", NOW.toISOString(), NOW.toISOString());
  insert.run("user-b", "b@example.com", "User B", "approver", NOW.toISOString(), NOW.toISOString());
  insert.run("user-op", "op@example.com", "Operator", "admin", NOW.toISOString(), NOW.toISOString());
  return bundle;
}

const ENTRY_A: IdentityImportEntry = {
  userId: "user-a",
  issuer: ISSUER,
  subject: "sub-a",
  changeReason: "Initial provisioning window 2026-08.",
  expectedRole: "reviewer",
};

describe("identity import", () => {
  it("dry run reports ok for a clean mapping with per-user governance counts", () => {
    const { db } = setup();

    const report = dryRunIdentityImport([ENTRY_A], db);

    expect(report.ok).toBe(true);
    expect(report.missingUsers).toEqual([]);
    expect(report.duplicatePairs).toEqual([]);
    expect(report.existingActiveLinks).toEqual([]);
    expect(report.reservedPairs).toEqual([]);
    expect(report.roleMismatches).toEqual([]);
    expect(report.userSummaries).toEqual([
      { userId: "user-a", activeAssignmentCount: 0, auditEventCount: 0 },
    ]);
  });

  it("dry run flags missing users, duplicates, existing links, reserved pairs, and role mismatches", () => {
    const { db } = setup();
    applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-a", linkedByUserId: "user-op", changeReason: "Earlier." },
      db,
    );

    const report = dryRunIdentityImport(
      [
        ENTRY_A,
        { ...ENTRY_A, subject: "sub-a" },
        { userId: "ghost", issuer: ISSUER, subject: "sub-ghost", changeReason: "Missing user." },
        { userId: "user-b", issuer: ISSUER, subject: "sub-b", changeReason: "Role changed.", expectedRole: "admin" },
      ],
      db,
    );

    expect(report.ok).toBe(false);
    expect(report.missingUsers).toEqual(["ghost"]);
    expect(report.duplicatePairs).toEqual([{ issuer: ISSUER, subject: "sub-a" }]);
    expect(report.existingActiveLinks).toEqual([{ issuer: ISSUER, subject: "sub-a", userId: "user-a" }]);
    expect(report.roleMismatches).toEqual([
      { userId: "user-b", expectedRole: "admin", currentRole: "approver" },
    ]);
  });

  it("dry run flags pairs reserved by retired links", () => {
    const { db } = setup();
    const link = applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-a", linkedByUserId: "user-op", changeReason: "Earlier." },
      db,
    );
    retireIdentityLink(
      { identityId: link.id, retiredByUserId: "user-op", changeReason: "Offboarded." },
      db,
    );

    const report = dryRunIdentityImport(
      [{ userId: "user-b", issuer: ISSUER, subject: "sub-a", changeReason: "Reuse attempt." }],
      db,
    );

    expect(report.ok).toBe(false);
    expect(report.reservedPairs).toEqual([{ issuer: ISSUER, subject: "sub-a" }]);
  });

  it("applies atomically and emits one redacted security event per user", () => {
    const { db, sqlite } = setup();

    const result = applyIdentityImport(
      [ENTRY_A, { ...ENTRY_A, userId: "user-b", subject: "sub-b", expectedRole: "approver" }],
      { linkedByUserId: "user-op", now: NOW },
      db,
    );

    expect(result.applied).toBe(2);
    expect(resolveIdentityLink(ISSUER, "sub-a", db)).toMatchObject({ status: "linked" });
    expect(resolveIdentityLink(ISSUER, "sub-b", db)).toMatchObject({ status: "linked" });

    const events = sqlite
      .prepare(`SELECT type, user_id AS userId, detail, metadata FROM security_events WHERE type = 'identity.link.applied' ORDER BY user_id`)
      .all() as Array<{ type: string; userId: string; detail: string; metadata: string }>;

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.userId)).toEqual(["user-a", "user-b"]);
    for (const event of events) {
      expect(event.detail).not.toContain("@");
      expect(event.metadata).not.toContain("@");
    }
  });

  it("rolls back the whole batch when any entry fails", () => {
    const { db, sqlite } = setup();

    expect(() =>
      applyIdentityImport(
        [ENTRY_A, { ...ENTRY_A, userId: "ghost", subject: "sub-ghost" }],
        { linkedByUserId: "user-op" },
        db,
      ),
    ).toThrow();

    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM external_identities`).get(),
    ).toEqual({ count: 0 });
  });
});
