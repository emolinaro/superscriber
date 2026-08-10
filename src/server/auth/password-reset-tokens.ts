import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import { authControl, passwordResetTokens, users } from "@/server/db/schema";

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

type TokenRow = typeof passwordResetTokens.$inferSelect;

export type SelfServiceEligibility =
  | { eligible: true; userId: string; email: string }
  | { eligible: false; reason: "unknown_or_ineligible" | "break_glass_designee" };

export type RedeemableTokenResult =
  | { ok: true; token: TokenRow }
  | { ok: false; reason: "unknown_token" | "expired" | "used" | "invalidated" };

function hashToken(rawToken: string) {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function checkSelfServiceEligibility(
  email: string,
  db: AppDatabase = getAppDb(),
): SelfServiceEligibility {
  const row = db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.email, email))
    .get();

  if (!row || !row.isActive || !row.passwordHash || row.passwordHash.startsWith("disabled:")) {
    return { eligible: false, reason: "unknown_or_ineligible" };
  }
  const designation = db
    .select({ userId: authControl.breakGlassUserId })
    .from(authControl)
    .where(eq(authControl.id, 1))
    .get();
  if (designation?.userId === row.id) {
    return { eligible: false, reason: "break_glass_designee" };
  }
  return { eligible: true, userId: row.id, email: row.email };
}

/** Issuing invalidates every outstanding token for the user: newest wins. */
export function issueResetToken(
  params: {
    userId: string;
    source: "self_service" | "admin";
    delivery: "email" | "operator_handoff";
    requestedByUserId?: string | null;
    supersedeReason?: "superseded" | "admin_precedence";
  },
  db: AppDatabase = getAppDb(),
  now: Date = new Date(),
): { tokenId: string; rawToken: string; expiresAt: string } {
  const nowIso = now.toISOString();
  invalidateUserResetTokens(
    { userId: params.userId, reason: params.supersedeReason ?? "superseded" },
    db,
    nowIso,
  );

  const rawToken = randomBytes(32).toString("base64url");
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS).toISOString();
  db.insert(passwordResetTokens)
    .values({
      id: tokenId,
      userId: params.userId,
      tokenHash: hashToken(rawToken),
      source: params.source,
      delivery: params.delivery,
      requestedByUserId: params.requestedByUserId ?? null,
      createdAt: nowIso,
      expiresAt,
    })
    .run();
  return { tokenId, rawToken, expiresAt };
}

export function loadRedeemableToken(
  rawToken: string,
  db: AppDatabase = getAppDb(),
  now: Date = new Date(),
): RedeemableTokenResult {
  const row = db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, hashToken(rawToken)))
    .get();
  if (!row) return { ok: false, reason: "unknown_token" };
  if (row.usedAt) return { ok: false, reason: "used" };
  if (row.invalidatedAt) return { ok: false, reason: "invalidated" };
  if (Date.parse(row.expiresAt) <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, token: row };
}

export function markResetTokenUsed(tokenId: string, db: AppDatabase, nowIso: string) {
  db.update(passwordResetTokens)
    .set({ usedAt: nowIso })
    .where(eq(passwordResetTokens.id, tokenId))
    .run();
}

export function invalidateUserResetTokens(
  params: { userId: string; reason: "superseded" | "admin_precedence" | "user_reset_completed" },
  db: AppDatabase,
  nowIso: string,
) {
  db.update(passwordResetTokens)
    .set({ invalidatedAt: nowIso, invalidatedReason: params.reason })
    .where(
      and(
        eq(passwordResetTokens.userId, params.userId),
        isNull(passwordResetTokens.usedAt),
        isNull(passwordResetTokens.invalidatedAt),
      ),
    )
    .run();
}
