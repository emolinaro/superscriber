import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getBreakGlassDesignation } from "@/server/auth/break-glass";
import {
  loadAuthConfig,
  loadDeploymentProfile,
  type AuthConfig,
} from "@/server/auth/auth-config";
import { resolveAuthSecret } from "@/server/auth/secret";
import { getAppDb, openAppDatabase } from "@/server/db/client";
import { breakGlassRecoveryCodes, users, webauthnCredentials } from "@/server/db/schema";
import { getOrchestrationConfig } from "@/server/orchestration/config";

export type BootstrapReadinessState = "ready" | "warning" | "blocked";
export type BootstrapReadinessCheckId =
  | "database"
  | "media_storage"
  | "upload_storage"
  | "auth_secret"
  | "engine_configuration"
  | "auth_configuration"
  | "deployment_profile";

export type BootstrapReadinessCheck = {
  id: BootstrapReadinessCheckId;
  label: string;
  state: BootstrapReadinessState;
  detail: string;
};

export type BootstrapReadiness = {
  overall: BootstrapReadinessState;
  checks: BootstrapReadinessCheck[];
};

const VALID_ENGINE_MODES = new Set(["internal", "mock", "webhook"]);
const DEFAULT_MEDIA_DIR = join(/*turbopackIgnore: true*/ process.cwd(), "data", "media");
const DEFAULT_UPLOAD_DIR = join(/*turbopackIgnore: true*/ process.cwd(), "data", "uploads");

function ready(
  id: BootstrapReadinessCheckId,
  label: string,
  detail: string,
): BootstrapReadinessCheck {
  return { id, label, state: "ready", detail };
}

function warning(
  id: BootstrapReadinessCheckId,
  label: string,
  detail: string,
): BootstrapReadinessCheck {
  return { id, label, state: "warning", detail };
}

function blocked(
  id: BootstrapReadinessCheckId,
  label: string,
  detail: string,
): BootstrapReadinessCheck {
  return { id, label, state: "blocked", detail };
}

function resolveMediaDir() {
  return process.env.SUPERSCRIBER_MEDIA_DIR?.trim() || DEFAULT_MEDIA_DIR;
}

function resolveUploadDir() {
  return process.env.SUPERSCRIBER_UPLOAD_TMP_DIR?.trim() || DEFAULT_UPLOAD_DIR;
}

function resolveWorkerEntrypoint() {
  return (
    process.env.SUPERSCRIBER_WORKER_ENTRYPOINT?.trim() ||
    join(/*turbopackIgnore: true*/ process.cwd(), "worker", "main.py")
  );
}

function checkDatabase(): BootstrapReadinessCheck {
  let bundle: ReturnType<typeof openAppDatabase> | null = null;

  try {
    bundle = openAppDatabase();
    bundle.sqlite.exec("BEGIN IMMEDIATE; ROLLBACK;");
    return ready("database", "Database", "Database writes are available for local setup.");
  } catch {
    return blocked(
      "database",
      "Database",
      "Database writes are unavailable. Restore database access before setup.",
    );
  } finally {
    bundle?.sqlite.close();
  }
}

function checkWritableDirectory(
  id: Extract<BootstrapReadinessCheckId, "media_storage" | "upload_storage">,
  label: string,
  directory: string,
): BootstrapReadinessCheck {
  const sentinel = join(directory, `.superscriber-readiness-${crypto.randomUUID()}.sentinel`);

  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(sentinel, "ok", { encoding: "utf8", flag: "wx", mode: 0o600 });
    unlinkSync(sentinel);
    return ready(id, label, `${label} is writable for governed media handling.`);
  } catch {
    return blocked(
      id,
      label,
      `${label} is not writable. Restore storage access before setup.`,
    );
  }
}

function checkAuthSecret(): BootstrapReadinessCheck {
  try {
    const secret = resolveAuthSecret();
    if (!secret) {
      return blocked(
        "auth_secret",
        "Auth secret",
        "Authentication secret generation failed. Restore local auth configuration before setup.",
      );
    }

    return ready(
      "auth_secret",
      "Auth secret",
      "Authentication secret is available for local session protection.",
    );
  } catch {
    return blocked(
      "auth_secret",
      "Auth secret",
      "Authentication secret generation failed. Restore local auth configuration before setup.",
    );
  }
}

