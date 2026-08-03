import { describe, expect, it } from "vitest";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { openAppDatabase } from "@/server/db/client";

describe("security events", () => {
  it("persists a redacted security event with structured metadata", () => {
    const { db, sqlite } = openAppDatabase(":memory:");

    const id = recordSecurityEvent(
      {
        type: "oidc.admission.denied",
        outcome: "denied",
        userId: null,
        sessionId: null,
        correlationId: "corr-1",
        sourceZone: "public",
        detail: "Denied: identity has no linked local account.",
        metadata: { reasonCode: "identity_not_linked" },
        now: new Date("2026-08-03T12:00:00.000Z"),
      },
      db,
    );

    const row = sqlite
      .prepare(`SELECT * FROM security_events WHERE id = ?`)
      .get(id) as Record<string, unknown>;

    expect(row.type).toBe("oidc.admission.denied");
    expect(row.outcome).toBe("denied");
    expect(row.correlation_id).toBe("corr-1");
    expect(row.source_zone).toBe("public");
    expect(row.created_at).toBe("2026-08-03T12:00:00.000Z");
    expect(JSON.parse(row.metadata as string)).toEqual({
      version: 1,
      data: { reasonCode: "identity_not_linked" },
    });
  });

  it("defaults metadata to an empty versioned envelope", () => {
    const { db, sqlite } = openAppDatabase(":memory:");

    const id = recordSecurityEvent({ type: "auth.session.revoked", outcome: "success" }, db);
    const row = sqlite
      .prepare(`SELECT metadata FROM security_events WHERE id = ?`)
      .get(id) as { metadata: string };

    expect(JSON.parse(row.metadata)).toEqual({ version: 1, data: {} });
  });
});
