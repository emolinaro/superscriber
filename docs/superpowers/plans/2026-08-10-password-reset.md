# Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the captain-approved spec `docs/superpowers/specs/2026-08-09-password-reset-design.md` (commit 158922a): self-service email password reset for local accounts and administrator manual reset with precedence, including the default-off opt-in reset-mail seam.

**Architecture:** New `password_reset_tokens` table (schema v9) holding SHA-256-hashed single-use 60-minute tokens. Self-service request/completion services in `src/server/auth/` reuse `retireUserSessions` for cross-source session revocation. Admin issuance is a governed transaction in `src/server/administration/` following the account-role-service pattern (f7816ef). Mail is sent only by a narrow `reset-mailer` module gated by `SUPERSCRIBER_RESET_MAIL_MODE`.

**Tech Stack:** Next.js 16 (server actions), Drizzle ORM + better-sqlite3, bcryptjs, nodemailer (transports), zod, Vitest, Playwright (container appliance suite).

## Global Constraints

Every task implicitly includes these spec invariants (exact values):

- Token: 32 bytes `crypto.randomBytes`, base64url; only SHA-256 hex digest stored; TTL `60 * 60 * 1000` ms; single-use; issuance invalidates prior tokens; request alone never touches sessions or the password hash.
- Completion transaction: mark used -> bcrypt(12) hash write -> `retireUserSessions({ userId, reason: "password_reset" })` -> invalidate leftovers `user_reset_completed`. Never auto-sign-in.
- Admin issuance transaction: invalidate prior tokens `admin_precedence` -> `retireUserSessions({ userId, reason: "admin_password_reset" })` -> issue token -> governance audit event `account.password_reset` -> security event `admin.password_reset.issued`. Exactly one disclosure channel (one-time reveal OR email).
- Denials: inactive / break-glass designee / `disabled:` credential targets are denied in the admin flow; self-service treats unknown, inactive, `NULL` hash, and `disabled:` hash identically (dummy bcrypt compare, identical response copy).
- New env surface (exact names): `SUPERSCRIBER_RESET_MAIL_MODE` (unset | `none` | `smtp`), `SUPERSCRIBER_RESET_MAIL_SMTP_HOST`, `SUPERSCRIBER_RESET_MAIL_SMTP_PORT`, `SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS`, `SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE`, `SUPERSCRIBER_RESET_MAIL_USERNAME` (optional), `SUPERSCRIBER_RESET_MAIL_BASE_URL` (optional). Deployment profile stays `no-mail`.
- Security events (exact type strings): `password.reset.requested`, `password.reset.mail_failed`, `password.reset.completed`, `password.reset.redeem_denied`, `admin.password_reset.issued`. Never log raw tokens or email addresses. NOTE: `recordSecurityEvent`'s sanitizer drops metadata keys matching `/token/i` and any string containing `@`; reference token rows via metadata key `resetRecordId` (a UUID, not a secret).
- Rate limits: request 10/IP/15 min, 3/email/hour; redeem 10/IP/15 min; in-memory limiters following the `webauthn.ts` precedent.
- Anti-enumeration response copy (exact): "If an account matches that email, a password reset has been started. If nothing arrives, contact your administrator."
- Redeem failure copy (exact): "That reset link is no longer valid. Ask your administrator for a new one or request another reset."
- Reason validation: 10-500 characters, mirroring `validateGovernedReason`.
- Phone safety: admin reset controls are omitted entirely in phone safety mode; self-service pages stay fully usable on phones.
- The `authentik-primary` credential suppression guard in `src/server/auth/options.ts` is never weakened; reset completion never mints a session.
- Password policy for new passwords: 10-200 characters (same as `localUserSchema`).
- Validation gate per task: `npx vitest run <changed tests>` then `npm run typecheck`. Final gate (Task 15): `npm run typecheck`, `npm test`, `npm run build`, `npm run worker:check`, `npm run e2e:container`.

---

## Task Index

1. Schema v9: `password_reset_tokens` table + migration + drizzle model
2. Reset-mail configuration loader + readiness check
3. Reset mailer module (nodemailer transport)
4. In-memory sliding-window rate limiter
5. Reset token store (eligibility, issue, redeem, invalidate)
6. Shared reset copy/schemas + self-service request service
7. Self-service request page, server action, sign-in surface link
8. Password completion service (atomic transaction)
9. Completion page, form, server action
10. Shared admin actor-authority helper (extract from account-role-service)
11. Admin reset service + `account.password_reset` audit type
12. Admin server action, view model flag, and Accounts UI
13. Operator documentation updates
14. E2E: fake-SMTP sidecar, appliance wiring, reset specs
15. Final validation gate

---

### Task 1: Schema v9 - password_reset_tokens

**Files:**
- Modify: `src/server/db/schema.ts` (append after `breakGlassRecoveryCodes`)
- Modify: `src/server/db/migrations.ts` (bump `LATEST_SCHEMA_VERSION` to 9, append migration)
- Test: `src/server/db/migrations.test.ts`

**Interfaces:**
- Produces: `passwordResetTokens` drizzle table; `PASSWORD_RESET_TOKEN_SOURCES = ["self_service", "admin"]`; `PASSWORD_RESET_TOKEN_DELIVERIES = ["email", "operator_handoff"]`.

- [ ] **Step 1: Write the failing test**

Append to `src/server/db/migrations.test.ts`:

```ts
it("upgrades v8 with the password_reset_tokens table", () => {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, 8);
  runMigrations(sqlite, 9);

  const columns = sqlite
    .prepare(`PRAGMA table_info(password_reset_tokens)`)
    .all() as Array<{ name: string }>;
  expect(columns.map((c) => c.name)).toEqual([
    "id", "user_id", "token_hash", "source", "delivery",
    "requested_by_user_id", "created_at", "expires_at",
    "used_at", "invalidated_at", "invalidated_reason",
  ]);
  const indexes = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'password_reset_tokens'`)
    .all() as Array<{ name: string }>;
  expect(indexes.map((i) => i.name).sort()).toEqual([
    "password_reset_tokens_hash_unique",
    "password_reset_tokens_user_idx",
  ]);
  sqlite.close();
});
```

(Match the exact harness style of the surrounding migration tests; adjust imports if the file uses a helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/db/migrations.test.ts`
Expected: FAIL (table does not exist).

- [ ] **Step 3: Add the migration and schema model**

In `src/server/db/migrations.ts`: set `LATEST_SCHEMA_VERSION = 9` and append to the `migrations` array:

```ts
{ version: 9, name: "password-reset-tokens", up: addPasswordResetTokensSchema },
```

Add the migration function near `addAccountRoleGuards`:

```ts
function addPasswordResetTokensSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('self_service', 'admin')),
      delivery TEXT NOT NULL CHECK (delivery IN ('email', 'operator_handoff')),
      requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      invalidated_at TEXT,
      invalidated_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_unique
      ON password_reset_tokens (token_hash);
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
      ON password_reset_tokens (user_id);
  `);
}
```

In `src/server/db/schema.ts`, after `breakGlassRecoveryCodes`:

```ts
export const PASSWORD_RESET_TOKEN_SOURCES = ["self_service", "admin"] as const;
export type PasswordResetTokenSource = (typeof PASSWORD_RESET_TOKEN_SOURCES)[number];

export const PASSWORD_RESET_TOKEN_DELIVERIES = ["email", "operator_handoff"] as const;
export type PasswordResetTokenDelivery = (typeof PASSWORD_RESET_TOKEN_DELIVERIES)[number];

export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    source: text("source", { enum: PASSWORD_RESET_TOKEN_SOURCES })
      .$type<PasswordResetTokenSource>()
      .notNull(),
    delivery: text("delivery", { enum: PASSWORD_RESET_TOKEN_DELIVERIES })
      .$type<PasswordResetTokenDelivery>()
      .notNull(),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    invalidatedAt: text("invalidated_at"),
    invalidatedReason: text("invalidated_reason"),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("password_reset_tokens_hash_unique").on(table.tokenHash),
    userIdx: index("password_reset_tokens_user_idx").on(table.userId),
  }),
);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/server/db/migrations.test.ts src/server/db/upgrade-rehearsal.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/schema.ts src/server/db/migrations.ts src/server/db/migrations.test.ts
git commit -m "feat(db): add password_reset_tokens table (schema v9)"
```

### Task 2: Reset-mail configuration loader + readiness check

**Files:**
- Create: `src/server/auth/reset-mail-config.ts`
- Modify: `src/server/bootstrap/readiness.ts` (new `reset_mail` check)
- Test: `src/server/auth/reset-mail-config.test.ts`
- Test: `src/server/bootstrap/readiness.test.ts`

**Interfaces:**
- Produces: `type ResetMailConfig = { mode: "none" } | { mode: "smtp"; host: string; port: number; fromAddress: string; username: string | null; passwordFile: string; baseUrl: string | null }`; `loadResetMailConfig(env = process.env): ResetMailConfig` (throws `AuthConfigError` on malformed config). Task 3 consumes the `smtp` variant; Task 12/14 consume `loadResetMailConfig().mode`.

- [ ] **Step 1: Write the failing test**

Create `src/server/auth/reset-mail-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadResetMailConfig } from "@/server/auth/reset-mail-config";

const SMTP_ENV = {
  SUPERSCRIBER_RESET_MAIL_MODE: "smtp",
  SUPERSCRIBER_RESET_MAIL_SMTP_HOST: "mail.example.test",
  SUPERSCRIBER_RESET_MAIL_SMTP_PORT: "587",
  SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS: "reset@example.test",
  SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE: "/run/secrets/reset-mail-password",
};

