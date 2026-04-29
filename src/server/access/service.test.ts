import { describe, expect, it } from "vitest";
import {
  assignRecordingToUser,
  canAccessRecording,
  listAssignments,
  listLocalUsers,
  removeRecordingAssignment,
  visibleRecordingIdsForPrincipal,
} from "@/server/access/service";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { openAppDatabase } from "@/server/db/client";

describe("access service", () => {
  it("assigns recordings to reviewer and approver accounts", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser(
        {
          displayName: "Admin",
          email: "admin@example.com",
          password: "correct horse battery staple",
          role: "admin",
        },
        bundle.db,
      );
      const reviewer = await createLocalUser(
        {
          displayName: "Reviewer",
          email: "reviewer@example.com",
          password: "correct horse battery staple",
          role: "reviewer",
        },
        bundle.db,
      );

      assignRecordingToUser(
        {
          recordingId: "rec-1",
          userId: reviewer.id,
          assignedByUserId: admin.id,
        },
        bundle.db,
      );

      const assignments = listAssignments({ recordingIds: ["rec-1"] }, bundle.db);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.userDisplayName).toBe("Reviewer");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("uses assignments to gate reviewer access while keeping admin access broad", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser(
        {
          displayName: "Admin",
          email: "admin@example.com",
          password: "correct horse battery staple",
          role: "admin",
        },
        bundle.db,
      );
      const reviewer = await createLocalUser(
        {
          displayName: "Reviewer",
          email: "reviewer@example.com",
          password: "correct horse battery staple",
          role: "reviewer",
        },
        bundle.db,
      );

      assignRecordingToUser(
        {
          recordingId: "rec-assigned",
          userId: reviewer.id,
          assignedByUserId: admin.id,
        },
        bundle.db,
      );

      expect(canAccessRecording(toPrincipal(reviewer), "rec-assigned", bundle.db).allowed).toBe(
        true,
      );
      expect(canAccessRecording(toPrincipal(reviewer), "rec-other", bundle.db).allowed).toBe(
        false,
      );
      expect(canAccessRecording(toPrincipal(admin), "rec-other", bundle.db).allowed).toBe(true);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("removes an active assignment from the visible set", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const admin = await createLocalUser(
        {
          displayName: "Admin",
          email: "admin@example.com",
          password: "correct horse battery staple",
          role: "admin",
        },
        bundle.db,
      );
      const reviewer = await createLocalUser(
        {
          displayName: "Reviewer",
          email: "reviewer@example.com",
          password: "correct horse battery staple",
          role: "reviewer",
        },
        bundle.db,
      );

      const assignment = assignRecordingToUser(
        {
          recordingId: "rec-assigned",
          userId: reviewer.id,
          assignedByUserId: admin.id,
        },
        bundle.db,
      );

      expect(listLocalUsers(bundle.db).find((user) => user.id === reviewer.id)?.activeAssignmentCount).toBe(1);
      expect(visibleRecordingIdsForPrincipal(toPrincipal(reviewer), bundle.db)?.has("rec-assigned")).toBe(
        true,
      );

      expect(removeRecordingAssignment(assignment.id, bundle.db)).toBe(true);
      expect(visibleRecordingIdsForPrincipal(toPrincipal(reviewer), bundle.db)?.has("rec-assigned")).toBe(
        false,
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("does not treat uploader accounts like global recording viewers", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const uploader = await createLocalUser(
        {
          displayName: "Uploader",
          email: "uploader@example.com",
          password: "correct horse battery staple",
          role: "uploader",
        },
        bundle.db,
      );

      expect(visibleRecordingIdsForPrincipal(toPrincipal(uploader), bundle.db)?.size).toBe(0);
      expect(canAccessRecording(toPrincipal(uploader), "rec-other", bundle.db).allowed).toBe(
        false,
      );
    } finally {
      bundle.sqlite.close();
    }
  });
});
