import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppDatabaseForTests } from "@/server/db/client";
import {
  resolveApprovedTranscriptExport,
  resolveApprovedTranscriptExportForPrincipal,
} from "@/server/repository";
import { withState } from "@/server/store";

vi.mock("server-only", () => ({}));

describe("repository approved transcript export resolution", () => {
  beforeEach(() => {
    process.env.SUPERSCRIBER_DB_PATH = ":memory:";
    resetAppDatabaseForTests();
  });

  afterEach(() => {
    resetAppDatabaseForTests();
    delete process.env.SUPERSCRIBER_DB_PATH;
  });

  it("exports an approved revision as json with the format-specific extension and content type", async () => {
    withState((state) => {
      const recording = state.recordings.find((entry) => entry.id === "rec-seed-approval");
      const revision = state.revisions.find((entry) => entry.id === "rev-seed-pending");
      if (!recording || !revision) {
        throw new Error("Expected seeded approval recording and revision.");
      }

      recording.approvedRevisionId = revision.id;
      recording.pendingRevisionId = null;
      revision.state = "approved";
      revision.approvedAt = "2026-05-01T00:00:00.000Z";
    });

    const result = await resolveApprovedTranscriptExport(
      "rec-seed-approval",
      "approver",
      "json",
    );

    expect(result).toEqual(
      expect.objectContaining({
        denied: false,
        missing: false,
        fileName: "Seeded-pending-approval-item-approved-v2.json",
        contentType: "application/json; charset=utf-8",
      }),
    );

    if (!result || result.denied || result.missing) {
      throw new Error("Expected approved export payload.");
    }

    const body = JSON.parse(new TextDecoder().decode(result.body));
    expect(body.metadata).toEqual(
      expect.objectContaining({
        recordingId: "rec-seed-approval",
        revisionId: "rev-seed-pending",
        revisionVersion: 2,
        revisionState: "approved",
      }),
    );
  });

  it("preserves denied and missing export branches", async () => {
    const denied = await resolveApprovedTranscriptExport("rec-seed-review", "reviewer");
    expect(denied).toEqual({
      denied: true,
      reason:
        "This role cannot export approved transcripts in the current policy profile.",
    });

    const missing = await resolveApprovedTranscriptExport("rec-seed-review", "approver");
    expect(missing).toEqual({
      denied: false,
      missing: true,
    });
  });

  it("keeps the principal-facing wrapper async for denied and approved branches", async () => {
    const denied = await resolveApprovedTranscriptExportForPrincipal("rec-seed-review", {
      userId: "user-reviewer",
      email: "reviewer@example.com",
      displayName: "Reviewer",
      role: "reviewer",
    });
    expect(denied).toEqual({
      denied: true,
      reason: "This recording is not assigned to your account.",
    });

    withState((state) => {
      const recording = state.recordings.find((entry) => entry.id === "rec-seed-approval");
      const revision = state.revisions.find((entry) => entry.id === "rev-seed-pending");
      if (!recording || !revision) {
        throw new Error("Expected seeded approval recording and revision.");
      }

      recording.approvedRevisionId = revision.id;
      recording.pendingRevisionId = null;
      revision.state = "approved";
      revision.approvedAt = "2026-05-01T00:00:00.000Z";
    });

    const approved = await resolveApprovedTranscriptExportForPrincipal(
      "rec-seed-approval",
      {
        userId: "user-admin",
        email: "admin@example.com",
        displayName: "Admin",
        role: "admin",
      },
      "txt",
    );

    expect(approved).toEqual(
      expect.objectContaining({
        denied: false,
        missing: false,
        fileName: "Seeded-pending-approval-item-approved-v2.txt",
        contentType: "text/plain; charset=utf-8",
      }),
    );
  });
});