describe("loadResetMailConfig", () => {
  it("defaults to none when the mode is unset or none", () => {
    expect(loadResetMailConfig({})).toEqual({ mode: "none" });
    expect(loadResetMailConfig({ SUPERSCRIBER_RESET_MAIL_MODE: "none" })).toEqual({ mode: "none" });
  });

  it("loads a complete smtp configuration", () => {
    expect(loadResetMailConfig(SMTP_ENV)).toEqual({
      mode: "smtp",
      host: "mail.example.test",
      port: 587,
      fromAddress: "reset@example.test",
      username: null,
      passwordFile: "/run/secrets/reset-mail-password",
      baseUrl: null,
    });
  });

  it("rejects unknown modes and malformed smtp configurations", () => {
    expect(() =>
      loadResetMailConfig({ SUPERSCRIBER_RESET_MAIL_MODE: "sendgrid" }),
    ).toThrow(/supports only/);
    expect(() =>
      loadResetMailConfig({ ...SMTP_ENV, SUPERSCRIBER_RESET_MAIL_SMTP_PORT: "not-a-port" }),
    ).toThrow(/SMTP_PORT/);
    const missingHost = { ...SMTP_ENV } as Record<string, string | undefined>;
    delete missingHost.SUPERSCRIBER_RESET_MAIL_SMTP_HOST;
    expect(() => loadResetMailConfig(missingHost)).toThrow(/requires/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/auth/reset-mail-config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the loader**

Create `src/server/auth/reset-mail-config.ts`:

```ts
import { AuthConfigError } from "@/server/auth/auth-config";

/**
 * Scoped reset-mail seam (spec section 3). Absent by default; when `smtp`,
 * delivers exactly one transactional template (password reset link). No other
 * code path receives a mailer handle. Secrets arrive as mounted file paths;
 * this loader never reads secret contents.
 */
export type ResetMailConfig =
  | { mode: "none" }
  | {
      mode: "smtp";
      host: string;
      port: number;
      fromAddress: string;
      username: string | null;
      passwordFile: string;
      baseUrl: string | null;
    };

export function loadResetMailConfig(
  env: Record<string, string | undefined> = process.env,
): ResetMailConfig {
  const raw = env.SUPERSCRIBER_RESET_MAIL_MODE?.trim();
  if (!raw || raw === "none") {
    return { mode: "none" };
  }
  if (raw !== "smtp") {
    throw new AuthConfigError(
      `SUPERSCRIBER_RESET_MAIL_MODE supports only unset, "none", or "smtp"; got "${raw}".`,
    );
  }

  const host = env.SUPERSCRIBER_RESET_MAIL_SMTP_HOST?.trim();
  const portRaw = env.SUPERSCRIBER_RESET_MAIL_SMTP_PORT?.trim();
  const fromAddress = env.SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS?.trim();
  const passwordFile = env.SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE?.trim();
  if (!host || !portRaw || !fromAddress || !passwordFile) {
    throw new AuthConfigError(
      "SUPERSCRIBER_RESET_MAIL_MODE=smtp requires SUPERSCRIBER_RESET_MAIL_SMTP_HOST, " +
        "SUPERSCRIBER_RESET_MAIL_SMTP_PORT, SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS, " +
        "and SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE.",
    );
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AuthConfigError(
      `SUPERSCRIBER_RESET_MAIL_SMTP_PORT must be an integer 1-65535; got "${portRaw}".`,
    );
  }
  return {
    mode: "smtp",
    host,
    port,
    fromAddress,
    username: env.SUPERSCRIBER_RESET_MAIL_USERNAME?.trim() || null,
    passwordFile,
    baseUrl: env.SUPERSCRIBER_RESET_MAIL_BASE_URL?.trim() || null,
  };
}
```

- [ ] **Step 4: Wire the readiness check**

In `src/server/bootstrap/readiness.ts`:
- Add `"reset_mail"` to the `BootstrapReadinessCheckId` union.
- Add to the check list (next to `checkDeploymentProfile`):

```ts
function checkResetMail(): BootstrapReadinessCheck {
  try {
    const config = loadResetMailConfig();
    return ready(
      "reset_mail",
      "Reset mail",
      config.mode === "smtp"
        ? "Reset mail configured (smtp): reset links are emailed for self-service resets."
        : "Reset mail not configured: resets run operator-assisted via an administrator.",
    );
  } catch (error) {
    return blocked(
      "reset_mail",
      "Reset mail",
      error instanceof Error ? error.message : "Reset mail configuration failed.",
    );
  }
}
```

Add `checkResetMail()` to the checks array. Update `src/server/bootstrap/readiness.test.ts`: extend the expected check-id list with `"reset_mail"` and add a case asserting the blocked state when `SUPERSCRIBER_RESET_MAIL_MODE=smtp` is set without the companion vars (use `vi.stubEnv`/`vi.unstubAllEnvs` as the surrounding tests do).

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run src/server/auth/reset-mail-config.test.ts src/server/bootstrap/readiness.test.ts && npm run typecheck`
Then:

```bash
git add src/server/auth/reset-mail-config.ts src/server/auth/reset-mail-config.test.ts src/server/bootstrap/readiness.ts src/server/bootstrap/readiness.test.ts
git commit -m "feat(auth): add opt-in reset-mail configuration and readiness check"
```

### Task 3: Reset mailer module

**Files:**
- Modify: `package.json` (add `nodemailer` dependency, `@types/nodemailer` devDependency)
- Create: `src/server/auth/reset-mailer.ts`
- Test: `src/server/auth/reset-mailer.test.ts`

**Interfaces:**
- Consumes: `ResetMailConfig` smtp variant from Task 2.
- Produces: `buildResetMailMessage({ resetUrl, expiresAtIso }): { subject: string; text: string }`; `sendPasswordResetEmail(config, { to, resetUrl, expiresAtIso }): Promise<void>`. Consumed by Tasks 6 and 12.

- [ ] **Step 1: Install the dependency**

```bash
npm install nodemailer@^7
npm install -D @types/nodemailer
```

- [ ] **Step 2: Write the failing test**

Create `src/server/auth/reset-mailer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({ sendMail: vi.fn(async () => ({})) })),
}));

import { createTransport } from "nodemailer";
import { buildResetMailMessage, sendPasswordResetEmail } from "@/server/auth/reset-mailer";

const CONFIG = {
  mode: "smtp" as const,
  host: "mail.example.test",
  port: 587,
  fromAddress: "reset@example.test",
  username: "mailer",
  passwordFile: "/tmp/reset-mail-password-test",
};

describe("reset mailer", () => {
  it("builds the single transactional template with link and expiry only", () => {
    const message = buildResetMailMessage({
      resetUrl: "https://app.example/reset/abc",
      expiresAtIso: "2026-08-10T13:00:00.000Z",
    });
    expect(message.subject).toBe("Superscriber password reset");
    expect(message.text).toContain("https://app.example/reset/abc");
    expect(message.text).toContain("2026-08-10T13:00:00.000Z");
    expect(message.text).toContain("contact your administrator");
  });

  it("sends through smtp with starttls-style transport for submission ports", async () => {
    const sendMail = vi.fn(async () => ({}));
    vi.mocked(createTransport).mockReturnValueOnce({ sendMail } as never);

    await sendPasswordResetEmail(CONFIG, {
      to: "user@example.test",
      resetUrl: "https://app.example/reset/abc",
      expiresAtIso: "2026-08-10T13:00:00.000Z",
    });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "mail.example.test", port: 587, secure: false }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "reset@example.test", to: "user@example.test" }),
    );
  });
});
```

Note: the test's `passwordFile` must exist for the send path; creating it in test setup (`writeFileSync(CONFIG.passwordFile, "pw\n")` in a `beforeAll`) is the implementer's detail.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/server/auth/reset-mailer.test.ts` -> FAIL (module not found).

- [ ] **Step 4: Implement**

Create `src/server/auth/reset-mailer.ts`:

```ts
import { readFileSync } from "node:fs";
import { createTransport } from "nodemailer";
import type { ResetMailConfig } from "@/server/auth/reset-mail-config";

export type SmtpResetMailConfig = Extract<ResetMailConfig, { mode: "smtp" }>;

/**
 * The only transactional template this deployment can send (spec section 3):
 * the reset URL, absolute expiry, and a pointer to the administrator.
 */
export function buildResetMailMessage(params: { resetUrl: string; expiresAtIso: string }) {
  return {
    subject: "Superscriber password reset",
    text: [
      "A password reset was started for your Superscriber account.",
      "",
      `This single-use link expires at ${params.expiresAtIso}:`,
      params.resetUrl,
      "",
      "If you did not request this, or the link no longer works, contact your administrator.",
    ].join("\n"),
  };
}

export async function sendPasswordResetEmail(
  config: SmtpResetMailConfig,
  params: { to: string; resetUrl: string; expiresAtIso: string },
): Promise<void> {
  const password = readFileSync(config.passwordFile, "utf8").trim();
  const message = buildResetMailMessage(params);
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.username ?? config.fromAddress, pass: password },
  });
  await transporter.sendMail({
    from: config.fromAddress,
    to: params.to,
    subject: message.subject,
    text: message.text,
  });
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run src/server/auth/reset-mailer.test.ts && npm run typecheck`
Then:

```bash
git add package.json package-lock.json src/server/auth/reset-mailer.ts src/server/auth/reset-mailer.test.ts
git commit -m "feat(auth): add scoped reset mailer (nodemailer smtp)"
```

### Task 4: Sliding-window rate limiter

**Files:**
- Create: `src/server/auth/password-reset-rate-limit.ts`
- Test: `src/server/auth/password-reset-rate-limit.test.ts`

**Interfaces:**
- Produces: `createSlidingWindowLimiter({ limit, windowMs, now? }): SlidingWindowLimiter` with `check(key): { allowed: boolean; retryAfterSeconds: number }` and `reset(): void`; plus the three module-level instances `resetRequestByIpLimiter` (10/15 min), `resetRequestByEmailLimiter` (3/hour), `resetRedeemByIpLimiter` (10/15 min). Consumed by Tasks 6 and 8.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter } from "@/server/auth/password-reset-rate-limit";

