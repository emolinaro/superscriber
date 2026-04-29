import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAppDatabaseForTests } from "@/server/db/client";
import { readState, withState } from "@/server/store";

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
});
