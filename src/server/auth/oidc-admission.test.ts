import { describe, expect, it } from "vitest";
import { applyIdentityLink, retireIdentityLink } from "@/server/auth/identity-links";
import { resolveOidcAdmission, type OidcAuthConfig } from "@/server/auth/oidc-admission";
import type { RoleMap } from "@/server/auth/role-mapping";
import { openAppDatabase, type AppDatabase } from "@/server/db/client";

const ISSUER = "https://auth.example.com/application/o/superscriber/";

const GROUPS = {
  uploader: "11111111-1111-4111-8111-111111111111",
  reviewer: "22222222-2222-4222-8222-222222222222",
  approver: "33333333-3333-4333-8333-333333333333",
  admin: "44444444-4444-4444-8444-444444444444",
} as const;

const ROLE_MAP: RoleMap = {
  version: 2,
  issuer: ISSUER,
  claim: "superscriber_role_group_ids",
  groups: GROUPS,
};

const CONFIG: OidcAuthConfig = {
  mode: "dual",
  oidc: { issuer: ISSUER, clientId: "superscriber", clientSecretFile: "/nonexistent" },
  roleMap: ROLE_MAP,
};

const NOW = new Date("2026-08-03T12:00:00.000Z");

function setup() {
  const bundle = openAppDatabase(":memory:");
  const insert = bundle.sqlite.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'hash', ?, 1, ?, ?)`,
  );
  insert.run("user-reviewer", "reviewer.secret@example.com", "Reviewer", "reviewer", NOW.toISOString(), NOW.toISOString());
  insert.run("user-approver", "approver.secret@example.com", "Approver", "approver", NOW.toISOString(), NOW.toISOString());
  insert.run("user-operator", "op@example.com", "Operator", "admin", NOW.toISOString(), NOW.toISOString());
  return bundle;
}

function linkReviewer(db: AppDatabase, subject = "subject-secret-1") {
  return applyIdentityLink(
    {
      userId: "user-reviewer",
      issuer: ISSUER,
      subject,
      linkedByUserId: "user-operator",
      changeReason: "Test link.",
      now: NOW,
    },
    db,
  );
}

function claims(extra: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    sub: "subject-secret-1",
    sid: "sid-1",
    superscriber_role_group_ids: [GROUPS.reviewer],
    ...extra,
  };
}

function events(sqlite: import("better-sqlite3").Database) {
  return sqlite
    .prepare(
      `SELECT type, outcome, user_id AS userId, detail, metadata FROM security_events WHERE type LIKE 'oidc.%' ORDER BY created_at, id`,
    )
    .all() as Array<{ type: string; outcome: string; userId: string | null; detail: string; metadata: string }>;
}

describe("OIDC admission", () => {
  it("admits a linked active user with one role group matching local role", () => {
    const { db, sqlite } = setup();
    const link = linkReviewer(db);

    const result = resolveOidcAdmission({ claims: claims(), config: CONFIG, now: NOW }, db);

    expect(result).toMatchObject({
      ok: true,
      userId: "user-reviewer",
      identityId: link.id,
      role: "reviewer",
      mapVersion: 2,
      providerSid: "sid-1",
    });

    const updated = sqlite
      .prepare(`SELECT last_login_at AS lla, last_role_map_version AS lrmv FROM external_identities WHERE id = ?`)
      .get(link.id) as { lla: string; lrmv: number };
    expect(updated).toEqual({ lla: NOW.toISOString(), lrmv: 2 });

    const rows = events(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "oidc.admission.allowed",
      outcome: "success",
      userId: "user-reviewer",
    });
    const metadata = JSON.parse(rows[0].metadata) as { data: Record<string, unknown> };
    expect(metadata.data.role).toBe("reviewer");
    expect(metadata.data.mapVersion).toBe(2);
    expect(metadata.data.matchedGroupHash).toMatch(/^[0-9a-f]{64}$/);

    // Redaction: no subject, no email, no raw group UUID anywhere in the record.
    const serialized = `${rows[0].detail}${rows[0].metadata}`;
    expect(serialized).not.toContain("subject-secret-1");
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain(GROUPS.reviewer);
  });

  it("denies malformed or missing identity claims", () => {
    const { db } = setup();
    expect(
      resolveOidcAdmission({ claims: { iss: ISSUER }, config: CONFIG }, db),
    ).toEqual({ ok: false, reason: "malformed_claims" });
    expect(
      resolveOidcAdmission({ claims: { iss: ISSUER, sub: 42 }, config: CONFIG }, db),
    ).toEqual({ ok: false, reason: "malformed_claims" });
  });

  it("denies a byte-different issuer even when host and path look related", () => {
    const { db } = setup();
    linkReviewer(db);

    expect(
      resolveOidcAdmission(
        { claims: claims({ iss: ISSUER.slice(0, -1) }), config: CONFIG },
        db,
      ),
    ).toEqual({ ok: false, reason: "issuer_mismatch" });
    expect(
      resolveOidcAdmission(
        { claims: claims({ iss: ISSUER.toUpperCase() }), config: CONFIG },
        db,
      ),
    ).toEqual({ ok: false, reason: "issuer_mismatch" });
  });

  it("denies an unlinked subject without revealing existence", () => {
    const { db, sqlite } = setup();

    expect(resolveOidcAdmission({ claims: claims(), config: CONFIG }, db)).toEqual({
      ok: false,
      reason: "identity_not_linked",
    });

    const rows = events(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("oidc.admission.denied");
    expect(rows[0].userId).toBeNull();
    expect(rows[0].metadata).not.toContain("subject-secret-1");
  });

  it("denies a retired identity link", () => {
    const { db } = setup();
    const link = linkReviewer(db);
    retireIdentityLink({ identityId: link.id, changeReason: "Retired.", now: NOW }, db);

    expect(resolveOidcAdmission({ claims: claims(), config: CONFIG }, db)).toEqual({
      ok: false,
      reason: "identity_retired",
    });
  });

  it("denies an inactive local user", () => {
    const { db, sqlite } = setup();
    linkReviewer(db);
    sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = 'user-reviewer'`).run();

    expect(resolveOidcAdmission({ claims: claims(), config: CONFIG }, db)).toEqual({
      ok: false,
      reason: "user_inactive",
    });
  });

  it("denies missing, zero, and multi role claims; never picks highest privilege", () => {
    const { db } = setup();
    linkReviewer(db);

    const { superscriber_role_group_ids: _drop, ...noClaim } = claims();
    expect(resolveOidcAdmission({ claims: noClaim, config: CONFIG }, db)).toEqual({
      ok: false,
      reason: "missing_claim",
    });

    expect(
      resolveOidcAdmission(
        { claims: claims({ superscriber_role_group_ids: [] }), config: CONFIG },
        db,
      ),
    ).toEqual({ ok: false, reason: "zero_role" });

    expect(
      resolveOidcAdmission(
        {
          claims: claims({ superscriber_role_group_ids: [GROUPS.reviewer, GROUPS.admin] }),
          config: CONFIG,
        },
        db,
      ),
    ).toEqual({ ok: false, reason: "multi_role" });
  });

  it("denies when mapped role disagrees with the local role", () => {
    const { db, sqlite } = setup();
    linkReviewer(db);
    sqlite.prepare(`UPDATE users SET role = 'approver' WHERE id = 'user-reviewer'`).run();

    expect(resolveOidcAdmission({ claims: claims(), config: CONFIG }, db)).toEqual({
      ok: false,
      reason: "role_mismatch",
    });
  });

  it("records only a redacted denial during the pre-mint admission check", () => {
    const { db, sqlite } = setup();
    const link = linkReviewer(db);
    sqlite.prepare(`UPDATE users SET role = 'approver' WHERE id = 'user-reviewer'`).run();

    const result = resolveOidcAdmission(
      {
        claims: claims(),
        config: CONFIG,
        recordEvent: false,
        recordDeniedEvent: true,
        now: NOW,
      },
      db,
    );

    expect(result).toEqual({ ok: false, reason: "role_mismatch" });
    const rows = events(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "oidc.admission.denied",
      outcome: "denied",
      userId: "user-reviewer",
    });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({
      data: { reason: "role_mismatch", issuer: ISSUER },
    });
    expect(rows[0].metadata).not.toContain("subject-secret-1");
    expect(rows[0].metadata).not.toContain(GROUPS.reviewer);
    const identity = sqlite
      .prepare(`SELECT last_login_at AS lastLoginAt FROM external_identities WHERE id = ?`)
      .get(link.id) as { lastLoginAt: string | null };
    expect(identity.lastLoginAt).toBeNull();
  });

  it("is side-effect free when recordEvent is false", () => {
    const { db, sqlite } = setup();
    const link = linkReviewer(db);
    events(sqlite); // consume nothing

    const result = resolveOidcAdmission(
      { claims: claims(), config: CONFIG, recordEvent: false, now: NOW },
      db,
    );

    expect(result.ok).toBe(true);
    expect(events(sqlite)).toHaveLength(0);
    const row = sqlite
      .prepare(`SELECT last_login_at AS lla FROM external_identities WHERE id = ?`)
      .get(link.id) as { lla: string | null };
    expect(row.lla).toBeNull();
  });
});