describe("createSlidingWindowLimiter", () => {
  it("allows up to the limit inside the window, then denies with retry hint", () => {
    let t = 1_000_000;
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1_000, now: () => t });
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    const denied = limiter.check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    t += 1_001;
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("tracks keys independently and reset() clears state", () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check("a");
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    limiter.reset();
    expect(limiter.check("a").allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** -> module not found.

- [ ] **Step 3: Implement**

```ts
export type SlidingWindowLimiter = {
  check(key: string): { allowed: boolean; retryAfterSeconds: number };
  reset(): void;
};

/**
 * In-memory sliding windows (single-process SQLite deployment), following the
 * webauthn.ts emergency-attempts precedent. Reset on restart errs toward
 * availability.
 */
export function createSlidingWindowLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): SlidingWindowLimiter {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const current = now();
      const windowStart = current - options.windowMs;
      const list = (hits.get(key) ?? []).filter((t) => t > windowStart);
      if (list.length >= options.limit) {
        hits.set(key, list);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((list[0]! + options.windowMs - current) / 1000),
          ),
        };
      }
      list.push(current);
      hits.set(key, list);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}

/** Per-IP request budget: 10 per 15 minutes (spec section 6). */
export const resetRequestByIpLimiter = createSlidingWindowLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
});

/** Per-email issuance budget: 3 tokens per hour (spec section 6). */
export const resetRequestByEmailLimiter = createSlidingWindowLimiter({
  limit: 3,
  windowMs: 60 * 60 * 1000,
});

/** Per-IP redemption failure budget: 10 per 15 minutes (spec section 6). */
export const resetRedeemByIpLimiter = createSlidingWindowLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
});
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx vitest run src/server/auth/password-reset-rate-limit.test.ts && npm run typecheck
git add src/server/auth/password-reset-rate-limit.ts src/server/auth/password-reset-rate-limit.test.ts
git commit -m "feat(auth): add sliding-window rate limiter for reset flows"
```

### Task 5: Reset token store

**Files:**
- Create: `src/server/auth/password-reset-tokens.ts`
- Test: `src/server/auth/password-reset-tokens.test.ts`

**Interfaces:**
- Consumes: `passwordResetTokens` (Task 1).
- Produces:
  - `RESET_TOKEN_TTL_MS` (60 * 60 * 1000)
  - `checkSelfServiceEligibility(email, db?): SelfServiceEligibility` where `SelfServiceEligibility = { eligible: true; userId: string; email: string } | { eligible: false; reason: "unknown_or_ineligible" | "break_glass_designee" }`
  - `issueResetToken({ userId, source, delivery, requestedByUserId?, supersedeReason? }, db?, now?): { tokenId: string; rawToken: string; expiresAt: string }`
  - `loadRedeemableToken(rawToken, db?, now?): { ok: true; token: typeof passwordResetTokens.$inferSelect } | { ok: false; reason: "unknown_token" | "expired" | "used" | "invalidated" }`
  - `markResetTokenUsed(tokenId, db, nowIso): void`
  - `invalidateUserResetTokens({ userId, reason }, db, nowIso): void` with `reason: "superseded" | "admin_precedence" | "user_reset_completed"`

- [ ] **Step 1: Write the failing test**

Create `src/server/auth/password-reset-tokens.test.ts` (harness mirrors `session-registry.test.ts`: `openAppDatabase(":memory:")` + `INSERT INTO users` seeding; set `password_hash` to `'hash'` for usable, `NULL`, or `'disabled:xyz'` variants):

```ts
import { describe, expect, it } from "vitest";
import {
  RESET_TOKEN_TTL_MS,
  checkSelfServiceEligibility,
  invalidateUserResetTokens,
  issueResetToken,
  loadRedeemableToken,
  markResetTokenUsed,
} from "@/server/auth/password-reset-tokens";
import { openAppDatabase } from "@/server/db/client";

const T0 = new Date("2026-08-10T12:00:00.000Z");

function seedUser(sqlite: import("better-sqlite3").Database, id: string, passwordHash: string | null = "hash") {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'reviewer', 1, ?, ?)`,
    )
    .run(id, `${id}@example.com`, id, passwordHash, T0.toISOString(), T0.toISOString());
}

describe("password reset token store", () => {
  it("issues hashed single-use tokens; raw token is never persisted", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");

    const issued = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
      T0,
    );
    expect(issued.rawToken).not.toContain("=");
    expect(issued.expiresAt).toBe(new Date(T0.getTime() + RESET_TOKEN_TTL_MS).toISOString());

    const row = bundle.sqlite
      .prepare(`SELECT token_hash FROM password_reset_tokens WHERE id = ?`)
      .get(issued.tokenId) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(issued.rawToken);
  });

  it("new issuance supersedes outstanding tokens; latest wins", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    const first = issueResetToken({ userId: "user-1", source: "self_service", delivery: "email" }, bundle.db, T0);
    const second = issueResetToken({ userId: "user-1", source: "admin", delivery: "operator_handoff", supersedeReason: "admin_precedence" }, bundle.db, T0);

    expect(loadRedeemableToken(first.rawToken, bundle.db, T0)).toEqual({ ok: false, reason: "invalidated" });
    expect(loadRedeemableToken(second.rawToken, bundle.db, T0).ok).toBe(true);
  });

  it("enforces expiry and single use", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    const issued = issueResetToken({ userId: "user-1", source: "self_service", delivery: "email" }, bundle.db, T0);

    expect(
      loadRedeemableToken(issued.rawToken, bundle.db, new Date(T0.getTime() + RESET_TOKEN_TTL_MS - 1000)).ok,
    ).toBe(true);
    expect(
      loadRedeemableToken(issued.rawToken, bundle.db, new Date(T0.getTime() + RESET_TOKEN_TTL_MS)),
    ).toEqual({ ok: false, reason: "expired" });

    markResetTokenUsed(issued.tokenId, bundle.db, T0.toISOString());
    expect(loadRedeemableToken(issued.rawToken, bundle.db, T0)).toEqual({ ok: false, reason: "used" });
    expect(loadRedeemableToken("not-a-token", bundle.db, T0)).toEqual({ ok: false, reason: "unknown_token" });
  });

  it("self-service eligibility excludes unknown, oidc-only, disabled, inactive, and break-glass", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "ok");
    seedUser(bundle.sqlite, "oidc-only", null);
    seedUser(bundle.sqlite, "disabled", "disabled:abc");
    bundle.sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = 'disabled'`).run();
    bundle.sqlite
      .prepare(`INSERT INTO auth_control (id, break_glass_user_id, updated_at, updated_by_user_id, change_reason)
                VALUES (1, 'ok', ?, NULL, 'test designation reason')`)
      .run(T0.toISOString());

    expect(checkSelfServiceEligibility("ok@example.com", bundle.db)).toEqual({
      eligible: false,
      reason: "break_glass_designee",
    });
    expect(checkSelfServiceEligibility("oidc-only@example.com", bundle.db).eligible).toBe(false);
    expect(checkSelfServiceEligibility("disabled@example.com", bundle.db).eligible).toBe(false);
    expect(checkSelfServiceEligibility("ghost@example.com", bundle.db).eligible).toBe(false);
  });
});
```

(One test also asserts a non-designee user IS eligible; add it alongside. Note `auth_control` insert columns must match the actual table; check `breakGlassRecoveryCodes` neighbors in `schema.ts` for exact column names: `id`, `break_glass_user_id`, `updated_at`, `updated_by_user_id`, `change_reason`.)

- [ ] **Step 2: Run to verify failure** -> module not found.

- [ ] **Step 3: Implement**

Create `src/server/auth/password-reset-tokens.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import { authControl, passwordResetTokens } from "@/server/db/schema";
import { users } from "@/server/db/schema";

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
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx vitest run src/server/auth/password-reset-tokens.test.ts && npm run typecheck
git add src/server/auth/password-reset-tokens.ts src/server/auth/password-reset-tokens.test.ts
git commit -m "feat(auth): add password reset token store (hashed, single-use, 60 min)"
```

### Task 6: Shared reset copy/schemas + self-service request service

**Files:**
- Create: `src/lib/password-reset.ts` (copy constants + zod schemas; safe for client import)
- Create: `src/server/auth/password-reset.ts` (request service)
- Test: `src/server/auth/password-reset.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces:
  - `PASSWORD_RESET_COPY = { REQUEST_CONFIRMATION, REDEEM_FAILURE }` (exact copy from Global Constraints)
  - `passwordResetRequestSchema = z.object({ email })`; `passwordResetCompletionSchema = z.object({ token, password, confirmPassword })` with 10-200 password rule and match refinement
  - `requestPasswordReset({ email, ip, origin }, db?): Promise<void>` - always resolves; never reveals account existence.

- [ ] **Step 1: Write the failing tests**

`src/server/auth/password-reset.test.ts` - harness: `openAppDatabase(":memory:")`, seed users as in Task 5, stub env per case with `vi.stubEnv`, assert via `securityEvents` table selects. Core cases:

```ts
it("creates a token, records success with delivery unconfigured, and sends nothing when mail is off", async () => {
  vi.stubEnv("SUPERSCRIBER_RESET_MAIL_MODE", "");
  const bundle = openAppDatabase(":memory:");
  seedUser(bundle.sqlite, "user-1");

  await requestPasswordReset({ email: "user-1@example.com", ip: "127.0.0.1", origin: "https://app.test" }, bundle.db);

  const tokens = bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all();
  expect(tokens).toHaveLength(0); // unconfigured seam issues nothing
  expect(securityEventRows(bundle.sqlite)).toEqual([
    expect.objectContaining({ type: "password.reset.requested", outcome: "success", userId: "user-1" }),
  ]);
});

it("treats unknown emails identically and records a denial without an email address", async () => {
  const bundle = openAppDatabase(":memory:");
  await requestPasswordReset({ email: "ghost@example.com", ip: "127.0.0.1", origin: null }, bundle.db);
  const events = securityEventRows(bundle.sqlite);
  expect(events[0]).toMatchObject({ type: "password.reset.requested", outcome: "denied", userId: null });
  expect(JSON.stringify(events[0])).not.toContain("ghost@example.com");
});

it("rate limits per email after 3 requests per hour without revealing the limit", async () => {
  const bundle = openAppDatabase(":memory:");
  seedUser(bundle.sqlite, "user-1");
  for (let i = 0; i < 4; i++) {
    await requestPasswordReset({ email: "user-1@example.com", ip: "127.0.0.1", origin: null }, bundle.db);
  }
  const denials = securityEventRows(bundle.sqlite).filter((e) => e.outcome === "denied");
  expect(denials.at(-1)?.detail).toContain("rate");
});

it("with smtp configured, issues a token and sends one message; send failure records mail_failed and keeps the token", async () => {
  vi.stubEnv("SUPERSCRIBER_RESET_MAIL_MODE", "smtp");
  // ...stub the companion SUPERSCRIBER_RESET_MAIL_* vars
  mockSendPasswordResetEmail.mockRejectedValueOnce(new Error("smtp down"));
  const bundle = openAppDatabase(":memory:");
  seedUser(bundle.sqlite, "user-1");
  await requestPasswordReset({ email: "user-1@example.com", ip: "127.0.0.1", origin: "https://app.test" }, bundle.db);
  expect(bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all()).toHaveLength(1);
  expect(securityEventRows(bundle.sqlite).map((e) => e.type)).toContain("password.reset.mail_failed");
});
```

Mock `@/server/auth/reset-mailer` with `vi.mock`. Reset limiter state in `beforeEach` via `resetRequestByIpLimiter.reset()` etc. Assert the dummy-compare path timing shape indirectly only; direct timing assertions are forbidden (flaky).

- [ ] **Step 2: Run to verify failure** -> modules not found.

- [ ] **Step 3: Implement the shared lib**

Create `src/lib/password-reset.ts` (no server-only imports):

```ts
import { z } from "zod";

export const PASSWORD_RESET_COPY = {
  REQUEST_CONFIRMATION:
    "If an account matches that email, a password reset has been started. If nothing arrives, contact your administrator.",
  REDEEM_FAILURE:
    "That reset link is no longer valid. Ask your administrator for a new one or request another reset.",
  REDEEM_SUCCESS:
    "Your password has been reset. Sign in with your new password.",
} as const;

export const passwordResetRequestSchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(320),
});

export const passwordResetCompletionSchema = z
  .object({
    token: z.string().min(1),
    password: z
      .string()
      .min(10, "Use at least 10 characters.")
      .max(200, "Passwords must stay under 200 characters."),
    confirmPassword: z.string().min(1, "Confirm the password."),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmPassword) {
      context.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords must match.",
      });
    }
  });
```

- [ ] **Step 4: Implement the request service**

Create `src/server/auth/password-reset.ts`:

```ts
import { compare, hash } from "bcryptjs";
import { loadAuthConfig } from "@/server/auth/auth-config";
import { loadResetMailConfig } from "@/server/auth/reset-mail-config";
import { sendPasswordResetEmail } from "@/server/auth/reset-mailer";
import { recordSecurityEvent } from "@/server/auth/security-events";
import {
  resetRequestByEmailLimiter,
  resetRequestByIpLimiter,
} from "@/server/auth/password-reset-rate-limit";
import { checkSelfServiceEligibility, issueResetToken } from "@/server/auth/password-reset-tokens";
import { normalizeEmail } from "@/server/auth/validation";
import { getAppDb, type AppDatabase } from "@/server/db/client";