function checkEngineConfiguration(): BootstrapReadinessCheck {
  const rawMode = process.env.SUPERSCRIBER_ENGINE_MODE?.trim();
  if (rawMode && !VALID_ENGINE_MODES.has(rawMode)) {
    return blocked(
      "engine_configuration",
      "Engine configuration",
      "Engine mode is not supported. Choose internal, mock, or webhook before setup.",
    );
  }

  const config = getOrchestrationConfig();
  if (config.mode === "webhook" && !config.externalDispatchUrl) {
    return blocked(
      "engine_configuration",
      "Engine configuration",
      "Webhook engine mode needs a dispatch URL before setup can continue.",
    );
  }

  if (config.mode === "webhook" && !config.appBaseUrl) {
    return blocked(
      "engine_configuration",
      "Engine configuration",
      "Webhook engine mode needs an application base URL before setup can continue.",
    );
  }

  if (config.mode === "internal" && !existsSync(resolveWorkerEntrypoint())) {
    return warning(
      "engine_configuration",
      "Engine configuration",
      "Internal worker mode is selected, but the worker is not available yet. Setup can continue, but transcription jobs will wait.",
    );
  }

  return ready(
    "engine_configuration",
    "Engine configuration",
    config.mode === "mock"
      ? "Mock engine mode is configured for local setup."
      : config.mode === "webhook"
        ? "Webhook engine mode is configured for governed dispatch."
        : "Internal worker mode is configured for local processing.",
  );
}

function checkDeploymentProfile(): BootstrapReadinessCheck {
  try {
    loadDeploymentProfile();
    return ready(
      "deployment_profile",
      "Deployment profile",
      "No-mail deployment: no SMTP configuration is required or used.",
    );
  } catch (error) {
    return blocked(
      "deployment_profile",
      "Deployment profile",
      error instanceof Error ? error.message : "Deployment profile is not supported.",
    );
  }
}

function checkAuthConfiguration(): BootstrapReadinessCheck {
  let config: AuthConfig;
  try {
    config = loadAuthConfig();
  } catch (error) {
    return blocked(
      "auth_configuration",
      "Authentication",
      error instanceof Error ? error.message : "Authentication configuration failed.",
    );
  }

  if (config.mode === "local") {
    return ready(
      "auth_configuration",
      "Authentication",
      "Local credentials are the only sign-in method.",
    );
  }

  if (config.mode === "dual") {
    return ready(
      "auth_configuration",
      "Authentication",
      "Dual mode: local credentials and linked Authentik sign-in are available.",
    );
  }

  // authentik-primary startup invariant (plan section 8.1).
  const db = getAppDb();
  const designation = getBreakGlassDesignation(db);
  if (!designation) {
    return blocked(
      "auth_configuration",
      "Authentication",
      "Authentik-primary requires exactly one designated break-glass administrator before startup.",
    );
  }

  const designee = db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, designation.breakGlassUserId))
    .get();
  if (!designee || designee.role !== "admin" || !designee.isActive) {
    return blocked(
      "auth_configuration",
      "Authentication",
      "Authentik-primary requires the designated break-glass account to be an active administrator.",
    );
  }

  const keyCount = db
    .select({ count: sql<number>`count(*)` })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, designation.breakGlassUserId))
    .get()!.count;
  if (keyCount < 2) {
    return blocked(
      "auth_configuration",
      "Authentication",
      "Authentik-primary requires two enrolled break-glass security keys before startup.",
    );
  }

  const custodyCount = db
    .select({ count: sql<number>`count(*)` })
    .from(breakGlassRecoveryCodes)
    .where(
      and(
        eq(breakGlassRecoveryCodes.breakGlassUserId, designation.breakGlassUserId),
        isNull(breakGlassRecoveryCodes.usedAt),
        isNull(breakGlassRecoveryCodes.rotatedAt),
      ),
    )
    .get()!.count;
  if (custodyCount === 0) {
    return blocked(
      "auth_configuration",
      "Authentication",
      "Authentik-primary requires recorded break-glass recovery custody before startup.",
    );
  }

  return ready(
    "auth_configuration",
    "Authentication",
    "Authentik-primary: institutional sign-in is normal; the break-glass boundary is ready.",
  );
}

export async function getBootstrapReadiness(): Promise<BootstrapReadiness> {
  const checks = [
    checkDatabase(),
    checkWritableDirectory("media_storage", "Media storage", resolveMediaDir()),
    checkWritableDirectory("upload_storage", "Upload storage", resolveUploadDir()),
    checkAuthSecret(),
    checkEngineConfiguration(),
    checkAuthConfiguration(),
    checkDeploymentProfile(),
  ];

  return {
    overall: checks.some((check) => check.state === "blocked")
      ? "blocked"
      : checks.some((check) => check.state === "warning")
        ? "warning"
        : "ready",
    checks,
  };
}
