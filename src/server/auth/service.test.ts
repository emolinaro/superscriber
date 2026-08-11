import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openAppDatabase } from "@/server/db/client";
import { users } from "@/server/db/schema";
import {
  createBootstrapAdmin,
  createLocalUser,
  getUserByEmail,
  hasAnyActiveAdmin,
  hasAnyUsers,
  verifyLocalCredentials,
} from "@/server/auth/service";

describe("local auth service", () => {
  afterEach(() => {
    delete process.env.SUPERSCRIBER_DB_PATH;
  });

  it("creates the first local user and persists normalized email", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      expect(await hasAnyUsers(bundle.db)).toBe(false);

      const user = await createLocalUser(
        {
          displayName: "Ada Lovelace",
          email: "Ada@Example.com",
          password: "correct horse battery staple",
          role: "admin",
        },
        bundle.db,
      );

      expect(user.email).toBe("ada@example.com");
      expect(await hasAnyUsers(bundle.db)).toBe(true);

      const reloaded = await getUserByEmail("ADA@example.com", bundle.db);
      expect(reloaded?.displayName).toBe("Ada Lovelace");
      expect(reloaded?.role).toBe("admin");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects duplicate emails", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      await createLocalUser(
        {
          displayName: "Grace Hopper",
          email: "grace@example.com",
          password: "correct horse battery staple",
          role: "admin",
        },
        bundle.db,
      );

      await expect(
        createLocalUser(
          {
            displayName: "Another Grace",
            email: "GRACE@example.com",
            password: "correct horse battery staple",
            role: "reviewer",
          },
          bundle.db,
        ),
      ).rejects.toThrow("An account with that email already exists.");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      await createLocalUser(
        {
          displayName: "Katherine Johnson",
          email: "kj@example.com",
          password: "correct horse battery staple",
          role: "reviewer",
        },
        bundle.db,
      );

      const accepted = await verifyLocalCredentials(
        {
          email: "kj@example.com",
          password: "correct horse battery staple",
        },
        bundle.db,
      );
      const denied = await verifyLocalCredentials(
        {
          email: "kj@example.com",
          password: "incorrect password",
        },
        bundle.db,
      );

      expect(accepted?.displayName).toBe("Katherine Johnson");
      expect(denied).toBeNull();
    } finally {
      bundle.sqlite.close();
    }
  });

  it("detects whether an active administrator remains", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      expect(await hasAnyActiveAdmin(bundle.db)).toBe(false);

      await createLocalUser(
        {
          displayName: "Uploader One",
          email: "uploader@example.com",
          password: "correct horse battery staple",
          role: "uploader",
        },
        bundle.db,
      );
      expect(await hasAnyActiveAdmin(bundle.db)).toBe(false);

      const admin = await createLocalUser(
        {
          displayName: "Admin One",
          email: "admin@example.com",
          password: "correct horse battery staple",
          role: "admin",
        },
        bundle.db,
      );
      expect(await hasAnyActiveAdmin(bundle.db)).toBe(true);

      // A deactivated admin does not keep the appliance manageable: the
      // users-survive-but-no-admin case must still surface recovery.
      bundle.db
        .update(users)
        .set({ isActive: false })
        .where(eq(users.id, admin.id))
        .run();
      expect(await hasAnyUsers(bundle.db)).toBe(true);
      expect(await hasAnyActiveAdmin(bundle.db)).toBe(false);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("allows only one concurrent bootstrap admin creation", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const results = await Promise.allSettled([
        createBootstrapAdmin(
          {
            displayName: "First Admin",
            email: "first@example.com",
            password: "correct horse battery staple",
          },
          bundle,
        ),
        createBootstrapAdmin(
          {
            displayName: "Second Admin",
            email: "second@example.com",
            password: "correct horse battery staple",
          },
          bundle,
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await hasAnyUsers(bundle.db)).toBe(true);

      const firstUser = await getUserByEmail("first@example.com", bundle.db);
      const secondUser = await getUserByEmail("second@example.com", bundle.db);
      expect(Boolean(firstUser) || Boolean(secondUser)).toBe(true);
      expect(Boolean(firstUser) && Boolean(secondUser)).toBe(false);
    } finally {
      bundle.sqlite.close();
    }
  });
});