const DUMMY_PASSWORD = "superscriber-reset-dummy-guess";
let dummyHashPromise: Promise<string> | null = null;

/** Constant-shape work for ineligible requests (spec 4.4). */
async function dummyCompare() {
  dummyHashPromise ??= hash("superscriber-reset-dummy", 12);
  await compare(DUMMY_PASSWORD, await dummyHashPromise);
}

function safeRecord(input: Parameters<typeof recordSecurityEvent>[0], db: AppDatabase) {
  try {
    recordSecurityEvent(input, db);
  } catch {
    // The reset flow never fails because its event stream did.
  }
}

export function buildResetUrl(rawToken: string, origin: string | null, baseUrl: string | null) {
  const base = (baseUrl ?? origin ?? "").replace(/\/$/, "");
  return `${base}/reset/${rawToken}`;
}

/**
 * Self-service request (spec section 4). Always resolves; the caller returns
 * PASSWORD_RESET_COPY.REQUEST_CONFIRMATION regardless of outcome.
 */
export async function requestPasswordReset(
  params: { email: string; ip: string | null; origin: string | null },
  db: AppDatabase = getAppDb(),
): Promise<void> {
  const email = normalizeEmail(params.email);

  const byIp = resetRequestByIpLimiter.check(params.ip ?? "unknown");
  const byEmail = resetRequestByEmailLimiter.check(email);
  if (!byIp.allowed || !byEmail.allowed) {
    await dummyCompare();
    safeRecord(
      { type: "password.reset.requested", outcome: "denied", detail: "Password reset request rate limited.", metadata: { reason: "rate_limited" } },
      db,
    );
    return;
  }

  const authMode = loadAuthConfig().mode;
  const eligibility = checkSelfServiceEligibility(email, db);
  if (authMode === "authentik-primary" || !eligibility.eligible) {
    await dummyCompare();
    safeRecord(
      {
        type: "password.reset.requested",
        outcome: "denied",
        detail: "Password reset request denied.",
        metadata: { reason: authMode === "authentik-primary" ? "authentik_primary_mode" : eligibility.reason },
      },
      db,
    );
    return;
  }

  const config = loadResetMailConfig();
  if (config.mode === "none") {
    safeRecord(
      {
        type: "password.reset.requested",
        outcome: "success",
        userId: eligibility.userId,
        detail: "Password reset request accepted; mail seam unconfigured.",
        metadata: { delivery: "unconfigured" },
      },
      db,
    );
    return;
  }

  const issued = issueResetToken(
    { userId: eligibility.userId, source: "self_service", delivery: "email" },
    db,
  );
  const resetUrl = buildResetUrl(issued.rawToken, params.origin, config.baseUrl);
  safeRecord(
    {
      type: "password.reset.requested",
      outcome: "success",
      userId: eligibility.userId,
      detail: "Password reset link emailed.",
      metadata: { delivery: "email", resetRecordId: issued.tokenId },
    },
    db,
  );
  try {
    await sendPasswordResetEmail(config, {
      to: eligibility.email,
      resetUrl,
      expiresAtIso: issued.expiresAt,
    });
  } catch {
    // Honest degradation: the token stays valid; the failure is visible to
    // admins on the security-event surface, not to the requester.
    safeRecord(
      {
        type: "password.reset.mail_failed",
        outcome: "error",
        userId: eligibility.userId,
        detail: "Password reset mail could not be delivered.",
        metadata: { resetRecordId: issued.tokenId },
      },
      db,
    );
  }
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npx vitest run src/server/auth/password-reset.test.ts && npm run typecheck
git add src/lib/password-reset.ts src/server/auth/password-reset.ts src/server/auth/password-reset.test.ts
git commit -m "feat(auth): add self-service password reset request service"
```

### Task 7: Self-service request page, server action, sign-in link

**Files:**
- Create: `src/server/actions/password-reset-actions.ts` (adds `requestPasswordResetAction`; Task 9 adds `completePasswordResetAction` to the same file)
- Create: `app/reset-request/page.tsx`
- Create: `src/components/auth/password-reset-request-form.tsx`
- Modify: `app/page.tsx` (add "Forgot your password?" link when `surface.showLocalCredentialsForm`)
- Test: `src/components/auth/password-reset-request-form.test.tsx`

**Interfaces:**
- Consumes: Task 6.
- Produces: `requestPasswordResetAction(input: { email: string }): Promise<{ ok: true; message: string } | { ok: false; fieldErrors: { email?: string } }>`; route `/reset-request`.

- [ ] **Step 1: Write the failing component test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PasswordResetRequestForm } from "@/components/auth/password-reset-request-form";

describe("PasswordResetRequestForm", () => {
  it("always shows the identical confirmation after submit", async () => {
    const action = vi.fn(async () => ({ ok: true as const, message: "If an account matches that email, a password reset has been started. If nothing arrives, contact your administrator." }));
    render(<PasswordResetRequestForm action={action} />);
    await userEvent.type(screen.getByLabelText(/email/i), "Person@Example.com ");
    await userEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(await screen.findByText(/If an account matches that email/)).toBeInTheDocument();
    expect(action).toHaveBeenCalledWith({ email: "Person@Example.com" });
  });

  it("shows an email field error without calling the action", async () => {
    const action = vi.fn();
    render(<PasswordResetRequestForm action={action as never} />);
    await userEvent.type(screen.getByLabelText(/email/i), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
```

(Match existing component-test conventions in `src/components/ui/phone-safety.test.ts` / admin tests; the form must accept the action as a prop for testability, defaulting to the imported server action in the page.)

- [ ] **Step 2: Run to verify failure** -> component not found.

- [ ] **Step 3: Implement the server action**

Create `src/server/actions/password-reset-actions.ts`:

```ts
"use server";

import { headers } from "next/headers";
import {
  PASSWORD_RESET_COPY,
  passwordResetRequestSchema,
} from "@/lib/password-reset";
import { requestPasswordReset } from "@/server/auth/password-reset";

export type PasswordResetRequestActionResult =
  | { ok: true; message: string }
  | { ok: false; fieldErrors: { email?: string } };

async function requestContext() {
  const headerList = await headers();
  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  const host = headerList.get("host");
  const origin = headerList.get("origin") ?? (host ? `https://${host}` : null);
  return { ip: forwarded ?? null, origin };
}

export async function requestPasswordResetAction(input: {
  email: string;
}): Promise<PasswordResetRequestActionResult> {
  const parsed = passwordResetRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: { email: parsed.error.flatten().fieldErrors.email?.[0] },
    };
  }
  const { ip, origin } = await requestContext();
  await requestPasswordReset({ email: parsed.data.email, ip, origin });
  // Anti-enumeration: identical confirmation for every accepted submission.
  return { ok: true, message: PASSWORD_RESET_COPY.REQUEST_CONFIRMATION };
}
```

- [ ] **Step 4: Implement page and form**

`app/reset-request/page.tsx` (server component, `export const dynamic = "force-dynamic"`; heading "Reset your password"; renders the form plus a "Back to sign in" link to `/`):

```tsx
import Link from "next/link";
import { PasswordResetRequestForm } from "@/components/auth/password-reset-request-form";
import { requestPasswordResetAction } from "@/server/actions/password-reset-actions";

export const dynamic = "force-dynamic";

export default function ResetRequestPage() {
  return (
    <main className="auth-shell">
      <h1>Reset your password</h1>
      <PasswordResetRequestForm action={requestPasswordResetAction} />
      <p>
        <Link href="/">Back to sign in</Link>
      </p>
    </main>
  );
}
```

`src/components/auth/password-reset-request-form.tsx`: client component; controlled email input; on submit preventDefault -> `startTransition` -> validate with `passwordResetRequestSchema` locally (import from `@/lib/password-reset`, which is client-safe) for the pre-action field error; call the `action` prop; on `{ ok: true }` replace the form with the confirmation text in a status region. After confirmation, the email field and button are removed (no repeat-submit surface).

`app/page.tsx`: inside the `surface.showLocalCredentialsForm` block, below `<LoginForm ... />`:

```tsx
<p className="auth-links">
  <Link href="/reset-request">Forgot your password?</Link>
</p>
```

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npx vitest run src/components/auth/password-reset-request-form.test.tsx && npm run typecheck
git add src/server/actions/password-reset-actions.ts app/reset-request src/components/auth/password-reset-request-form.tsx src/components/auth/password-reset-request-form.test.tsx app/page.tsx
git commit -m "feat(auth): add self-service reset request page and sign-in link"
```

### Task 8: Password completion service

**Files:**
- Modify: `src/server/auth/password-reset.ts` (add `completePasswordReset`)
- Test: `src/server/auth/password-reset.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1, 4, 5; `retireUserSessions` from `src/server/auth/session-registry.ts`; `runImmediateGovernedTransaction` from `src/server/db/transaction.ts`.
- Produces: `completePasswordReset({ rawToken, password, ip }, bundle?): Promise<{ ok: true } | { ok: false; message: string }>`. On success the user's hash is bcrypt(12), `auth_version` is +1, ALL sessions across all auth sources are revoked (`auth.session.revoked` per session), and `password.reset.completed` is recorded.

- [ ] **Step 1: Write the failing tests**

Extend `src/server/auth/password-reset.test.ts` (seed users + active `auth_sessions` rows of all three sources as in `account-role-service.test.ts` harness):

```ts
it("completes a reset: rewrites hash, bumps auth_version, revokes every session source", async () => {
  const bundle = openAppDatabase(":memory:");
  seedUser(bundle.sqlite, "user-1");
  insertAuthSession(bundle, { id: "s-local", userId: "user-1" });
  insertAuthSession(bundle, { id: "s-oidc", userId: "user-1", authSource: "authentik" });
  insertAuthSession(bundle, { id: "s-bg", userId: "user-1", authSource: "break_glass" });
  const issued = issueResetToken({ userId: "user-1", source: "self_service", delivery: "email" }, bundle.db);

  const result = await completePasswordReset(
    { rawToken: issued.rawToken, password: "NewPassword!234", ip: "127.0.0.1" },
    bundle,
  );

  expect(result).toEqual({ ok: true });
  const user = bundle.db.select().from(users).where(eq(users.id, "user-1")).get()!;
  expect(user.authVersion).toBe(2);
  expect(await compare("NewPassword!234", user.passwordHash!)).toBe(true);
  const sessions = bundle.sqlite.prepare(`SELECT status, revoked_reason FROM auth_sessions WHERE user_id = 'user-1'`).all() as Array<{ status: string; revoked_reason: string }>;
  expect(sessions).toHaveLength(3);
  expect(sessions.every((s) => s.status === "revoked" && s.revoked_reason === "password_reset")).toBe(true);
  expect(securityEventRows(bundle.sqlite).map((e) => e.type)).toContain("password.reset.completed");
});

