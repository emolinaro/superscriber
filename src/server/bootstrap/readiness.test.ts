import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBootstrapReadiness } from "./readiness";

const ORIGINAL_ENV = {
  SUPERSCRIBER_DB_PATH: process.env.SUPERSCRIBER_DB_PATH,
  SUPERSCRIBER_MEDIA_DIR: process.env.SUPERSCRIBER_MEDIA_DIR,
  SUPERSCRIBER_UPLOAD_TMP_DIR: process.env.SUPERSCRIBER_UPLOAD_TMP_DIR,
  SUPERSCRIBER_ENGINE_MODE: process.env.SUPERSCRIBER_ENGINE_MODE,
  SUPERSCRIBER_ENGINE_DISPATCH_URL: process.env.SUPERSCRIBER_ENGINE_DISPATCH_URL,
  SUPERSCRIBER_APP_BASE_URL: process.env.SUPERSCRIBER_APP_BASE_URL,
  SUPERSCRIBER_WORKER_ENTRYPOINT: process.env.SUPERSCRIBER_WORKER_ENTRYPOINT,
  AUTH_SECRET: process.env.AUTH_SECRET,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
};

describe("getBootstrapReadiness", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-readiness-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "state.db");
    process.env.SUPERSCRIBER_MEDIA_DIR = join(tempRoot, "media");
    process.env.SUPERSCRIBER_UPLOAD_TMP_DIR = join(tempRoot, "uploads");
    process.env.SUPERSCRIBER_ENGINE_MODE = "mock";
    process.env.AUTH_SECRET = "top-secret-value";
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.SUPERSCRIBER_ENGINE_DISPATCH_URL;
    delete process.env.SUPERSCRIBER_APP_BASE_URL;
    delete process.env.SUPERSCRIBER_WORKER_ENTRYPOINT;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it("reports safe ready checks for the database, storage, secret, and engine configuration", async () => {
    const readiness = await getBootstrapReadiness();

    expect(readiness.overall).toBe("ready");
    expect(readiness.checks).toEqual([
      expect.objectContaining({ id: "database", state: "ready" }),
      expect.objectContaining({ id: "media_storage", state: "ready" }),
      expect.objectContaining({ id: "upload_storage", state: "ready" }),
      expect.objectContaining({ id: "auth_secret", state: "ready" }),
      expect.objectContaining({ id: "engine_configuration", state: "ready" }),
    ]);

    const copy = JSON.stringify(readiness);
    expect(copy).not.toContain(tempRoot);
    expect(copy).not.toContain("top-secret-value");
  });

  it("warns when internal worker mode is selected but the worker is absent", async () => {
    process.env.SUPERSCRIBER_ENGINE_MODE = "internal";
    process.env.SUPERSCRIBER_WORKER_ENTRYPOINT = join(tempRoot, "missing-worker.py");

    const readiness = await getBootstrapReadiness();

    expect(readiness.overall).toBe("warning");
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: "engine_configuration",
        state: "warning",
      }),
    );

    expect(JSON.stringify(readiness)).not.toContain("missing-worker.py");
  });

  it("blocks invalid engine modes without leaking filesystem paths", async () => {
    process.env.SUPERSCRIBER_ENGINE_MODE = "sidecar";

    const readiness = await getBootstrapReadiness();

    expect(readiness.overall).toBe("blocked");
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: "engine_configuration",
        state: "blocked",
      }),
    );
    expect(JSON.stringify(readiness)).not.toContain(tempRoot);
  });
});
