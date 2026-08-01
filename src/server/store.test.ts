import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, resetAppDatabaseForTests } from "@/server/db/client";
import { runGovernedTransaction } from "@/server/db/transaction";
import { recordings } from "@/server/db/schema";
import { readState, withState, writeState } from "@/server/store";

describe("sqlite state store", () => {
  beforeEach(() => {
    process.env.SUPERSCRIBER_DB_PATH = ":memory:";
    resetAppDatabaseForTests();
  });

  afterEach(() => {
    resetAppDatabaseForTests();
    delete process.env.SUPERSCRIBER_DB_PATH;
  });

  it("seeds the workflow state inside sqlite on first read", () => {
    const state = readState();

    expect(state.workspaces).toHaveLength(1);
    expect(state.recordings.length).toBeGreaterThan(0);
    expect(state.revisions.length).toBeGreaterThan(0);
  });

  it("persists state mutations back to sqlite", () => {
    const initial = readState();
    const targetId = initial.recordings[0]?.id;
    expect(targetId).toBeTruthy();

    withState((state) => {
      const recording = state.recordings.find((entry) => entry.id === targetId);
      if (!recording) {
        throw new Error("Expected seeded recording.");
      }

      recording.title = "Persisted SQLite title";
    });

    const reloaded = readState();
    expect(reloaded.recordings.find((entry) => entry.id === targetId)?.title).toBe(
      "Persisted SQLite title",
    );
  });

  it("rejects stale snapshot writes from a second database connection", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "superscriber-store-"));
    const databasePath = join(tempRoot, "state.db");
    const first = openAppDatabase(databasePath);
    const second = openAppDatabase(databasePath);

    try {
      const staleSnapshot = readState(first.db);
      const targetId = staleSnapshot.recordings[0]?.id;
      expect(targetId).toBeTruthy();

      withState((state) => {
        const recording = state.recordings.find((entry) => entry.id === targetId);
        if (!recording) {
          throw new Error("Expected seeded recording.");
        }

        recording.title = "Fresh title from second writer";
      }, second.db);

      const staleRecording = staleSnapshot.recordings.find((entry) => entry.id === targetId);
      if (!staleRecording) {
        throw new Error("Expected stale recording snapshot.");
      }
      staleRecording.verificationSummary = "Stale writer should not overwrite fresh data.";

      expect(() => writeState(staleSnapshot, first.db)).toThrow(
        /State changed concurrently/,
      );

      const reloaded = readState(second.db);
      const persisted = reloaded.recordings.find((entry) => entry.id === targetId);
      expect(persisted?.title).toBe("Fresh title from second writer");
      expect(persisted?.verificationSummary).not.toBe(
        "Stale writer should not overwrite fresh data.",
      );
    } finally {
      first.sqlite.close();
      second.sqlite.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects stale snapshot writes after a targeted governed transaction", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "superscriber-store-"));
    const databasePath = join(tempRoot, "state.db");
    const first = openAppDatabase(databasePath);
    const second = openAppDatabase(databasePath);

    try {
      const snapshot = readState(first.db);
      const targetId = snapshot.recordings[0]?.id;
      expect(targetId).toBeTruthy();

      runGovernedTransaction((db) => {
        db.update(recordings).set({ title: "Targeted write" }).where(eq(recordings.id, targetId!)).run();
      }, second);

      expect(() => writeState(snapshot, first.db)).toThrow(/State changed concurrently/);
    } finally {
      first.sqlite.close();
      second.sqlite.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