it("denies used, expired, and superseded tokens with one generic result and one redeem_denied event", async () => {
  const bundle = openAppDatabase(":memory:");
  seedUser(bundle.sqlite, "user-1");
  const first = issueResetToken({ userId: "user-1", source: "self_service", delivery: "email" }, bundle.db);
  issueResetToken({ userId: "user-1", source: "self_service", delivery: "email" }, bundle.db); // supersedes first

  const result = await completePasswordReset({ rawToken: first.rawToken, password: "WhateverPass1!", ip: null }, bundle);
  expect(result).toEqual({ ok: false, message: PASSWORD_RESET_COPY.REDEEM_FAILURE });
  const events = securityEventRows(bundle.sqlite);
  expect(events.at(-1)).toMatchObject({ type: "password.reset.redeem_denied", outcome: "denied" });
});

it("re-checks inside the transaction and denies a break-glass designee", async () => {
  const bundle = openAppDatabase(":memory:");
  seedUser(bundle.sqlite, "bg-admin", "hash");
  bundle.db.update(users).set({ role: "admin" }).where(eq(users.id, "bg-admin")).run();
  const issued = issueResetToken({ userId: "bg-admin", source: "admin", delivery: "operator_handoff" }, bundle.db);
  bundle.sqlite
    .prepare(`INSERT INTO auth_control (id, break_glass_user_id, updated_at, updated_by_user_id, change_reason) VALUES (1, 'bg-admin', ?, NULL, 'test designation reason')`)
    .run(new Date().toISOString());

  const result = await completePasswordReset({ rawToken: issued.rawToken, password: "NewPassword!234", ip: null }, bundle);
  expect(result.ok).toBe(false);
  const stillHash = bundle.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, "bg-admin")).get()!;
  expect(stillHash.passwordHash).toBe("hash");
});

it("rate limits redemption failures per IP", async () => {
  const bundle = openAppDatabase(":memory:");
  for (let i = 0; i < 11; i++) {
    await completePasswordReset({ rawToken: "guessed-token", password: "AttemptPassword1", ip: "10.0.0.9" }, bundle);
  }
  const denials = securityEventRows(bundle.sqlite).filter((e) => e.type === "password.reset.redeem_denied");
  expect(denials.filter((e) => e.metadata?.includes("rate_limited") || e.detail.includes("rate"))).not.toHaveLength(0);
});
```

(For `insertAuthSession`, parameterize `authSource` over the Task-5 harness copy. Reset `resetRedeemByIpLimiter.reset()` in `beforeEach`.)

- [ ] **Step 2: Run to verify failure** -> `completePasswordReset` is not exported.

- [ ] **Step 3: Implement**

Append to `src/server/auth/password-reset.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { hash } from "bcryptjs";
import { PASSWORD_RESET_COPY } from "@/lib/password-reset";
import { resetRedeemByIpLimiter } from "@/server/auth/password-reset-rate-limit";
import {
  invalidateUserResetTokens,
  loadRedeemableToken,
  markResetTokenUsed,
} from "@/server/auth/password-reset-tokens";
import { retireUserSessions } from "@/server/auth/session-registry";
import { getAppDbBundle, type AppDatabaseBundle } from "@/server/db/client";
import { authControl, users } from "@/server/db/schema";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";

class RedeemStateChangedError extends Error {}

/**
 * Completion (spec 4.1): one transaction - mark used, write bcrypt(12) hash,
 * retire every session from every auth source via auth_version advancement,
 * invalidate leftover tokens. Never mints a session; never auto-signs-in.
 */
export async function completePasswordReset(
  params: { rawToken: string; password: string; ip: string | null },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const deny = (reason: string) => {
    safeRecord(
      { type: "password.reset.redeem_denied", outcome: "denied", detail: "Password reset redemption denied.", metadata: { reason } },
      bundle.db,
    );
    return { ok: false as const, message: PASSWORD_RESET_COPY.REDEEM_FAILURE };
  };

  if (!resetRedeemByIpLimiter.check(params.ip ?? "unknown").allowed) {
    return deny("rate_limited");
  }

  const redeemable = loadRedeemableToken(params.rawToken, bundle.db);
  if (!redeemable.ok) {
    return deny(redeemable.reason);
  }

  // Defense in depth: a token issued before designation must never reset the
  // break-glass credential outside the emergency ceremony.
  const designation = bundle.db
    .select({ userId: authControl.breakGlassUserId })
    .from(authControl)
    .where(eq(authControl.id, 1))
    .get();
  if (designation?.userId === redeemable.token.userId) {
    return deny("break_glass_designee");
  }

  const passwordHash = await hash(params.password, 12);

  try {
    runImmediateGovernedTransaction((db, nowIso) => {
      const current = loadRedeemableToken(params.rawToken, db, new Date(nowIso));
      if (!current.ok) {
        throw new RedeemStateChangedError(current.ok ? "" : current.reason);
      }
      markResetTokenUsed(current.token.id, db, nowIso);
      db.update(users)
        .set({ passwordHash, updatedAt: nowIso })
        .where(eq(users.id, current.token.userId))
        .run();
      retireUserSessions({ userId: current.token.userId, reason: "password_reset" }, db);
      invalidateUserResetTokens(
        { userId: current.token.userId, reason: "user_reset_completed" },
        db,
        nowIso,
      );
      recordSecurityEvent(
        {
          type: "password.reset.completed",
          outcome: "success",
          userId: current.token.userId,
          detail: "Password reset completed; sessions revoked.",
          metadata: { source: current.token.source, resetRecordId: current.token.id },
        },
        db,
      );
      return null;
    }, bundle);
  } catch (error) {
    if (error instanceof RedeemStateChangedError) {
      return deny("state_changed");
    }
    throw error;
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx vitest run src/server/auth/password-reset.test.ts && npm run typecheck
git add src/server/auth/password-reset.ts src/server/auth/password-reset.test.ts
git commit -m "feat(auth): add atomic password reset completion with session retirement"
```

### Task 9: Completion page, form, server action

**Files:**
- Modify: `src/server/actions/password-reset-actions.ts` (add `completePasswordResetAction`)
- Create: `app/reset/[token]/page.tsx`
- Create: `src/components/auth/password-reset-completion-form.tsx`
- Test: `src/components/auth/password-reset-completion-form.test.tsx`

**Interfaces:**
- Consumes: Tasks 6, 8.
- Produces: route `/reset/[token]`; `completePasswordResetAction(input: { token: string; password: string; confirmPassword: string }): Promise<{ ok: true; message: string } | { ok: false; message: string; fieldErrors?: Partial<Record<"password" | "confirmPassword", string>> }>`.

- [ ] **Step 1: Write the failing component test**

Cases: (a) valid submit calls action with `{ token, password, confirmPassword }` and shows the success message with a "Sign in" link; (b) mismatched confirmation shows field error without calling the action; (c) server `{ ok: false }` shows the generic failure copy. Mirror the Task 7 test harness.

- [ ] **Step 2: Run to verify failure** -> component not found.

- [ ] **Step 3: Implement the server action**

Append to `src/server/actions/password-reset-actions.ts`:

```ts
import { completePasswordReset } from "@/server/auth/password-reset";
import { passwordResetCompletionSchema } from "@/lib/password-reset";

export type CompletePasswordResetActionResult =
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<"password" | "confirmPassword", string>>;
    };

export async function completePasswordResetAction(input: {
  token: string;
  password: string;
  confirmPassword: string;
}): Promise<CompletePasswordResetActionResult> {
  const parsed = passwordResetCompletionSchema.safeParse(input);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    return {
      ok: false,
      message: flat.fieldErrors.password?.[0] ?? flat.fieldErrors.confirmPassword?.[0] ?? "Check the form and try again.",
      fieldErrors: {
        password: flat.fieldErrors.password?.[0],
        confirmPassword: flat.fieldErrors.confirmPassword?.[0],
      },
    };
  }
  const { ip } = await requestContext();
  const result = await completePasswordReset({
    rawToken: parsed.data.token,
    password: parsed.data.password,
    ip,
  });
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  return { ok: true, message: PASSWORD_RESET_COPY.REDEEM_SUCCESS };
}
```

- [ ] **Step 4: Implement page and form**

`app/reset/[token]/page.tsx`: server component; `const { token } = await params;` renders `<PasswordResetCompletionForm token={token} action={completePasswordResetAction} />`. No server-side token pre-check (one generic failure surface at submit; keeps behavior identical for every invalid token).

`src/components/auth/password-reset-completion-form.tsx`: client component; password + confirm fields with `type="password"` and `autoComplete="new-password"`; client-validates via `passwordResetCompletionSchema`; submit calls the action prop; success replaces the form with the success message and a `<Link href="/">Sign in</Link>`; failure shows `result.message` in an error summary with focus management (mirror `LoginForm`'s `error-summary` pattern). Form errors do not consume the token.

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npx vitest run src/components/auth/password-reset-completion-form.test.tsx && npm run typecheck
git add src/server/actions/password-reset-actions.ts "app/reset" src/components/auth/password-reset-completion-form.tsx src/components/auth/password-reset-completion-form.test.tsx
git commit -m "feat(auth): add password reset completion page"
```

### Task 10: Shared admin actor-authority helper

**Files:**
- Create: `src/server/administration/actor-authority.ts`
- Modify: `src/server/administration/account-role-service.ts` (use the helper)
- Test: existing `src/server/administration/account-role-service.test.ts` must stay green unchanged.

**Interfaces:**
- Produces: `revalidateAdminActor(db, { actorUserId, actorAuthSessionId }, nowIso, deny: () => never): typeof users.$inferSelect` - the live-session + active-admin revalidation currently inlined in `account-role-service.ts`. Task 11 consumes it.

- [ ] **Step 1: Extract without behavior change**

Move `revalidateActorAuthority` out of `account-role-service.ts` into `actor-authority.ts`, parameterized on a `deny` callback so each caller keeps its own typed failure:

```ts
import { eq } from "drizzle-orm";
import type { AppDatabase } from "@/server/db/client";
import { authSessions, users } from "@/server/db/schema";

/**
 * Live authority revalidation for governed admin mutations: the actor's
 * durable session must be active, version-matched, and unexpired, and the
 * actor row must still be an active admin. Callers supply their typed denial.
 */
export function revalidateAdminActor(
  db: AppDatabase,
  params: { actorUserId: string; actorAuthSessionId: string },
  nowIso: string,
  deny: () => never,
): typeof users.$inferSelect {
  const row = db
    .select({ session: authSessions, actor: users })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(eq(authSessions.id, params.actorAuthSessionId))
    .get();

  const nowMs = Date.parse(nowIso);
  const idleExpiresAt = row ? Date.parse(row.session.idleExpiresAt) : NaN;
  const absoluteExpiresAt = row ? Date.parse(row.session.absoluteExpiresAt) : NaN;

  if (
    !row ||
    row.session.userId !== params.actorUserId ||
    row.session.status !== "active" ||
    row.session.authVersion !== row.actor.authVersion ||
    !Number.isFinite(idleExpiresAt) ||
    !Number.isFinite(absoluteExpiresAt) ||
    nowMs >= idleExpiresAt ||
    nowMs >= absoluteExpiresAt ||
    !row.actor.isActive ||
    row.actor.role !== "admin"
  ) {
    deny();
  }

  return row!.actor;
}
```

