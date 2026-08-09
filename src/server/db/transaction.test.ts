import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase } from "@/server/db/client";
import { appStateMeta, users } from "@/server/db/schema";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-08T00:00:00.000Z";

function createFileBundle() {
  const directory = mkdtempSync(join(tmpdir(), "superscriber-immediate-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "app.db");
  const bundle = openAppDatabase(path);
  bundle.db.insert(users).values({
    id: "user-1",
    email: "user-1@example.com",
    displayName: "Original",
    passwordHash: "hash",
    role: "reviewer",
    isActive: true,
    authVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
  return { bundle, path };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runImmediateGovernedTransaction", () => {
  it("holds the write reservation and advances state version once", () => {
    const { bundle, path } = createFileBundle();
    const competing = new Database(path);
    competing.pragma("busy_timeout = 0");

    try {
      const result = runImmediateGovernedTransaction((db, now) => {
        expect(() =>
          competing
            .prepare("update users set display_name = 'Competing' where id = 'user-1'")
            .run(),
        ).toThrow(/database is locked/);
        db.update(users)
          .set({ displayName: "Changed", updatedAt: now })
          .where(eq(users.id, "user-1"))
          .run();
        return now;
      }, bundle);

      expect(Date.parse(result)).not.toBeNaN();
      expect(
        bundle.db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, "user-1"))
          .get(),
      ).toEqual({ displayName: "Changed" });
      expect(bundle.db.select().from(appStateMeta).get()?.stateVersion).toBe(1);
    } finally {
      competing.close();
      bundle.sqlite.close();
    }
  });

  it("rolls back the operation when state version cannot advance", () => {
    const { bundle } = createFileBundle();
    bundle.sqlite.exec(`
      CREATE TRIGGER abort_state_version
      BEFORE UPDATE ON app_state_meta
      BEGIN
        SELECT RAISE(ABORT, 'state version unavailable');
      END;
    `);

    try {
      expect(() =>
        runImmediateGovernedTransaction((db, now) => {
          db.update(users)
            .set({ displayName: "Must roll back", updatedAt: now })
            .where(eq(users.id, "user-1"))
            .run();
        }, bundle),
      ).toThrow(/state version unavailable/);

      expect(
        bundle.db
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, "user-1"))
          .get(),
      ).toEqual({ displayName: "Original" });
      expect(bundle.db.select().from(appStateMeta).get()?.stateVersion).toBe(0);
    } finally {
      bundle.sqlite.close();
    }
  });
});
