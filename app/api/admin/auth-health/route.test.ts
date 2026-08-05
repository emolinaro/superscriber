import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  getActivePrincipal: vi.fn(),
}));

import { getActivePrincipal } from "@/server/session";

describe("auth-health route", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-authhealth-"));
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

  async function callGet() {
    const { GET } = await import("./route");
    return GET();
  }

  it("rejects anonymous and non-admin callers", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(null);
    expect((await callGet()).status).toBe(401);

    vi.mocked(getActivePrincipal).mockResolvedValue({
      userId: "u1",
      email: "r@example.com",
      displayName: "R",
      role: "reviewer",
    });
    expect((await callGet()).status).toBe(403);
  });

  it("returns the redacted summary for admins", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue({
      userId: "admin-1",
      email: "a@example.com",
      displayName: "A",
      role: "admin",
    });

    const response = await callGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("mode");
    expect(body).toHaveProperty("sessions");
    expect(body).toHaveProperty("breakGlass");
    expect(JSON.stringify(body)).not.toContain("@");
  });
});