In `account-role-service.ts`, replace the inlined function body with:

```ts
const actor = revalidateAdminActor(db, params, now, () =>
  fail({ code: "ACCESS_DENIED", message: ACCOUNT_ROLE_CHANGE_COPY.ACCESS_DENIED }),
);
```

Careful: the existing code passes `now` (string) inside the transaction callback - keep the exact same call semantics and parameter order so no test changes are needed.

- [ ] **Step 2: Run the full administration + auth suites unchanged**

Run: `npx vitest run src/server/administration src/server/auth && npm run typecheck`
Expected: all PASS, no test edits.

- [ ] **Step 3: Commit**

```bash
git add src/server/administration/actor-authority.ts src/server/administration/account-role-service.ts
git commit -m "refactor(admin): extract shared actor-authority revalidation helper"
```

### Task 11: Admin reset service + audit type

**Files:**
- Create: `src/lib/account-password-reset.ts` (shared schema + copy; client-safe)
- Modify: `src/domain/models.ts` (add `"account.password_reset"` to `AuditEvent["type"]` union, after `"account.role_changed"`)
- Create: `src/server/administration/password-reset-service.ts`
- Test: `src/server/administration/password-reset-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 5, 10.
- Produces:
  - `adminPasswordResetInputSchema = z.object({ userId: z.string().min(1), reason: z.string().trim().min(10, REASON_MESSAGE).max(500, REASON_MESSAGE), delivery: z.enum(["operator_handoff", "email"]) })`; `PASSWORD_RESET_ADMIN_COPY` with `ACCESS_DENIED`, `NOT_FOUND`, `INACTIVE_TARGET`, `BREAK_GLASS_DESIGNEE`, `CREDENTIAL_DISABLED`, `MAIL_UNCONFIGURED`, `INTERNAL_ERROR`, `VALIDATION_ERROR` messages.
  - `adminIssuePasswordReset({ actorUserId, actorAuthSessionId, input }, bundle?): AdminPasswordResetSuccess` throwing `AdminPasswordResetServiceError` carrying `AdminPasswordResetFailure = { code: "VALIDATION_ERROR" | "ACCESS_DENIED" | "NOT_FOUND" | "INACTIVE_TARGET" | "BREAK_GLASS_DESIGNEE" | "CREDENTIAL_DISABLED" | "MAIL_UNCONFIGURED" | "INTERNAL_ERROR"; message: string; fieldErrors?: Record<string, string> }`.
  - `AdminPasswordResetSuccess = { userId: string; targetDisplayName: string; targetEmail: string; rawToken: string; recordId: string; expiresAt: string; delivery: "email" | "operator_handoff"; revokedSessionCount: number; resultingAuthVersion: number; actorMustRelogin: boolean }`.
  - Every denial records `admin.password_reset.issued` outcome `denied` (best-effort, like `safeRecordDenial` in account-role-service).

- [ ] **Step 1: Write the failing tests**

Harness: copy the `account-role-service.test.ts` setup (workspace row, `insertUser`, `insertAuthSession`, admins with live sessions). Cases, each asserting typed failure + denial event:

```ts
it("issues an operator-handoff reset: sessions retired, prior tokens invalidated, audit + security events written", () => {
  const bundle = setup();
  // seed target "reviewer-1" with an active session and an outstanding self-service token
  const prior = issueResetToken({ userId: "reviewer-1", source: "self_service", delivery: "email" }, bundle.db);
  insertAuthSession(bundle, { id: "s1", userId: "reviewer-1" });

  const result = adminIssuePasswordReset({
    actorUserId: "admin-1",
    actorAuthSessionId: ADMIN_1_SESSION_ID,
    input: { userId: "reviewer-1", reason: "User forgot their password at the front desk.", delivery: "operator_handoff" },
  }, bundle);

  expect(result.revokedSessionCount).toBe(1);
  expect(result.resultingAuthVersion).toBe(2);
  expect(result.rawToken).toBeTruthy();
  expect(loadRedeemableToken(prior.rawToken, bundle.db)).toEqual({ ok: false, reason: "invalidated" });
  const audit = bundle.db.select().from(auditEvents).all().at(-1)!;
  expect(audit.type).toBe("account.password_reset");
  expect(audit.actorUserId).toBe("admin-1");
  const issued = bundle.db.select().from(securityEvents).all().find((e) => e.type === "admin.password_reset.issued")!;
  expect(issued.outcome).toBe("success");
});

it.each([
  ["inactive target", { seed: "inactive" }, "INACTIVE_TARGET"],
  ["break-glass designee", { seed: "designee" }, "BREAK_GLASS_DESIGNEE"],
  ["disabled credential", { seed: "disabled" }, "CREDENTIAL_DISABLED"],
  ["unknown target", { seed: "missing" }, "NOT_FOUND"],
])("denies %s", (_name, { seed }, code) => { /* seeds per arm; expect AdminPasswordResetServiceError with failure.code === code and a denied admin.password_reset.issued event */ });

it("denies email delivery when the mail seam is unconfigured", () => {
  vi.stubEnv("SUPERSCRIBER_RESET_MAIL_MODE", "");
  // expect MAIL_UNCONFIGURED without any token row being created
});

it("self-reset retires the actor's own session and flags actorMustRelogin", () => { /* target === actor; expect actorMustRelogin true and the actor session row revoked */ });
```

- [ ] **Step 2: Run to verify failure** -> module not found.

- [ ] **Step 3: Implement the shared lib**

`src/lib/account-password-reset.ts`:

```ts
import { z } from "zod";

const REASON_MESSAGE = "Enter a reset reason between 10 and 500 characters.";

export const PASSWORD_RESET_ADMIN_COPY = {
  ACCESS_DENIED: "Only an active administrator with a live session can reset account passwords.",
  NOT_FOUND: "That account no longer exists.",
  INACTIVE_TARGET: "Inactive accounts cannot be reset.",
  BREAK_GLASS_DESIGNEE:
    "The break-glass administrator's password rotates only through the emergency ceremony.",
  CREDENTIAL_DISABLED:
    "That account's local credential was retired by a break-glass transfer and cannot be reset here.",
  MAIL_UNCONFIGURED:
    "Reset mail is not configured. Choose out-of-band handoff instead.",
  INTERNAL_ERROR: "The password reset could not be completed. Try again.",
  MAIL_SEND_FAILED:
    "The reset was issued but the email could not be delivered. Re-issue with out-of-band handoff.",
} as const;

export const adminPasswordResetInputSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().min(10, REASON_MESSAGE).max(500, REASON_MESSAGE),
  delivery: z.enum(["operator_handoff", "email"]),
});

export type AdminPasswordResetInput = z.infer<typeof adminPasswordResetInputSchema>;
```

- [ ] **Step 4: Implement the service**

`src/server/administration/password-reset-service.ts` - structure mirrors `account-role-service.ts`:

```ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  adminPasswordResetInputSchema,
  PASSWORD_RESET_ADMIN_COPY,
  type AdminPasswordResetInput,
} from "@/lib/account-password-reset";
import { revalidateAdminActor } from "@/server/administration/actor-authority";
import { loadResetMailConfig } from "@/server/auth/reset-mail-config";
import { recordSecurityEvent } from "@/server/auth/security-events";
import {
  invalidateUserResetTokens,
  issueResetToken,
} from "@/server/auth/password-reset-tokens";
import { retireUserSessions } from "@/server/auth/session-registry";
import { insertAuditEvent } from "@/server/casefile/audit";
import { getAppDbBundle, type AppDatabaseBundle } from "@/server/db/client";
import { authControl, users } from "@/server/db/schema";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";

// failure/error plumbing copied from account-role-service:
// AdminPasswordResetServiceError, fail(), validationFailure(), safeRecordDenial()

export function adminIssuePasswordReset(
  params: { actorUserId: string; actorAuthSessionId: string; input: AdminPasswordResetInput },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): AdminPasswordResetSuccess {
  try {
    return runImmediateGovernedTransaction((db, now) => {
      const input = validationFailure(params.input); // zod parse -> typed VALIDATION_ERROR
      const actor = revalidateAdminActor(db, params, now, () =>
        fail({ code: "ACCESS_DENIED", message: PASSWORD_RESET_ADMIN_COPY.ACCESS_DENIED }),
      );

      const target = db.select().from(users).where(eq(users.id, input.userId)).get();
      if (!target) fail({ code: "NOT_FOUND", message: PASSWORD_RESET_ADMIN_COPY.NOT_FOUND });
      if (!target.isActive) fail({ code: "INACTIVE_TARGET", message: PASSWORD_RESET_ADMIN_COPY.INACTIVE_TARGET });

      const designation = db
        .select({ userId: authControl.breakGlassUserId })
        .from(authControl)
        .where(eq(authControl.id, 1))
        .get();
      if (designation?.userId === target.id) {
        fail({ code: "BREAK_GLASS_DESIGNEE", message: PASSWORD_RESET_ADMIN_COPY.BREAK_GLASS_DESIGNEE });
      }
      if (target.passwordHash?.startsWith("disabled:")) {
        fail({ code: "CREDENTIAL_DISABLED", message: PASSWORD_RESET_ADMIN_COPY.CREDENTIAL_DISABLED });
      }
      if (input.delivery === "email" && loadResetMailConfig().mode !== "smtp") {
        fail({ code: "MAIL_UNCONFIGURED", message: PASSWORD_RESET_ADMIN_COPY.MAIL_UNCONFIGURED });
      }

      // Precedence: prior tokens die, then every session, then one new token.
      invalidateUserResetTokens({ userId: target.id, reason: "admin_precedence" }, db, now);
      retireUserSessions({ userId: target.id, reason: "admin_password_reset" }, db);
      const issued = issueResetToken(
        { userId: target.id, source: "admin", delivery: input.delivery, requestedByUserId: actor.id },
        db,
        new Date(now),
      );

      const reloaded = db
        .select({ authVersion: users.authVersion, sessionCount: /* read via authSessions count or capture from retireUserSessions return */ })
        // Simpler: capture retireUserSessions' return:
        .from(users).where(eq(users.id, target.id)).get()!;

      const workspace = ensureAuditWorkspace(db); // export it from account-role-service.ts or duplicate the helper
      insertAuditEvent(db, {
        workspaceId: workspace.id,
        recordingId: null,
        actor: {
          actorRole: "admin",
          actorUserId: actor.id,
          actorDisplayName: actor.displayName,
          effectiveRole: "admin",
          adminActionSessionId: null,
        },
        type: "account.password_reset",
        detail: `${target.displayName}'s password was reset by an administrator.`,
        metadata: {
          targetUserId: target.id,
          targetDisplayName: target.displayName,
          reason: input.reason,
          delivery: input.delivery,
          revokedSessionCount, // from retireUserSessions return value
          resultingAuthVersion: reloaded.authVersion,
        },
        createdAt: now,
      });

      recordSecurityEvent(
        {
          type: "admin.password_reset.issued",
          outcome: "success",
          userId: target.id,
          detail: "Administrator issued a password reset.",
          metadata: { actorUserId: actor.id, delivery: input.delivery, resetRecordId: issued.tokenId },
        },
        db,
      );

      return {
        userId: target.id,
        targetDisplayName: target.displayName,
        targetEmail: target.email,
        rawToken: issued.rawToken,
        recordId: issued.tokenId,
        expiresAt: issued.expiresAt,
        delivery: input.delivery,
        revokedSessionCount,
        resultingAuthVersion: reloaded.authVersion,
        actorMustRelogin: actor.id === target.id,
      };
    }, bundle);
  } catch (error) {
    // same shell as changeAccountRole: typed errors -> safeRecordDenial
    // (admin.password_reset.issued, outcome denied, metadata denialCode);
    // unexpected -> correlationId console.error + INTERNAL_ERROR typed error.
  }
}
```

Implementation notes for the implementer (resolve the sketch seams exactly):
- `revokedSessionCount` = the return value of `retireUserSessions(...)` (`{ revokedCount }`) - destructure it before the audit insert; remove the sketchy sessionCount select.
- Export `ensureAuditWorkspace` from `account-role-service.ts` and import it (do not duplicate).
- Add `"account.password_reset"` to the `AuditEvent["type"]` union in `src/domain/models.ts`.

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npx vitest run src/server/administration && npm run typecheck
git add src/lib/account-password-reset.ts src/domain/models.ts src/server/administration/password-reset-service.ts src/server/administration/password-reset-service.test.ts src/server/administration/account-role-service.ts
git commit -m "feat(admin): add governed administrator password reset service"
```

