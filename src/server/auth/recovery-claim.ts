import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  getAppDbBundle,
  resolveDatabaseDir,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { users } from "@/server/db/schema";
import { createSlidingWindowLimiter } from "@/server/auth/password-reset-rate-limit";
import { localUserSchema, normalizeEmail } from "@/server/auth/validation";
import { hash } from "bcryptjs";

/**
 * Operator-gated administrator recovery (captain ruling, admin-bootstrap
 * recovery): when accounts survive but no active administrator remains, the
 * sign-up door offers a claim ceremony for a fresh admin account.
 *
 * Anti-claim protection: a public "become admin" form would hand the
 * instance to whoever reaches it first. The claim therefore requires a proof
 * only a host operator can present - a single-use token file written next to
 * the database with owner-only permissions. Reading it implies the same host
 * access that could edit the SQLite database directly, so protecting the
 * claim with anything weaker would be theatre; requiring it keeps a network
 * attacker from racing the operator to the crown. Claim attempts are
 * additionally rate-limited and audited, and the proof is consumed on use so
 * a leaked stale token cannot mint a second admin.
 *
 * Deliberate trade-off (surfaced in docs/operators/admin-recovery.md): the
 * claim proof requires host file access. Environments that cannot grant the
 * recovery operator shell access should not run unmanageable for long; the
 * alternative - public claim - is an instance takeover vector and stays
 * disabled.
 */

export const ADMIN_CLAIM_TOKEN_FILENAME = "admin-claim.token";

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export type RecoveryClaimFailureCode =
  | "requires_existing_users"
  | "admin_exists"
  | "claim_token_invalid"
  | "email_taken";

export class RecoveryClaimError extends Error {
  constructor(
    readonly code: RecoveryClaimFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "RecoveryClaimError";
  }
}

/**
 * Claim-attempt brute-force budget: 5 attempts per 15 minutes per client
 * (shared bucket when the client address is unverifiable). In-memory like
 * the other auth limiters; a 128-bit token makes even an unbounded budget
 * hopeless, this simply blunts hammering noise and alerts via audit volume.
 */
export const recoveryClaimLimiter = createSlidingWindowLimiter({
  limit: 5,
  windowMs: 15 * 60 * 1000,
});

export function resolveAdminClaimTokenPath() {
  return join(resolveDatabaseDir(), ADMIN_CLAIM_TOKEN_FILENAME);
}

function generateToken() {
  return randomBytes(16).toString("hex");
}

export function readAdminClaimToken(path = resolveAdminClaimTokenPath()): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  return TOKEN_PATTERN.test(raw) ? raw : null;
}

/**
 * Returns the current claim proof, creating it (0600, create-exclusive) when
 * missing or externally corrupted. Concurrent renderers race on the
 * exclusive create and converge on the winner's token.
 */
export function ensureAdminClaimToken(path = resolveAdminClaimTokenPath()): {
  path: string;
  token: string;
} {
  const existing = readAdminClaimToken(path);
  if (existing) {
    return { path, token: existing };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generateToken();
    try {
      writeFileSync(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const winner = readAdminClaimToken(path);
      if (winner) {
        // A concurrent renderer won the exclusive create; converge on it.
        return { path, token: winner };
      }
      // Whatever sits there is not a usable proof (corrupted or truncated
      // by something outside this flow): replace it rather than presenting
      // the operator a token the claim verifier will never accept.
      rmSync(path, { force: true });
      continue;
    }
    // Tighten permissions even under a permissive umask; the mode flag of
    // the exclusive create is subject to umask on some platforms.
    chmodSync(path, 0o600);
    return { path, token };
  }

  throw new Error(
    `The administrator claim token at ${path} could not be established. Check data-directory writability.`,
  );
}

function normalizeClaimInput(value: string) {
  return value.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
}

function tokenDigest(token: string) {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Constant-time comparison against the on-disk proof. Never creates the
 * token: a claim attempt against an uncreated proof simply fails.
 */
export function verifyAdminClaimToken(
  input: string,
  path = resolveAdminClaimTokenPath(),
): boolean {
  const stored = readAdminClaimToken(path);
  const normalized = normalizeClaimInput(input);
  if (!stored || !TOKEN_PATTERN.test(normalized)) {
    return false;
  }
  return timingSafeEqual(tokenDigest(stored), tokenDigest(normalized));
}

/** Consumes the proof after a successful claim. Missing file is a no-op. */
export function consumeAdminClaimToken(path = resolveAdminClaimTokenPath()) {
  rmSync(path, { force: true });
}

/**
 * Creates the recovery administrator inside one transaction that re-checks
 * every gate (existing accounts, still no active admin, valid proof, free
 * email), then consumes the proof. The transaction re-checks make concurrent
 * claims race-safe: the loser sees `admin_exists` / a consumed token.
 */
export async function createRecoveryAdmin(
  input: {
    displayName: string;
    email: string;
    password: string;
    claimToken: string;
  },
  bundle: AppDatabaseBundle = getAppDbBundle(),
) {
  const parsed = localUserSchema
    .pick({ displayName: true, email: true, password: true })
    .parse({ ...input, email: normalizeEmail(input.email) });
  const passwordHash = await hash(parsed.password, 12);

  const created = bundle.sqlite.transaction(() => {
    const anyUser = bundle.db.select({ id: users.id }).from(users).limit(1).get();
    if (!anyUser) {
      throw new RecoveryClaimError(
        "requires_existing_users",
        "The appliance has no accounts yet. Use first-run setup to create the first administrator.",
      );
    }

    const activeAdmin = bundle.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.isActive, true)))
      .limit(1)
      .get();
    if (activeAdmin) {
      throw new RecoveryClaimError(
        "admin_exists",
        "An active administrator already exists. Sign in with an existing account.",
      );
    }

    if (!verifyAdminClaimToken(input.claimToken)) {
      throw new RecoveryClaimError(
        "claim_token_invalid",
        "The administrator claim was not accepted.",
      );
    }

    const existingEmail = bundle.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, parsed.email))
      .get();
    if (existingEmail) {
      throw new RecoveryClaimError(
        "email_taken",
        "An account with that email already exists.",
      );
    }

    const timestamp = new Date().toISOString();
    const id = crypto.randomUUID();
    bundle.db
      .insert(users)
      .values({
        id,
        email: parsed.email,
        displayName: parsed.displayName,
        passwordHash,
        role: "admin",
        isActive: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return id;
  })();

  // Only a committed claim consumes the proof: operator typos (bad token,
  // taken email) must not burn it, while a successful claim leaves no stale
  // crown-minting material on disk.
  consumeAdminClaimToken();

  const row = bundle.db.select().from(users).where(eq(users.id, created)).get();
  if (!row) {
    throw new Error("The recovery administrator was created but could not be reloaded.");
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
