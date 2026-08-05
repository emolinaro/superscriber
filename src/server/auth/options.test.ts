import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JWT } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authOptions } from "@/server/auth/options";
import { createLocalUser } from "@/server/auth/service";
import { getAppDbBundle, resetAppDatabaseForTests } from "@/server/db/client";

const jwtCallback = authOptions.callbacks!.jwt!;
const sessionCallback = authOptions.callbacks!.session!;

describe("auth options session registry integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "superscriber-options-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempDir, "test.db");
    resetAppDatabaseForTests();
  });

  afterEach(() => {
    resetAppDatabaseForTests();
    delete process.env.SUPERSCRIBER_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedUser(role: "admin" | "reviewer" = "reviewer") {
    const { db } = getAppDbBundle();
    return createLocalUser(
      {
        displayName: "Callback User",
        email: "callback@example.com",
        password: "Superscriber!123",
        role,
      },
      db,
    );
  }

  async function signIn(userId: string) {
    const token = (await jwtCallback({
      token: {} as JWT,
      user: {
        id: userId,
        email: "callback@example.com",
        name: "Callback User",
        role: "reviewer",
      },
      // The callbacks only need token/user/session for these flows.
    } as never)) as JWT;

    return token;
  }

  it("issues a schema-v2 token backed by a durable session row on sign-in", async () => {
    const user = await seedUser();
    const { sqlite } = getAppDbBundle();

    const token = await signIn(user.id);

    expect(token.tokenVersion).toBe(2);
    expect(token.userId).toBe(user.id);
    expect(typeof token.authSessionId).toBe("string");
    expect(token.authSource).toBe("local");
    expect(token.role).toBeUndefined();

    const row = sqlite
      .prepare(`SELECT status, auth_source AS authSource, user_id AS userId FROM auth_sessions WHERE id = ?`)
      .get(token.authSessionId) as { status: string; authSource: string; userId: string };
    expect(row).toEqual({ status: "active", authSource: "local", userId: user.id });
  });

  it("rejects legacy tokens that predate the session registry", async () => {
    await seedUser();

    const legacy = (await jwtCallback({
      token: { userId: "user-1", role: "admin", name: "Legacy", email: "legacy@example.com" } as JWT,
    } as never)) as JWT;

    expect(legacy).toEqual({});

    const resolved = (await sessionCallback({
      session: { user: { name: "Legacy", email: "legacy@example.com" }, expires: "x" } as never,
      token: legacy,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { user?: { id?: string } };

    expect(resolved.user?.id).toBeUndefined();
  });

  it("rejects tokens whose registry session was revoked", async () => {
    const user = await seedUser();
    const { sqlite } = getAppDbBundle();
    const token = await signIn(user.id);

    sqlite
      .prepare(`UPDATE auth_sessions SET status = 'revoked', revoked_at = ?, revoked_reason = 'test' WHERE id = ?`)
      .run(new Date().toISOString(), token.authSessionId);

    const refreshed = (await jwtCallback({ token } as never)) as JWT;
    expect(refreshed).toEqual({});

    const resolved = (await sessionCallback({
      session: { user: {}, expires: "x" } as never,
      token: refreshed,
    } as never)) as { user?: { id?: string } };

    expect(resolved.user?.id).toBeUndefined();
  });

  it("resolves the role live from the database on every session read", async () => {
    const user = await seedUser("reviewer");
    const { sqlite } = getAppDbBundle();
    const token = await signIn(user.id);

    // Apply the role change after the token exists; the cookie must not pin it.
    sqlite.prepare(`UPDATE users SET role = 'approver' WHERE id = ?`).run(user.id);

    const refreshed = (await jwtCallback({ token } as never)) as JWT;
    expect(refreshed.userId).toBe(user.id);

    const resolved = (await sessionCallback({
      session: { user: {}, expires: "x" } as never,
      token: refreshed,
    } as never)) as {
      user?: { id?: string; role?: string; name?: string | null; email?: string | null };
      authSource?: string;
      authSessionId?: string;
    };

    expect(resolved.user).toMatchObject({
      id: user.id,
      role: "approver",
      name: "Callback User",
      email: "callback@example.com",
    });
    expect(resolved.authSource).toBe("local");
    expect(resolved.authSessionId).toBe(token.authSessionId);
  });

  it("denies sessions immediately when the user is suspended", async () => {
    const user = await seedUser();
    const { sqlite } = getAppDbBundle();
    const token = await signIn(user.id);

    sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = ?`).run(user.id);

    const refreshed = (await jwtCallback({ token } as never)) as JWT;
    expect(refreshed).toEqual({});
  });
});