### Task 12: Admin server action, view model flag, Accounts UI

**Files:**
- Modify: `src/server/actions/administration-actions.ts` (add `adminResetAccountPasswordAction`)
- Modify: `src/server/administration/service.ts` (add `resetMailConfigured: boolean` + `currentUserId: string` (already available via principal) to `AdministrationAccountsViewModel`)
- Create: `src/components/admin/account-password-reset.tsx` (modal flow)
- Modify: `src/components/admin/accounts-section.tsx` (per-row "Reset password" control, omitted under phone safety; shared modal state by account id)
- Test: `src/server/actions/actions.test.ts` (extend) and `src/components/admin/account-password-reset.test.tsx`

**Interfaces:**
- Consumes: Tasks 3, 6 (`buildResetUrl`), 11.
- Produces:
  - `adminResetAccountPasswordAction(input: AdminPasswordResetInput): Promise<AdminPasswordResetActionResult>` where success is `{ ok: true; notice: string; data: { targetDisplayName: string; resetUrl: string | null; expiresAt: string; actorMustRelogin: boolean } }` and failure is `{ ok: false } & AdminPasswordResetFailure` (plus `AUTH_EXPIRED` following the existing action pattern).
  - View model fields: `AdministrationAccountsViewModel["resetMailConfigured"]: boolean` and `["currentUserId"]: string`.
- Phone safety: the reset control is omitted (not disabled) when `phoneSafetyMode` is true, in both the desktop table and the responsive card copies.

- [ ] **Step 1: Write the failing tests**

Action tests (extend `src/server/actions/actions.test.ts`, `@/lib/account-password-reset` real, service mocked): unauthenticated caller -> `AUTH_EXPIRED`; non-admin principal -> `ACCESS_DENIED` thrown-shaped failure per the existing `requireAdmin` pattern; valid handoff input -> `ok: true` with `resetUrl` containing `/reset/` and `notice` naming the target.

Component tests (`account-password-reset.test.tsx`): (a) modal opens with reason field and delivery radios; email radio absent when `resetMailConfigured` false; (b) reason under 10 chars blocks submit with field error; (c) handoff success shows the one-time reveal (URL + expiry + copy button); (d) email success shows a sent notice and NO URL; (e) self-reset shows the "your own session ends immediately" warning when `targetUserId === currentUserId`.

- [ ] **Step 2: Run to verify failure** -> identifiers not found.

- [ ] **Step 3: Implement the action**

In `src/server/actions/administration-actions.ts`:

```ts
export async function adminResetAccountPasswordAction(
  input: AdminPasswordResetInput,
): Promise<AdminPasswordResetActionResult> {
  const activeSession = await getActiveSession();
  if (!activeSession) {
    return { ok: false, code: "AUTH_EXPIRED", message: "Your session expired. Sign in again." };
  }
  const principal = activeSession.user;

  const parsed = adminPasswordResetInputSchema.safeParse(input);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: flat.fieldErrors.reason?.[0] ?? "Check the form and try again.",
      fieldErrors: { reason: flat.fieldErrors.reason?.[0] } as Record<string, string>,
    };
  }

  let issued: AdminPasswordResetSuccess;
  try {
    requireAdmin(principal.role);
    issued = adminIssuePasswordReset({
      actorUserId: principal.userId,
      actorAuthSessionId: activeSession.authSessionId,
      input: parsed.data,
    });
  } catch (error) {
    if (error instanceof AdminPasswordResetServiceError) {
      return { ok: false, ...error.failure };
    }
    throw error; // requireAdmin's CasefileCommandError propagates like the role action
  }

  let resetUrl: string | null = null;
  if (issued.delivery === "email") {
    const config = loadResetMailConfig();
    const { origin } = await requestContextFromHeaders(); // shared helper; see note
    const url = config.mode === "smtp"
      ? buildResetUrl(issued.rawToken, origin, config.baseUrl)
      : null;
    try {
      if (config.mode === "smtp") {
        await sendPasswordResetEmail(config, {
          to: issued.targetEmail,
          resetUrl: url!,
          expiresAtIso: issued.expiresAt,
        });
      }
    } catch {
      recordSecurityEvent({
        type: "password.reset.mail_failed",
        outcome: "error",
        userId: issued.userId,
        detail: "Admin-issued reset mail could not be delivered.",
        metadata: { resetRecordId: issued.recordId },
      });
      return { ok: false, code: "INTERNAL_ERROR", message: PASSWORD_RESET_ADMIN_COPY.MAIL_SEND_FAILED };
    }
  } else {
    const { origin } = await requestContextFromHeaders();
    resetUrl = buildResetUrl(issued.rawToken, origin, null);
  }

  revalidatePath("/administration");
  return {
    ok: true,
    notice: `${issued.targetDisplayName}'s password reset was issued.`,
    data: {
      targetDisplayName: issued.targetDisplayName,
      resetUrl,
      expiresAt: issued.expiresAt,
      actorMustRelogin: issued.actorMustRelogin,
    },
  };
}
```

Note for the implementer: `requestContextFromHeaders` is the same `requestContext()` helper Task 7 added to `password-reset-actions.ts`; export it from there and import it (do not duplicate). The raw token for the email path is discarded after send - it is never returned to the client.

- [ ] **Step 4: View model + UI**

`src/server/administration/service.ts`: in the accounts branch of `listAdministration`, add `resetMailConfigured: loadResetMailConfig().mode === "smtp"` and `currentUserId: principal.userId` to the returned `AdministrationAccountsViewModel`; update the type. Wrap the loader call in try/catch falling back to `false` so a malformed seam blocks readiness (Task 2) without breaking the page render... actually prefer honest failure: let a malformed config throw only at readiness; here catch and set `false` with a `console.error`. Choose the catch-and-false path and document why in a comment (page render must not crash on config the readiness surface already reports).

`src/components/admin/account-password-reset.tsx`: `AccountPasswordResetModal` props `{ account: { id, displayName }, currentUserId, resetMailConfigured, onClose, action }`. State machine: `form -> issued(revealUrl | emailedNotice) -> closed`. Reason textarea with min/max hints, delivery radio group (`operator_handoff` default; `email` only when `resetMailConfigured`), self-reset warning when `account.id === currentUserId`. Reveal panel: read-only input with the full URL, expiry text, a Copy button (`navigator.clipboard.writeText` with fallback select), and copy stating it is shown exactly once. Rendered via the existing `Modal` component.

`src/components/admin/accounts-section.tsx`: add a "Reset password" button per row inside the existing `{!phoneSafetyMode ? ...}` mutation blocks for BOTH the desktop table and the mobile card copies; modal state is a single `resetTargetId: string | null` shared across copies (same lesson as the role editor: state keyed by account id, not per-copy).

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
npx vitest run src/server/actions src/components/admin src/server/administration && npm run typecheck
git add src/server/actions/administration-actions.ts src/server/actions/password-reset-actions.ts src/server/administration/service.ts src/components/admin/account-password-reset.tsx src/components/admin/accounts-section.tsx src/components/admin/account-password-reset.test.tsx src/server/actions/actions.test.ts
git commit -m "feat(admin): wire password reset into accounts administration UI"
```

### Task 13: Operator documentation

**Files:**
- Modify: `docs/operators/no-mail-profile.md`
- Create: `docs/operators/password-reset.md`

- [ ] **Step 1: Update the no-mail profile doc**

In `docs/operators/no-mail-profile.md`: add a "Scoped exception: password reset" section stating the captain-approved carve-out (reset path only; one transactional template; absent by default), the `SUPERSCRIBER_RESET_MAIL_*` env surface, and amend the verification grep to exclude the reset-mail seam:

```bash
grep -ri "smtp\|nodemailer\|sendmail" package.json src app --include="*.ts" --include="*.tsx" \
  | grep -v "no-mail\|reset-mail\|password_reset" || echo "no mail surfaces"
```

- [ ] **Step 2: Write the operator doc**

`docs/operators/password-reset.md` contents:
- Overview of both flows and the precedence rule (admin issuance invalidates self-service tokens and retires sessions immediately).
- Self-service UX contract: identical anti-enumeration response; mail-configured vs operator-assisted behavior.
- Configuration: full env table (exact names from Global Constraints), secret-file convention, base URL guidance, restart requirement.
- Break-glass boundary: designee resets are denied; rotation via the emergency ceremony only.
- Audit trail: the five security event types and the `account.password_reset` governance event; where they surface.
- Rate limits and abuse notes (per-email budget burn trade-off).
- Recovery playbook: user locked out with mail unconfigured -> admin > Accounts > Reset password > out-of-band handoff.

- [ ] **Step 3: Commit**

```bash
git add docs/operators/no-mail-profile.md docs/operators/password-reset.md
git commit -m "docs(operators): document password reset flows and the scoped reset-mail seam"
```

### Task 14: E2E - fake-SMTP sidecar, appliance wiring, reset specs

**Files:**
- Create: `e2e/support/fake-smtp.ts`
- Create: `scripts/fake-smtp-sidecar-entry.ts`
- Modify: `scripts/run-e2e-appliance.sh`
- Create: `e2e/password-reset.spec.ts` (default appliance: mail unconfigured)
- Create: `e2e/password-reset-mail.spec.ts` (runs only when `SUPERSCRIBER_E2E_RESET_MAIL=smtp`)
- Modify: `.github/workflows/container-e2e.yml` (second job/step running the mail spec with the knob)

