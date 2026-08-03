import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAuthConfig } from "@/server/auth/auth-config";

const ISSUER = "https://auth.example.com/application/o/superscriber/";

describe("auth config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-authcfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRoleMap(contents: unknown) {
    const path = join(dir, "role-map.json");
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
    return path;
  }

  const VALID_ROLE_MAP = {
    version: 1,
    issuer: ISSUER,
    claim: "superscriber_role_group_ids",
    groups: {
      uploader: "11111111-1111-4111-8111-111111111111",
      reviewer: "22222222-2222-4222-8222-222222222222",
      approver: "33333333-3333-4333-8333-333333333333",
      admin: "44444444-4444-4444-8444-444444444444",
    },
  };

  it("defaults to local mode when nothing is configured", () => {
    expect(loadAuthConfig({})).toEqual({ mode: "local" });
  });

  it("rejects an unknown auth mode", () => {
    expect(() => loadAuthConfig({ SUPERSCRIBER_AUTH_MODE: "oidc" })).toThrow(/AUTH_MODE/);
  });

  it("rejects dual mode with missing OIDC settings and lists them all", () => {
    expect(() => loadAuthConfig({ SUPERSCRIBER_AUTH_MODE: "dual" })).toThrow(
      /SUPERSCRIBER_OIDC_ISSUER[\s\S]*SUPERSCRIBER_OIDC_CLIENT_ID[\s\S]*SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE[\s\S]*SUPERSCRIBER_OIDC_ROLE_MAP_FILE/,
    );
  });

  it("requires the canonical issuer to end with a slash", () => {
    const roleMapPath = writeRoleMap(VALID_ROLE_MAP);
    expect(() =>
      loadAuthConfig({
        SUPERSCRIBER_AUTH_MODE: "dual",
        SUPERSCRIBER_OIDC_ISSUER: ISSUER.slice(0, -1),
        SUPERSCRIBER_OIDC_CLIENT_ID: "superscriber",
        SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE: join(dir, "client-secret"),
        SUPERSCRIBER_OIDC_ROLE_MAP_FILE: roleMapPath,
      }),
    ).toThrow(/issu/i);
  });

  it("loads and validates a complete dual configuration", () => {
    const roleMapPath = writeRoleMap(VALID_ROLE_MAP);

    const config = loadAuthConfig({
      SUPERSCRIBER_AUTH_MODE: "dual",
      SUPERSCRIBER_OIDC_ISSUER: ISSUER,
      SUPERSCRIBER_OIDC_CLIENT_ID: "superscriber",
      SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE: join(dir, "client-secret"),
      SUPERSCRIBER_OIDC_ROLE_MAP_FILE: roleMapPath,
    });

    expect(config.mode).toBe("dual");
    if (config.mode !== "local") {
      expect(config.oidc).toEqual({
        issuer: ISSUER,
        clientId: "superscriber",
        clientSecretFile: join(dir, "client-secret"),
      });
      expect(config.roleMap.version).toBe(1);
      expect(config.roleMap.groups.admin).toBe(
        "44444444-4444-4444-8444-444444444444",
      );
    }
  });

  it("rejects a role map whose issuer differs from the configured issuer", () => {
    const roleMapPath = writeRoleMap({
      ...VALID_ROLE_MAP,
      issuer: "https://auth.example.com/application/o/other/",
    });

    expect(() =>
      loadAuthConfig({
        SUPERSCRIBER_AUTH_MODE: "dual",
        SUPERSCRIBER_OIDC_ISSUER: ISSUER,
        SUPERSCRIBER_OIDC_CLIENT_ID: "superscriber",
        SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE: join(dir, "client-secret"),
        SUPERSCRIBER_OIDC_ROLE_MAP_FILE: roleMapPath,
      }),
    ).toThrow(/issuer/i);
  });

  it("rejects role maps with duplicate, missing, or non-UUID group ids", () => {
    const duplicated = {
      ...VALID_ROLE_MAP,
      groups: { ...VALID_ROLE_MAP.groups, admin: VALID_ROLE_MAP.groups.admin, approver: VALID_ROLE_MAP.groups.admin },
    };
    const roleMapPath = writeRoleMap(duplicated);

    expect(() =>
      loadAuthConfig({
        SUPERSCRIBER_AUTH_MODE: "dual",
        SUPERSCRIBER_OIDC_ISSUER: ISSUER,
        SUPERSCRIBER_OIDC_CLIENT_ID: "superscriber",
        SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE: join(dir, "client-secret"),
        SUPERSCRIBER_OIDC_ROLE_MAP_FILE: roleMapPath,
      }),
    ).toThrow(/distinct/);
  });

  it("rejects a malformed role map file and a wrong claim name", () => {
    const roleMapPath = writeRoleMap({ ...VALID_ROLE_MAP, claim: "groups" });

    expect(() =>
      loadAuthConfig({
        SUPERSCRIBER_AUTH_MODE: "dual",
        SUPERSCRIBER_OIDC_ISSUER: ISSUER,
        SUPERSCRIBER_OIDC_CLIENT_ID: "superscriber",
        SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE: join(dir, "client-secret"),
        SUPERSCRIBER_OIDC_ROLE_MAP_FILE: roleMapPath,
      }),
    ).toThrow(/claim/i);
  });
});
