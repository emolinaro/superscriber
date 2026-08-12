import { readFileSync, statSync } from "node:fs";
import { z, ZodError } from "zod";
import { GROUP_ID_PATTERN, type RoleMap } from "@/server/auth/role-mapping";

/**
 * Server-only authentication configuration surface (plan section 3.1).
 *
 * Auth modes form a state machine: `local` (credentials only, OIDC config may
 * be absent), `dual` (credentials + OIDC for linked users), and
 * `authentik-primary` (OIDC normal; credentials restricted to the break-glass
 * path). Secrets are delivered by mounted files; this loader never reads the
 * client secret itself - only its path.
 */

export const AUTH_MODES = ["local", "dual", "authentik-primary"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type AuthConfig =
  | { mode: "local" }
  | {
      mode: "dual" | "authentik-primary";
      oidc: {
        issuer: string;
        clientId: string;
        clientSecretFile: string;
      };
      roleMap: RoleMap;
    };

/**
 * Deployment profiles (plan section 3.1). Only `no-mail` exists: mail is
 * disabled by design and no SMTP configuration is required or consulted.
 */
export function loadDeploymentProfile(
  env: Record<string, string | undefined> = process.env,
): "no-mail" {
  const raw = env.SUPERSCRIBER_DEPLOYMENT_PROFILE?.trim() || "no-mail";
  if (raw !== "no-mail") {
    throw new AuthConfigError(
      `SUPERSCRIBER_DEPLOYMENT_PROFILE supports only "no-mail"; got "${raw}". Mail is disabled by design.`,
    );
  }
  return "no-mail";
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

const roleMapFileSchema = z
  .object({
    version: z.number().int().positive(),
    issuer: z.string().min(1),
    claim: z.literal("superscriber_role_group_ids"),
    groups: z
      .object({
        uploader: z.string().regex(GROUP_ID_PATTERN, "group id must be a UUID"),
        reviewer: z.string().regex(GROUP_ID_PATTERN, "group id must be a UUID"),
        approver: z.string().regex(GROUP_ID_PATTERN, "group id must be a UUID"),
        admin: z.string().regex(GROUP_ID_PATTERN, "group id must be a UUID"),
      })
      .strict(),
  })
  .strict();

// The role map is read on the request path (landing-page SSR, OIDC
// admission, next-auth callbacks), so it had been re-read from the mounted
// file on every request. A transient read failure of the mount (macOS VM
// file sharing under host contention, or another process atomically
// replacing the config directory) then crashed arbitrary requests into the
// root error boundary. Once a role map has loaded successfully, keep it and
// re-read only when the file's mtime changes; a stat/read/parse failure
// after a good load keeps the last good map instead of failing the request.
// A first-use failure still throws: a config that never loaded is a startup
// error, not a request-time flake.
const roleMapCache = new Map<string, { mtimeMs: number; value: RoleMap }>();

function mtimeMsForRoleMap(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function loadRoleMapFile(path: string): RoleMap {
  const cached = roleMapCache.get(path);
  const mtimeMs = mtimeMsForRoleMap(path);
  if (cached && (mtimeMs === null || mtimeMs === cached.mtimeMs)) {
    return cached.value;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    if (cached) {
      return cached.value;
    }
    throw new AuthConfigError(`Role map file is not readable: ${path}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    if (cached) {
      return cached.value;
    }
    throw new AuthConfigError(`Role map file is not valid JSON: ${path}`);
  }

  try {
    const parsed = roleMapFileSchema.parse(parsedJson);

    const groupIds = Object.values(parsed.groups);
    if (new Set(groupIds).size !== groupIds.length) {
      throw new AuthConfigError(
        `Role map file ${path} must map the four roles to four distinct group UUIDs.`,
      );
    }

    if (mtimeMs !== null) {
      roleMapCache.set(path, { mtimeMs, value: parsed });
    }
    return parsed;
  } catch (error) {
    if (error instanceof AuthConfigError) {
      if (cached) {
        return cached.value;
      }
      throw error;
    }
    if (error instanceof ZodError) {
      if (cached) {
        return cached.value;
      }
      const issues = error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      throw new AuthConfigError(`Role map file ${path} is invalid: ${issues}`);
    }
    throw error;
  }
}

export function loadAuthConfig(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const rawMode = env.SUPERSCRIBER_AUTH_MODE?.trim() || "local";
  if (!(AUTH_MODES as readonly string[]).includes(rawMode)) {
    throw new AuthConfigError(
      `SUPERSCRIBER_AUTH_MODE must be one of ${AUTH_MODES.join(", ")}; got "${rawMode}".`,
    );
  }

  const mode = rawMode as AuthMode;
  if (mode === "local") {
    return { mode };
  }

  const missing: string[] = [];
  const issuer = env.SUPERSCRIBER_OIDC_ISSUER?.trim();
  if (!issuer) {
    missing.push("SUPERSCRIBER_OIDC_ISSUER");
  }
  const clientId = env.SUPERSCRIBER_OIDC_CLIENT_ID?.trim();
  if (!clientId) {
    missing.push("SUPERSCRIBER_OIDC_CLIENT_ID");
  }
  const clientSecretFile = env.SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE?.trim();
  if (!clientSecretFile) {
    missing.push("SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE");
  }
  const roleMapFile = env.SUPERSCRIBER_OIDC_ROLE_MAP_FILE?.trim();
  if (!roleMapFile) {
    missing.push("SUPERSCRIBER_OIDC_ROLE_MAP_FILE");
  }

  if (missing.length > 0) {
    throw new AuthConfigError(
      `SUPERSCRIBER_AUTH_MODE=${mode} requires these settings: ${missing.join(", ")}.`,
    );
  }

  if (!issuer!.endsWith("/")) {
    throw new AuthConfigError(
      "SUPERSCRIBER_OIDC_ISSUER must be the exact canonical issuer ending in '/'.",
    );
  }

  const roleMap = loadRoleMapFile(roleMapFile!);
  if (roleMap.issuer !== issuer) {
    throw new AuthConfigError(
      `Role map issuer must exactly equal SUPERSCRIBER_OIDC_ISSUER; got "${roleMap.issuer}" in ${roleMapFile}.`,
    );
  }

  return {
    mode,
    oidc: {
      issuer: issuer!,
      clientId: clientId!,
      clientSecretFile: clientSecretFile!,
    },
    roleMap,
  };
}
