import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  getActivePrincipal: vi.fn(),
}));

import { getActivePrincipal } from "@/server/session";

const REVIEWER = {
  userId: "user-reviewer",
  email: "reviewer@example.com",
  displayName: "Reviewer",
  role: "reviewer" as const,
};

async function seedUser(themePreference?: string) {
  const { getAppDbBundle } = await import("@/server/db/client");
  const { sqlite } = getAppDbBundle();
  const now = "2026-08-10T00:00:00.000Z";
  if (themePreference === undefined) {
    sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'hash', 'reviewer', 1, ?, ?)`,
      )
      .run(REVIEWER.userId, REVIEWER.email, REVIEWER.displayName, now, now);
    return;
  }
  sqlite
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, theme_preference, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'reviewer', 1, ?, ?, ?)`,
    )
    .run(REVIEWER.userId, REVIEWER.email, REVIEWER.displayName, themePreference, now, now);
}

async function callGet() {
  const { GET } = await import("./route");
  return GET();
}

async function callPost(body: unknown) {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost/api/preferences/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("theme preference route", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-theme-"));
    process.env.SUPERSCRIBER_DB_PATH = join(dir, "test.db");
  });

  afterEach(async () => {
    const { resetAppDatabaseForTests } = await import("@/server/db/client");
    resetAppDatabaseForTests();
    delete process.env.SUPERSCRIBER_DB_PATH;
    rmSync(dir, { recursive: true, force: true });
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("rejects anonymous callers on GET and POST", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(null);

    expect((await callGet()).status).toBe(401);
    expect((await callPost({ themePreference: "dark" })).status).toBe(401);
  });

  it("defaults to system for users without a stored preference", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(REVIEWER);
    await seedUser();

    const response = await callGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ themePreference: "system" });
  });

  it("persists a valid preference and serves it back", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(REVIEWER);
    await seedUser();

    const post = await callPost({ themePreference: "dark" });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true, themePreference: "dark" });

    const get = await callGet();
    expect(await get.json()).toEqual({ themePreference: "dark" });

    const { getAppDbBundle } = await import("@/server/db/client");
    const row = getAppDbBundle()
      .sqlite.prepare(`SELECT theme_preference FROM users WHERE id = ?`)
      .get(REVIEWER.userId) as { theme_preference: string };
    expect(row.theme_preference).toBe("dark");
  });

  it("rejects malformed bodies and unsupported values without touching the row", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(REVIEWER);
    await seedUser("light");

    expect((await callPost("not json")).status).toBe(400);
    expect((await callPost({})).status).toBe(400);
    expect((await callPost({ themePreference: "solarized" })).status).toBe(400);
    expect((await callPost({ themePreference: 42 })).status).toBe(400);

    const { getAppDbBundle } = await import("@/server/db/client");
    const row = getAppDbBundle()
      .sqlite.prepare(`SELECT theme_preference FROM users WHERE id = ?`)
      .get(REVIEWER.userId) as { theme_preference: string };
    expect(row.theme_preference).toBe("light");
  });
});
