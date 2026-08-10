import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  SUPERSCRIBER_AUTH_MODE: process.env.SUPERSCRIBER_AUTH_MODE,
  SUPERSCRIBER_DEPLOYMENT_PROFILE: process.env.SUPERSCRIBER_DEPLOYMENT_PROFILE,
  SUPERSCRIBER_OIDC_ISSUER: process.env.SUPERSCRIBER_OIDC_ISSUER,
  SUPERSCRIBER_OIDC_CLIENT_ID: process.env.SUPERSCRIBER_OIDC_CLIENT_ID,
  SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE: process.env.SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE,
  SUPERSCRIBER_OIDC_ROLE_MAP_FILE: process.env.SUPERSCRIBER_OIDC_ROLE_MAP_FILE,
};

const OIDC_ENV_KEYS = [
  "SUPERSCRIBER_AUTH_MODE",
  "SUPERSCRIBER_DEPLOYMENT_PROFILE",
  "SUPERSCRIBER_OIDC_ISSUER",
  "SUPERSCRIBER_OIDC_CLIENT_ID",
  "SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE",
  "SUPERSCRIBER_OIDC_ROLE_MAP_FILE",
];

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
    for (const key of OIDC_ENV_KEYS) {
      delete process.env[key];
    }
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
      expect.objectContaining({ id: "auth_configuration", state: "ready" }),
      expect.objectContaining({ id: "deployment_profile", state: "ready" }),
      expect.objectContaining({ id: "reset_mail", state: "ready" }),
    ]);

    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: "deployment_profile",
        detail: expect.stringContaining("No-mail"),
      }),
    );

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

  it("blocks an unknown deployment profile", async () => {
    process.env.SUPERSCRIBER_DEPLOYMENT_PROFILE = "smtp";

    const readiness = await getBootstrapReadiness();

    expect(readiness.overall).toBe("blocked");
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({ id: "deployment_profile", state: "blocked" }),
    );
  });

  it("reports operator-assisted resets when reset mail is unconfigured", async () => {
    const readiness = await getBootstrapReadiness();
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: "reset_mail",
        state: "ready",
        detail: expect.stringContaining("operator-assisted"),
      }),
    );
  });

  it("blocks a malformed smtp reset-mail configuration", async () => {
    process.env.SUPERSCRIBER_RESET_MAIL_MODE = "smtp";

    const readiness = await getBootstrapReadiness();

    expect(readiness.overall).toBe("blocked");
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({ id: "reset_mail", state: "blocked" }),
    );
    expect(JSON.stringify(readiness)).not.toContain(tempRoot);
  });

  it("needs no SMTP settings to be healthy in the no-mail profile", async () => {
    const readiness = await getBootstrapReadiness();
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({ id: "deployment_profile", state: "ready" }),
    );
  });

  it("blocks dual mode when OIDC settings are missing", async () => {
    process.env.SUPERSCRIBER_AUTH_MODE = "dual";

    const readiness = await getBootstrapReadiness();

    expect(readiness.overall).toBe("blocked");
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({ id: "auth_configuration", state: "blocked" }),
    );
  });

  it("reports dual mode ready with a complete OIDC configuration", async () => {
    const secretFile = join(tempRoot, "client-secret");
    const roleMapFile = join(tempRoot, "role-map.json");
    process.env.SUPERSCRIBER_AUTH_MODE = "dual";
    process.env.SUPERSCRIBER_OIDC_ISSUER = "https://auth.example.com/application/o/superscriber/";
    process.env.SUPERSCRIBER_OIDC_CLIENT_ID = "superscriber";
    process.env.SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE = secretFile;
    process.env.SUPERSCRIBER_OIDC_ROLE_MAP_FILE = roleMapFile;
    writeFileSync(secretFile, "secret\n");
    writeFileSync(
      roleMapFile,
      JSON.stringify({
        version: 1,
        issuer: process.env.SUPERSCRIBER_OIDC_ISSUER,
        claim: "superscriber_role_group_ids",
        groups: {
          uploader: "11111111-1111-4111-8111-111111111111",
          reviewer: "22222222-2222-4222-8222-222222222222",
          approver: "33333333-3333-4333-8333-333333333333",
          admin: "44444444-4444-4444-8444-444444444444",
        },
      }),
    );

    const readiness = await getBootstrapReadiness();

    expect(readiness.checks).toContainEqual(
      expect.objectContaining({ id: "auth_configuration", state: "ready" }),
    );
  });

  it("blocks authentik-primary without a complete break-glass invariant", async () => {
    const secretFile = join(tempRoot, "client-secret");
    const roleMapFile = join(tempRoot, "role-map.json");
    process.env.SUPERSCRIBER_AUTH_MODE = "authentik-primary";
    process.env.SUPERSCRIBER_OIDC_ISSUER = "https://auth.example.com/application/o/superscriber/";
    process.env.SUPERSCRIBER_OIDC_CLIENT_ID = "superscriber";
    process.env.SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE = secretFile;
    process.env.SUPERSCRIBER_OIDC_ROLE_MAP_FILE = roleMapFile;
    writeFileSync(secretFile, "secret\n");
    writeFileSync(
      roleMapFile,
      JSON.stringify({
        version: 1,
        issuer: process.env.SUPERSCRIBER_OIDC_ISSUER,
        claim: "superscriber_role_group_ids",
        groups: {
          uploader: "11111111-1111-4111-8111-111111111111",
          reviewer: "22222222-2222-4222-8222-222222222222",
          approver: "33333333-3333-4333-8333-333333333333",
          admin: "44444444-4444-4444-8444-444444444444",
        },
      }),
    );

    // No designation at all.
    let readiness = await getBootstrapReadiness();
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: "auth_configuration",
        state: "blocked",
        detail: expect.stringContaining("designated break-glass"),
      }),
    );

    // Designation without enrolled keys or recovery custody.
    const { openAppDatabase } = await import("@/server/db/client");
    const bundle = openAppDatabase(join(tempRoot, "state.db"));
    const now = new Date().toISOString();
    bundle.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ('bg-1', 'bg@example.com', 'BG', 'hash', 'admin', 1, ?, ?)`,
      )
      .run(now, now);
    bundle.sqlite
      .prepare(
        `INSERT INTO auth_control (id, break_glass_user_id, updated_at, change_reason)
         VALUES (1, 'bg-1', ?, 'readiness test')`,
      )
      .run(now);

    readiness = await getBootstrapReadiness();
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: "auth_configuration",
        state: "blocked",
        detail: expect.stringContaining("security keys"),
      }),
    );

    // Two keys but no recovery custody.
    const insertKey = bundle.sqlite.prepare(
      `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, created_at)
       VALUES (?, 'bg-1', 'pk', 0, ?)`,
    );
    insertKey.run("cred-1", now);
    insertKey.run("cred-2", now);

    readiness = await getBootstrapReadiness();
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: "auth_configuration",
        state: "blocked",
        detail: expect.stringContaining("recovery custody"),
      }),
    );

    // Full invariant: ready.
    bundle.sqlite
      .prepare(
        `INSERT INTO break_glass_recovery_codes (id, break_glass_user_id, code_hash, created_at)
         VALUES ('rc-1', 'bg-1', 'codehash', ?)`,
      )
      .run(now);

    readiness = await getBootstrapReadiness();
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({ id: "auth_configuration", state: "ready" }),
    );
  });
});