**Interfaces:**
- Produces: `E2E_SMTP_PORT` (default 4205), `E2E_SMTP_CONTROL_PORT` (default 4206), `smtpControl(baseUrl: string): { messages(): Promise<Array<{ from: string; to: string[]; subject: string; text: string }>>; reset(): Promise<void> }`.
- Appliance env knob: `SUPERSCRIBER_E2E_RESET_MAIL=smtp` starts the sidecar and configures the app seam; default (unset) leaves the seam off, matching the product default.

- [ ] **Step 1: Fake SMTP + control channel**

`e2e/support/fake-smtp.ts`: a `node:net` SMTP server accepting EHLO/HELO, `AUTH PLAIN` (accept any credentials), `MAIL FROM`, `RCPT TO` (collect), `DATA` until `\r\n.\r\n`, `RSET`, `QUIT`; each completed DATA capture parses the `Subject:` header and the body after the first blank line. An `node:http` control server on the control port exposes `GET /messages` (JSON array) and `POST /reset` (clears). Export `startFakeSmtpServers(smtpPort, controlPort)` returning `{ smtpPort, controlPort }` and the `smtpControl(baseUrl)` client (same fetch style as `oidcControl` in `fake-oidc.ts`). Keep the SMTP parser line-oriented and tolerant; tests own determinism by waiting on the control endpoint.

`scripts/fake-smtp-sidecar-entry.ts` (mirrors `fake-oidc-sidecar-entry.ts`):

```ts
import { startFakeSmtpServers } from "../e2e/support/fake-smtp";

const smtpPort = Number(process.argv[2] ?? 4205);
const controlPort = Number(process.argv[3] ?? 4206);
startFakeSmtpServers(smtpPort, controlPort);
console.log(`fake smtp on ${smtpPort}, control on ${controlPort}`);
```

- [ ] **Step 2: Wire the appliance runner**

In `scripts/run-e2e-appliance.sh`, alongside the OIDC block, gated on `SUPERSCRIBER_E2E_RESET_MAIL=smtp`:
- `SMTP_PORT="${SUPERSCRIBER_E2E_SMTP_PORT:-4205}"`, `SMTP_CONTROL_PORT="${SUPERSCRIBER_E2E_SMTP_CONTROL_PORT:-4206}"`, `SMTP_SIDECAR="${CONTAINER_NAME}-smtp"`.
- Preflight: refuse to start if something already answers on `http://127.0.0.1:${SMTP_CONTROL_PORT}/messages` (same `http_probe.py` pattern as the OIDC port check).
- `printf 'fake-smtp-password\n' > "${OIDC_DIR}/reset-mail-password"`.
- App container additions (only when the knob is set): `--publish "${SMTP_PORT}:4205"`, `--publish "${SMTP_CONTROL_PORT}:4206"`, and envs:

```
SUPERSCRIBER_RESET_MAIL_MODE=smtp
SUPERSCRIBER_RESET_MAIL_SMTP_HOST=127.0.0.1
SUPERSCRIBER_RESET_MAIL_SMTP_PORT=4205
SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS=reset@superscriber.test
SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE=/run/oidc/reset-mail-password
SUPERSCRIBER_RESET_MAIL_BASE_URL=${APP_URL}
```

- Sidecar: esbuild-bundle `scripts/fake-smtp-sidecar-entry.ts` to `"${OIDC_DIR}/fake-smtp-sidecar.mjs"` and `docker run --detach --rm --name "${SMTP_SIDECAR}" --network "container:${CONTAINER_NAME}" --entrypoint node --volume ... "${IMAGE}" /fake-smtp-sidecar.mjs 4205 4206`, then probe the control endpoint like the OIDC sidecar. Add the sidecar to the cleanup `docker rm -f` list.
- Export `SUPERSCRIBER_E2E_RESET_MAIL` into the playwright invocation (it runs on the host and needs the flag plus `SUPERSCRIBER_E2E_SMTP_CONTROL_PORT`).

- [ ] **Step 3: Default-appliance spec (mail unconfigured)**

`e2e/password-reset.spec.ts` - runs in the standard suite. Use `bootstrapAndLogin`, `login`, `queryRuntimeRows`, `execRuntimeSql` from `e2e/support/appliance.ts`. Cases:

```ts
test("self-service request answers identically for known and unknown emails", async ({ page }) => {
  await bootstrapAndLogin(page, adminUser); // creates accounts, then sign out
  // capture both responses:
  for (const email of [adminUser.email, "ghost@example.com"]) {
    await page.goto("/reset-request");
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole("button", { name: /reset/i }).click();
    await expect(
      page.getByText("If an account matches that email, a password reset has been started. If nothing arrives, contact your administrator."),
    ).toBeVisible();
  }
  // no tokens issued while the seam is unconfigured:
  expect(queryRuntimeRows(`SELECT * FROM password_reset_tokens`, [])).toHaveLength(0);
});

test("operator-assisted flow: admin handoff link resets the password and revokes sessions", async ({ page }) => {
  // admin creates/logs in a reviewer account in a second context holding its session;
  // admin issues a handoff reset from Administration > Accounts with a reason;
  // capture the revealed URL from the modal;
  // open the URL in a fresh context, set a new password;
  // assert: old reviewer session is logged out (reason=session-expired on next nav),
  // DB auth_sessions rows revoked with reason admin_password_reset + password_reset,
  // and sign-in with the NEW password succeeds while the old one fails.
});

test("admin precedence: issuance invalidates an in-flight self-service token", async ({ page }) => {
  // with the seam unconfigured there is no self-service token; instead seed one
  // directly via execRuntimeSql INSERT or via issueResetToken in-process when
  // not containerized... prefer a pure-DB seed of password_reset_tokens with a
  // known sha256('known-token') hash, then assert post-issuance the row is invalidated.
});

test("expired and reused links show the generic failure", async ({ page }) => {
  // complete one reset via the handoff URL; visit the same URL again and submit -> generic failure copy;
  // seed an expired token (expires_at backdated via execRuntimeSql) -> same copy.
});

test("phone viewport hides admin reset controls but self-service stays usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Administration > Accounts: no "Reset password" button; request page + completion render and submit fine.
});

test("admin policies: break-glass designee and inactive targets are denied", async ({ page }) => {
  // designate break-glass via existing e2e helpers/scripts or DB seed of auth_control;
  // attempt reset on the designee row -> typed denial notice; same for a deactivated account.
});
```

Cross-source revocation breadth: seed an `auth_sessions` row with `auth_source = 'break_glass'` for the target via `execRuntimeSql` before the reset and assert it is revoked (no browser ceremony needed). OIDC-source session: if the container runs `dual` with the reviewer linked, sign the reviewer in via `oidcSignIn` first; otherwise a DB-seeded `authentik` row is acceptable - assert both revoked.

- [ ] **Step 4: Mail-configured spec**

`e2e/password-reset-mail.spec.ts`:

```ts
const MAIL_ON = process.env.SUPERSCRIBER_E2E_RESET_MAIL === "smtp";
test.skip(!MAIL_ON, "requires SUPERSCRIBER_E2E_RESET_MAIL=smtp appliance");

test("reset link is emailed; completing it rotates the credential", async ({ page }) => {
  await smtpControl(`http://127.0.0.1:${process.env.SUPERSCRIBER_E2E_SMTP_CONTROL_PORT ?? 4206}`).reset();
  // request a reset for a known local user at /reset-request
  // poll smtpControl(...).messages() until one message to the user arrives
  // assert: exactly one message; subject "Superscriber password reset";
  //         body contains one /reset/<token> URL and the ISO expiry; no other content types
  // extract the URL, complete the reset, sign in with the new password
  // assert the captured body never appears in any later message and no token is logged
});

test("token from the mail is single-use and superseded by a newer request", async ({ page }) => {
  // request twice; use the FIRST link -> generic failure; use the SECOND -> success
});
```

- [ ] **Step 5: CI workflow**

`.github/workflows/container-e2e.yml`: after the existing suite step, add:

```yaml
- name: Container E2E (reset-mail configured)
  run: SUPERSCRIBER_E2E_RESET_MAIL=smtp bash scripts/run-e2e-appliance.sh test e2e/password-reset-mail.spec.ts
```

- [ ] **Step 6: Run the suites**

```bash
npm run e2e:container
SUPERSCRIBER_E2E_RESET_MAIL=smtp bash scripts/run-e2e-appliance.sh test e2e/password-reset-mail.spec.ts
```

- [ ] **Step 7: Commit**

```bash
git add e2e/support/fake-smtp.ts scripts/fake-smtp-sidecar-entry.ts scripts/run-e2e-appliance.sh e2e/password-reset.spec.ts e2e/password-reset-mail.spec.ts .github/workflows/container-e2e.yml
git commit -m "test(e2e): cover password reset flows with fake smtp sidecar"
```

### Task 15: Final validation gate

- [ ] **Step 1: Full gate**

```bash
npm run typecheck
npm test
npm run build
npm run worker:check
npm run e2e:container
SUPERSCRIBER_E2E_RESET_MAIL=smtp bash scripts/run-e2e-appliance.sh test e2e/password-reset-mail.spec.ts
```

- [ ] **Step 2: Spec cross-check**

Re-read `docs/superpowers/specs/2026-08-09-password-reset-design.md` sections 3-9 and verify every contract line maps to shipped code: mail seam gating, token mechanics (hash, TTL, single-use, supersession), completion/issuance transactions and their asymmetry, eligibility exclusions, anti-enumeration copy, admin denials, rate budgets, event types, phone safety, and the audit event. Fix any drift in code, not in the spec (the spec is captain-approved).

- [ ] **Step 3: Commit any fixes**

```bash
git commit -am "test: align implementation with approved password reset spec"
```

---

## Self-review notes (plan author)

Checked before commit: every spec section maps to at least one task (mail seam -> 2/3/6/12/13/14; tokens -> 1/5; self-service -> 6/7/8/9; admin -> 10/11/12; anti-enumeration -> 6/7; rate limits -> 4/6/8; phone safety -> 12/14; events -> 6/8/11/12; docs -> 13; E2E matrix -> 14). All names used across tasks (`issueResetToken`, `loadRedeemableToken`, `markResetTokenUsed`, `invalidateUserResetTokens`, `completePasswordReset`, `requestPasswordReset`, `buildResetUrl`, `requestPasswordResetAction`, `completePasswordResetAction`, `adminIssuePasswordReset`, `adminResetAccountPasswordAction`, `revalidateAdminActor`, `PASSWORD_RESET_COPY`, `PASSWORD_RESET_ADMIN_COPY`, `adminPasswordResetInputSchema`, `loadResetMailConfig`, `sendPasswordResetEmail`, `buildResetMailMessage`, `smtpControl`) are defined in exactly one task with consistent signatures. The remaining pseudo-seams in Tasks 11/12 carry explicit implementer resolution notes (retireUserSessions return destructuring, ensureAuditWorkspace export, requestContext export) rather than open TODOs.
