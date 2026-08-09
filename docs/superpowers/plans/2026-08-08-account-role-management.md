# Account Role Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship inline, governed account-role editing that is keyboard-accessible on tablet and desktop, read-only on phones, and atomically enforces role, audit, authorization-version, session, break-glass, final-admin, assignment, and OIDC invariants.

**Architecture:** A shared client contract and focused `AccountRoleEditor` feed one typed administration server action. The action delegates to a real-SQLite service that acquires an immediate write reservation, re-authorizes the actor, rechecks every invariant, and commits the role update, session retirement, audit event, and state-version increment as one operation. Schema v8 triggers defend final-admin and active-assignment consistency against alternate writers, while the administration read model provides non-authoritative guidance.

**Tech Stack:** Next.js 16 server actions, React 19, TypeScript 6, Zod 4, Drizzle ORM, better-sqlite3, Vitest, Testing Library, Playwright, Auth.js session registry, SQLite migrations and triggers.

## Global Constraints

- Implement the approved design at `docs/superpowers/specs/2026-08-08-account-role-management-design.md` without reopening its product choices.
- Use `users.role` as authority for local and OIDC-linked identities; never mutate Authentik groups, the mounted role map, or `external_identities` during a role change.
- Require a trimmed change reason of 10 to 500 characters and reject unknown request keys.
- Re-authorize an active admin inside the immediate database transaction; client controls and viewport state are never authority boundaries.
- A successful operation must use one timestamp and atomically update the role, increment `auth_version` exactly once, revoke all active target sessions, insert one `account.role_changed` audit event, and increment `app_state_meta.state_version`.
- Self-demotion is allowed only when another active administrator remains; the designated break-glass administrator cannot be demoted.
- Active assignment snapshots must equal the requested role; completed and removed assignments never block.
- Phone safety mode renders account and emergency-access facts but no role, account-creation, assignment, designation, key-enrollment, or recovery-code mutation controls.
- Do not change or assert the separate appearance-rendering defect.
- Do not modify `CHANGELOG.md`; shipping metadata remains owned by the later no-mistakes delivery workflow.

---

## File map

**Create**

- `src/lib/account-role-management.ts` - shared strict request schema, error/result payloads, reason limits, and exact safe copy.
- `src/lib/account-role-management.test.ts` - boundary tests for strict shape, roles, no-op rejection, trimming, and reason lengths.
- `src/server/administration/account-role-service.ts` - immediate transactional role command, typed errors, assignment blocker summary, denial diagnostics, and unexpected-failure correlation.
- `src/server/administration/account-role-service.test.ts` - real-SQLite service, protection, concurrency, audit, session, OIDC, and rollback coverage.
- `src/server/db/transaction.test.ts` - immediate governed transaction commit and rollback behavior.
- `src/components/admin/account-role-editor.tsx` - controlled, presentation-specific inline form and accessible semantics.
- `src/components/admin/account-role-editor.test.tsx` - editor rendering, keyboard, validation, pending, and error semantics.
- `e2e/account-role-management.spec.ts` - end-user role management, protection, revocation, rollback, focus, pending, concurrency, and phone tests.

**Modify**

- `src/domain/models.ts` - add `account.role_changed` to the canonical audit event union.
- `src/server/db/migrations.ts` - schema v8 triggers for final admin and assignment-role agreement.
- `src/server/db/migrations.test.ts` - v8 install, rerun, direct-writer guards, repair, and foreign-key coverage.
- `src/server/db/upgrade-rehearsal.test.ts` - include v8 in staged production-shaped upgrade and rollback rehearsal.
- `src/server/db/transaction.ts` - add `runImmediateGovernedTransaction` while preserving the existing API.
- `src/server/auth/session-registry.ts` - allow role service to revoke sessions with the transaction's timestamp.
- `src/server/auth/session-registry.test.ts` - exact-time revocation compatibility and unchanged existing behavior.
- `src/server/access/service.ts` - reload assignee role inside an immediate assignment transaction.
- `src/server/access/service.test.ts` - assignment creation sees current role and cannot commit a mismatch.
- `src/server/administration/service.ts` - add role-management guidance facts to every account row.
- `src/server/administration/service.test.ts` - guidance facts for assignments, OIDC links, break-glass designation, inactive rows, and sole admins.
- `src/server/actions/administration-actions.ts` - add the typed role-change action with safe revalidation behavior.
- `src/server/actions/actions.test.ts` - action auth, strict validation, typed failures, actor sourcing, and committed-success coverage.
- `src/components/admin/accounts-section.tsx` - shared per-user editor state, action orchestration, local row reconciliation, focus, and phone transitions.
- `src/components/admin/accounts-section.test.tsx` - table/card shared state, pending/error/retry, focus, stale state, success, self-change, and phone coverage.
- `src/components/admin/administration-shell.tsx` - pass phone safety state into emergency access.
- `src/components/admin/administration-shell.test.tsx` - verify phone state reaches Accounts and break-glass components.
- `src/components/admin/break-glass-panel.tsx` - omit all emergency-access mutations in phone safety mode.
- `src/components/admin/break-glass-panel.test.tsx` - phone facts-only coverage for designated and undesignated states.
- `src/styles/administration.css` - compact inline editor, guidance, alert, and pending layout.
- `src/styles/responsive.css` - tablet/card reflow and narrow supported-surface control stacking.
- `app/page.tsx` - role-changed sign-in notice.
- `e2e/support/appliance.ts` - export account creation and add focused account/audit/session database helpers.
- `e2e/oidc.spec.ts` - prove old-group denial and new-group admission after a linked account role change.
- `e2e/accessibility.spec.ts` - axe coverage for the dirty inline role editor.
- `DESIGN.md` - replace the obsolete statement that role changes are not rendered and document the atomic role contract.
- `README.md` - describe role editing, forced re-login, and phone behavior.
- `docs/operators/authentik-oidc.md` - document the exact group-first then local-role coordination procedure.
- `docs/operators/break-glass.md` - document transfer-before-demotion recovery.
- `src/server/auth/operator-docs.test.ts` - assert the new role-coordination and break-glass instructions remain present.

---

### Task 1: Capture the browser regression first and lock the shared contract

**Files:**
- Create transiently, then remove: `e2e/account-role-management.repro.spec.ts`
- Create: `src/lib/account-role-management.ts`
- Create: `src/lib/account-role-management.test.ts`

**Interfaces:**
- Consumes: `USER_ROLES` and `UserRole` from `src/domain/models.ts`.
- Produces: `ChangeAccountRoleInput`, `changeAccountRoleInputSchema`, `AccountRoleChangeErrorCode`, `AssignmentBlockers`, `AccountRoleChangeFailure`, `ACCOUNT_ROLE_CHANGE_COPY`, `CHANGE_REASON_MIN`, and `CHANGE_REASON_MAX`.

- [ ] **Step 1: Write an end-user-aligned failing browser reproduction before any product implementation**

Create `e2e/account-role-management.repro.spec.ts` with the desired first interaction:

```ts
import { expect, test } from "@playwright/test";
import { adminUser, bootstrapAndLogin } from "./support/appliance";

test("an administrator can start an inline role change from an account row", async ({ page }) => {
  await bootstrapAndLogin(page, adminUser);
  await page.goto("/administration?section=accounts");

  const row = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: adminUser.email }),
  });
  const role = row.getByRole("combobox", { name: `Role for ${adminUser.displayName}` });

  await expect(role).toHaveValue("admin");
  await role.selectOption("reviewer");
  await expect(row.getByRole("textbox", { name: `Change reason for ${adminUser.displayName}` })).toBeVisible();
  await expect(row.getByRole("button", { name: "Save role" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Cancel" })).toBeVisible();
});
```

- [ ] **Step 2: Run the container-backed reproduction and verify the current product fails at the missing combobox**

Run:

```bash
npm run e2e:container -- e2e/account-role-management.repro.spec.ts
```

Expected: FAIL because the current role cell is text and no `Role for E2E Admin` combobox exists. Save the failure output in the task notes, then remove only the transient repro file:

```bash
rm e2e/account-role-management.repro.spec.ts
```

- [ ] **Step 3: Write strict shared-contract unit tests**

Create tests with these exact cases:

```ts
import { describe, expect, it } from "vitest";
import {
  CHANGE_REASON_MAX,
  CHANGE_REASON_MIN,
  changeAccountRoleInputSchema,
} from "./account-role-management";

const valid = {
  userId: "user-1",
  expectedRole: "reviewer",
  newRole: "approver",
  reason: "Role duties changed.",
} as const;

describe("changeAccountRoleInputSchema", () => {
  it("trims and accepts a valid role change", () => {
    expect(changeAccountRoleInputSchema.parse({ ...valid, reason: "  Role duties changed.  " })).toEqual(valid);
  });

  it.each([
    { input: { ...valid, reason: "x".repeat(CHANGE_REASON_MIN - 1) }, field: "reason" },
    { input: { ...valid, reason: "x".repeat(CHANGE_REASON_MAX + 1) }, field: "reason" },
    { input: { ...valid, newRole: "owner" }, field: "newRole" },
    { input: { ...valid, newRole: "reviewer" }, field: "newRole" },
    { input: { ...valid, extraAuthority: "admin" }, field: null },
  ])("rejects $input", ({ input, field }) => {
    const result = changeAccountRoleInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success && field) {
      expect(result.error.flatten().fieldErrors).toHaveProperty(field);
    }
  });
});
```

- [ ] **Step 4: Run the contract tests and verify they fail because the module does not exist**

Run:

```bash
npm test -- src/lib/account-role-management.test.ts
```

Expected: FAIL with module resolution failure for `./account-role-management`.

- [ ] **Step 5: Implement the shared schema and typed payloads**

Create the module with these exact public shapes and exact safe copy from the design:

```ts
import { z } from "zod";
import { USER_ROLES, type UserRole } from "@/domain/models";

export const CHANGE_REASON_MIN = 10;
export const CHANGE_REASON_MAX = 500;

export const changeAccountRoleInputSchema = z
  .object({
    userId: z.string().trim().min(1, "Choose an account."),
    expectedRole: z.enum(USER_ROLES),
    newRole: z.enum(USER_ROLES),
    reason: z
      .string()
      .trim()
      .min(CHANGE_REASON_MIN, "Enter a change reason between 10 and 500 characters.")
      .max(CHANGE_REASON_MAX, "Enter a change reason between 10 and 500 characters."),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expectedRole === value.newRole) {
      context.addIssue({
        code: "custom",
        path: ["newRole"],
        message: "Choose a role different from the current role.",
      });
    }
  });

export type ChangeAccountRoleInput = z.infer<typeof changeAccountRoleInputSchema>;

export type AccountRoleChangeErrorCode =
  | "AUTH_EXPIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "STATE_CHANGED"
  | "BREAK_GLASS_PROTECTED"
  | "LAST_ACTIVE_ADMIN"
  | "ASSIGNMENTS_INCOMPATIBLE"
  | "INTERNAL_ERROR";

export type AssignmentBlockers = {
  total: number;
  byRole: Array<{
    role: "reviewer" | "approver";
    count: number;
    recordingTitles: string[];
  }>;
  managementHref: string;
};

export type AccountRoleChangeFailure = {
  code: AccountRoleChangeErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
  currentRole?: UserRole;
  assignmentBlockers?: AssignmentBlockers;
  correlationId?: string;
};
```

Also export the exact safe copy so client and server cannot drift:

```ts
export const ACCOUNT_ROLE_CHANGE_COPY = {
  AUTH_EXPIRED: "Session expired. Sign in again to continue.",
  ACCESS_DENIED: "Only active administrator accounts can change account roles.",
  NOT_FOUND: "This account is no longer available. Refresh the account list.",
  VALIDATION_ERROR: "Enter a change reason between 10 and 500 characters.",
  STATE_CHANGED: "This account's role changed after the list loaded. Review the current role and try again.",
  BREAK_GLASS_PROTECTED: "This account is the designated break-glass administrator. Transfer the designation before changing its role.",
  LAST_ACTIVE_ADMIN: "At least one active administrator must remain. Promote another active account to Administrator before changing this role.",
  INTERNAL_ERROR: "The role change could not be confirmed. Refresh the account list before trying again.",
} as const;

export function assignmentsIncompatibleMessage(newRoleLabel: string) {
  return `Remove the listed active assignments before changing this account to ${newRoleLabel}.`;
}
```


- [ ] **Step 6: Run the contract test, typecheck the module, and commit**

Run:

```bash
npm test -- src/lib/account-role-management.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/lib/account-role-management.ts src/lib/account-role-management.test.ts
git commit -m "feat: define account role change contract"
```

---

### Task 2: Add schema v8 defenses and immediate governed transactions

**Files:**
- Modify: `src/server/db/migrations.ts`
- Modify: `src/server/db/migrations.test.ts`
- Modify: `src/server/db/upgrade-rehearsal.test.ts`
- Modify: `src/server/db/transaction.ts`
- Create: `src/server/db/transaction.test.ts`

**Interfaces:**
- Consumes: existing `AppDatabaseBundle`, `appStateMeta`, v6 break-glass triggers, and v7 schema.
- Produces: `LATEST_SCHEMA_VERSION = 8`, four role/assignment guard triggers, and `runImmediateGovernedTransaction<T>(operation, bundle)`.

- [ ] **Step 1: Write migration tests for install, rerun, direct-writer rejection, and repair**

Update expected versions to include `{ version: 8 }`. Create a populated v7 database with `runMigrations(sqlite, 7)`, seed two active admins plus reviewer and approver assignment rows, run the v8 migration, then assert:

```ts
expect(() =>
  sqlite.prepare("update users set role = 'reviewer' where id = 'only-admin'").run(),
).toThrow(/at least one active administrator must remain/);

expect(() =>
  sqlite.prepare("update users set role = 'uploader' where id = 'assigned-reviewer'").run(),
).toThrow(/active assignments must match the user's role/);

expect(() =>
  sqlite.prepare(
    "insert into recording_assignments (id, recording_id, user_id, assigned_by_user_id, assignment_role, status, is_active, created_at, updated_at) values (?, ?, ?, ?, 'approver', 'active', 1, ?, ?)",
  ).run("bad-assignment", "rec-1", "assigned-reviewer", "admin-2", NOW, NOW),
).toThrow(/active assignment role must match the assigned user's role/);
```

Cover update-based activation as well as insert, completed/removed history acceptance, and repair of a pre-v8 inconsistent user by moving its role toward its active snapshot. End with `PRAGMA foreign_key_check` equal to `[]` and assert rerunning migrations does not duplicate trigger definitions or schema versions.

- [ ] **Step 2: Write immediate transaction tests**

Create `src/server/db/transaction.test.ts` with a real file-backed database so a second better-sqlite3 connection can observe the write reservation. Assert successful result and one state-version increment, then inject an `app_state_meta` abort trigger and assert the operation write and state-version write both roll back.

Use this signature in the test before implementation:

```ts
const result = runImmediateGovernedTransaction((db, now) => {
  db.update(users).set({ displayName: "Changed", updatedAt: now }).where(eq(users.id, "user-1")).run();
  return now;
}, bundle);
```

- [ ] **Step 3: Run focused tests and verify the missing v8 and immediate API failures**

Run:

```bash
npm test -- src/server/db/migrations.test.ts src/server/db/upgrade-rehearsal.test.ts src/server/db/transaction.test.ts
```

Expected: FAIL because v8 and `runImmediateGovernedTransaction` do not exist.

- [ ] **Step 4: Implement migration v8 triggers**

Add migration entry `{ version: 8, name: "account-role-guards", up: addAccountRoleGuards }` and define the trigger function with these predicates:

```sql
CREATE TRIGGER IF NOT EXISTS users_last_active_admin_role_guard
BEFORE UPDATE OF role ON users
WHEN OLD.role = 'admin'
  AND OLD.is_active = 1
  AND NEW.role != 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE id != OLD.id AND role = 'admin' AND is_active = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'at least one active administrator must remain');
END;

CREATE TRIGGER IF NOT EXISTS users_active_assignment_role_guard
BEFORE UPDATE OF role ON users
WHEN EXISTS (
  SELECT 1 FROM recording_assignments
  WHERE user_id = OLD.id
    AND status = 'active'
    AND assignment_role != NEW.role
)
BEGIN
  SELECT RAISE(ABORT, 'active assignments must match the user''s role');
END;
```

Add `recording_assignments_role_guard_insert` and `recording_assignments_role_guard_update` using `NEW.status = 'active'` and an existence check for `users.id = NEW.user_id AND users.role = NEW.assignment_role AND users.role IN ('reviewer', 'approver')`. The update trigger must cover `user_id`, `assignment_role`, and `status`.

- [ ] **Step 5: Implement the immediate transaction variant without changing existing callers**

Refactor the common body and invoke better-sqlite3's immediate mode exactly once:

```ts
function governedBody<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle: AppDatabaseBundle,
) {
  const result = operation(bundle.db, new Date().toISOString());
  const versionUpdate = bundle.db
    .update(appStateMeta)
    .set({ stateVersion: sql`${appStateMeta.stateVersion} + 1` })
    .where(eq(appStateMeta.id, 1))
    .run();
  if (versionUpdate.changes !== 1) {
    throw new Error("Governed transaction could not advance the application state version.");
  }
  return result;
}

export function runImmediateGovernedTransaction<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): T {
  return bundle.sqlite.transaction(() => governedBody(operation, bundle)).immediate();
}
```

Keep `runGovernedTransaction` behavior and signature unchanged.

- [ ] **Step 6: Extend the upgrade rehearsal through v8**

Change the stage list to `[3, 4, 5, 6, 7, 8]`, expected versions to `[1, 2, 3, 4, 5, 6, 7, 8]`, and retain every user ID, reference count, audit count, backup, and foreign-key assertion.

- [ ] **Step 7: Run database tests and commit**

Run:

```bash
npm test -- src/server/db/migrations.test.ts src/server/db/upgrade-rehearsal.test.ts src/server/db/identity-contract.test.ts src/server/db/transaction.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/server/db/migrations.ts src/server/db/migrations.test.ts src/server/db/upgrade-rehearsal.test.ts src/server/db/transaction.ts src/server/db/transaction.test.ts
git commit -m "feat: guard account role invariants in sqlite"
```

---

### Task 3: Implement the atomic account-role service

**Files:**
- Create: `src/server/administration/account-role-service.ts`
- Create: `src/server/administration/account-role-service.test.ts`
- Modify: `src/domain/models.ts`
- Modify: `src/server/auth/session-registry.ts`
- Modify: `src/server/auth/session-registry.test.ts`

**Interfaces:**
- Consumes: `ChangeAccountRoleInput`, `AccountRoleChangeFailure`, `AppDatabaseBundle`, `runImmediateGovernedTransaction`, `insertAuditEvent`, `recordSecurityEvent`, `revokeUserSessions`, and the users/session/assignment/workspace tables.
- Produces: `changeAccountRole(params, bundle): ChangeAccountRoleServiceSuccess` and `AccountRoleChangeServiceError`.

Define the public service contract exactly:

```ts
export type ChangeAccountRoleServiceSuccess = {
  user: AccountDirectoryEntry;
  oldRole: UserRole;
  newRole: UserRole;
  revokedSessionCount: number;
  actorMustRelogin: boolean;
  resultingAuthVersion: number;
};

export function changeAccountRole(
  params: { actorUserId: string; input: ChangeAccountRoleInput },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): ChangeAccountRoleServiceSuccess;
```

- [ ] **Step 1: Write the real-database happy-path, audit, session, and OIDC preservation tests**

Build a fixture with one workspace, two admins, a local target, an active OIDC link for that target, and active `local`, `authentik`, and `break_glass` session rows. The success test must assert:

```ts
expect(result).toMatchObject({
  oldRole: "reviewer",
  newRole: "approver",
  revokedSessionCount: 3,
  actorMustRelogin: false,
  resultingAuthVersion: 2,
});
expect(targetRow).toMatchObject({ role: "approver", authVersion: 2 });
expect(activeSessions).toEqual([]);
expect(revokedSessions.every((row) => row.revokedReason === "account_role_changed")).toBe(true);
expect(identityLink).toEqual(identityLinkBefore);
expect(stateVersion).toBe(stateVersionBefore + 1);
```

Parse the one `account.role_changed` audit row and assert actor ID/name/role, target ID/name, old role, new role, trimmed reason, resulting auth version, revoked count, `recording_id = null`, and one shared `created_at` timestamp. Assert the reason is absent from `security_events`.

- [ ] **Step 2: Write rollback injection tests before service implementation**

Install one temporary trigger that aborts `account.role_changed` audit insertion and another test trigger that aborts an auth-session update where `NEW.revoked_reason = 'account_role_changed'`. For each failure, snapshot role, auth version, sessions, audit count, security-event count, and state version, invoke the service, and assert every snapshot is unchanged.

Add a third state-version abort test. Also assert stale `expectedRole` and a zero-row compare-and-set commit no governed role, auth-version, session, success-audit, or state-version writes; the redacted post-rollback denial diagnostic is the only permitted write.

- [ ] **Step 3: Run the service test and verify it fails because the service does not exist**

Run:

```bash
npm test -- src/server/administration/account-role-service.test.ts
```

Expected: FAIL with module resolution failure.

- [ ] **Step 4: Add the canonical audit type and timestamp-aware session revocation**

Add `"account.role_changed"` to `AuditEvent["type"]`.

Extend the existing revocation options without breaking callers. Change the function signature and replace its local clock line with this exact block, leaving the current active-row selection, updates, and best-effort event loop after it unchanged:

```ts
export function revokeUserSessions(
  userId: string,
  reason: string,
  db: AppDatabase = getAppDb(),
  options: { exceptSessionId?: string; now?: Date } = {},
): number {
  const now = options.now ?? new Date();
```

Add a session-registry test that passes a fixed `Date` and verifies every revoked row and event uses it. Retain all existing session tests.

- [ ] **Step 5: Implement typed failures and denial recording**

Create `AccountRoleChangeServiceError` that carries one `AccountRoleChangeFailure`. Expected denials must be thrown inside the immediate transaction so every write rolls back, caught outside, and followed by a best-effort redacted event:

```ts
recordSecurityEvent({
  type: "account.role_change.denied",
  outcome: "denied",
  userId: params.actorUserId,
  detail: "Account role change denied.",
  metadata: { targetUserId: params.input.userId, denialCode: failure.code },
}, bundle.db);
```

Never include display name, email, reason, session ID, OIDC subject, claims, or groups. If diagnostic recording fails, rethrow the original typed denial unchanged.

For an unexpected exception, generate one correlation ID, log only `{ correlationId, actorUserId, targetUserId, stage }`, and throw `INTERNAL_ERROR` with: `The role change could not be confirmed. Refresh the account list before trying again.`

- [ ] **Step 6: Implement the exact immediate transaction sequence**

Inside `runImmediateGovernedTransaction`, set `stage` before each operation and perform, in order:

1. Parse the input again with `changeAccountRoleInputSchema`.
2. Reload the actor and require active `admin`.
3. Reload target and compare its role with `expectedRole`.
4. Read `auth_control` and reject a non-admin role for its designee.
5. When demoting an active admin, count other active admins and reject zero.
6. Join active target assignments to recordings, reject every snapshot not equal to `newRole`, group in reviewer then approver order, sort titles, cap displayed titles at three per role, and build `/administration?section=assignments&status=active&userId=${encodeURIComponent(target.id)}`.
7. Resolve the single workspace; fail closed if absent.
8. Conditionally update `users.id` and `users.role = expectedRole`, setting role, `authVersion + 1`, and `updatedAt = now`; zero changes becomes `STATE_CHANGED`.
9. Call `revokeUserSessions(target.id, "account_role_changed", db, { now: new Date(now) })` with no session exemption.
10. Insert one canonical audit row with actor snapshot `admin`, target facts, reason, resulting auth version, and revoked count.
11. Return the refreshed `AccountDirectoryEntry`; the transaction helper increments state version and commits.

Use this audit metadata shape exactly:

```ts
metadata: {
  targetUserId: target.id,
  targetDisplayName: target.displayName,
  oldRole: target.role,
  newRole: parsed.newRole,
  reason: parsed.reason,
  resultingAuthVersion,
  revokedSessionCount,
}
```

- [ ] **Step 7: Add service tests for every server rule and concurrency outcome**

Add named tests for:

- inactive, missing, non-admin, and stale-role actors;
- missing target and strict/no-op/invalid input;
- successful changes for active and inactive targets, including inactive admin demotion without applying the active-admin minimum;
- self-demotion with another active admin and actor audit snapshot remaining `admin`;
- self and other-target final-admin rejection with no governed writes beyond the redacted post-rollback denial diagnostic;
- two stale final-admin demotions producing one success and one `LAST_ACTIVE_ADMIN`;
- break-glass rejection, followed by designation transfer and successful old-custodian change;
- reviewer and approver active assignment mismatch to every incompatible role;
- compatible active snapshots and completed/removed history;
- blocker total, per-role counts, three-title cap, deterministic order, and complete management link;
- two requests with one `expectedRole` yielding one success and one `STATE_CHANGED`;
- exactly one auth-version increment and all auth-source session rows revoked;
- no reason or identity data in denial events;
- diagnostic-event failure not changing the typed denial;
- unexpected error safe correlation and stage logging.

- [ ] **Step 8: Run focused service and registry tests and commit**

Run:

```bash
npm test -- src/server/administration/account-role-service.test.ts src/server/auth/session-registry.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/domain/models.ts src/server/auth/session-registry.ts src/server/auth/session-registry.test.ts src/server/administration/account-role-service.ts src/server/administration/account-role-service.test.ts
git commit -m "feat: change account roles atomically"
```

---

### Task 4: Close the assignment race and enrich the account read model

**Files:**
- Modify: `src/server/access/service.ts`
- Modify: `src/server/access/service.test.ts`
- Modify: `src/server/administration/service.ts`
- Modify: `src/server/administration/service.test.ts`

**Interfaces:**
- Consumes: schema v8 assignment triggers and `runImmediateGovernedTransaction`.
- Produces: assignment creation that derives the current role under the write reservation, plus `AccountRoleManagementFacts` on every administration account row.

- [ ] **Step 1: Write assignment freshness and mismatch tests**

Add tests proving that changing the assignee role before `assignRecordingToUser` makes the operation use the new reviewer/approver role, while uploader/admin targets receive the existing `Only reviewer and approver accounts can receive recording assignments.` error. Add a direct trigger test showing an old role snapshot cannot be inserted after a role change.

Assert no assignment or `assignment.created` audit is left after rejection.

- [ ] **Step 2: Run the access tests and verify the stale pre-transaction lookup is exposed**

Run:

```bash
npm test -- src/server/access/service.test.ts
```

Expected: the new freshness test fails until user loading moves inside the transaction.

- [ ] **Step 3: Move assignee loading and role derivation inside an immediate transaction**

Import both transaction helpers with `import { runGovernedTransaction, runImmediateGovernedTransaction } from "@/server/db/transaction";` so removal keeps its existing transaction while assignment creation uses immediate mode. Replace `assignRecordingToUser` with this exact ordering and retain its public signature:

```ts
export function assignRecordingToUser(
  params: { recordingId: string; userId: string; assignedBy: Principal },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): { assignment: RecordingAssignment; alreadyActive: boolean } {
  return runImmediateGovernedTransaction((db, now) => {
    const user = db.select().from(users).where(eq(users.id, params.userId)).get();
    if (!user || !user.isActive) {
      throw new Error("Choose an active user before assigning a recording.");
    }
    if (user.role !== "reviewer" && user.role !== "approver") {
      throw new Error("Only reviewer and approver accounts can receive recording assignments.");
    }
    const assignmentRole: AssignmentRole = user.role;
    const active = findActiveAssignment(db, params.userId, params.recordingId, assignmentRole);
    if (active) {
      return { assignment: toRecordingAssignment(active), alreadyActive: true };
    }

    const recording = getRecordingContextOrThrow(db, params.recordingId);
    assertAssignmentCompatible(recording, assignmentRole);
    const assignment: RecordingAssignment = {
      id: crypto.randomUUID(),
      recordingId: params.recordingId,
      userId: params.userId,
      assignedByUserId: params.assignedBy.userId,
      assignmentRole,
      status: "active",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      endReason: null,
      completedRevisionId: null,
      removedByUserId: null,
    };

    try {
      db.insert(recordingAssignments).values(assignment).run();
    } catch (error) {
      if (!isActiveAssignmentUniqueConstraintError(error)) {
        throw error;
      }
      const raced = findActiveAssignment(db, params.userId, params.recordingId, assignmentRole);
      if (!raced) {
        throw error;
      }
      return { assignment: toRecordingAssignment(raced), alreadyActive: true };
    }

    insertAuditEvent(db, {
      workspaceId: recording.workspaceId,
      recordingId: recording.id,
      actor: actorContextForPrincipal(params.assignedBy),
      type: "assignment.created",
      detail: `Recording assigned to ${user.displayName} as ${assignmentRole}.`,
      metadata: {
        assignmentId: assignment.id,
        assignedUserId: params.userId,
        assignmentRole,
      },
      createdAt: now,
    });
    return { assignment, alreadyActive: false };
  }, bundle);
}
```

Keep removal and completion semantics unchanged. Immediate mode gives assignment creation and role change one total write order; the v8 trigger remains defense in depth.

- [ ] **Step 4: Write read-model tests for every guidance fact**

Define:

```ts
export type AccountRoleManagementFacts = {
  activeAssignments: { reviewer: number; approver: number };
  hasActiveOidcIdentity: boolean;
  isBreakGlassAdministrator: boolean;
  isSoleActiveAdministrator: boolean;
};
```

Extend account-row tests to include local-only, dual/local-plus-link, OIDC-only shadow, active, inactive, designated, sole-admin, multi-admin, reviewer assignment, approver assignment, and historical assignment fixtures. Assert all rows remain returned and search behavior is unchanged.

- [ ] **Step 5: Run the read-model tests and verify missing management facts**

Run:

```bash
npm test -- src/server/administration/service.test.ts
```

Expected: FAIL because account rows lack the four facts.

- [ ] **Step 6: Implement set-based guidance maps and attach facts to rows**

Load active assignment rows once and reduce counts by user and role. Load active `external_identities` once into a user-ID set. Read the break-glass user ID once and count active admins once. Attach the four fields directly to each account row while retaining `activeAssignmentCount`, labels, timestamps, inactive rows, and current ordering.

Do not use these snapshots for service authorization and do not disable Save based on them.

- [ ] **Step 7: Run access/read-model suites and commit**

Run:

```bash
npm test -- src/server/access/service.test.ts src/server/administration/service.test.ts src/server/db/migrations.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/server/access/service.ts src/server/access/service.test.ts src/server/administration/service.ts src/server/administration/service.test.ts
git commit -m "feat: expose account role management facts"
```

---

### Task 5: Add the server action and role-changed sign-in response

**Files:**
- Modify: `src/server/actions/administration-actions.ts`
- Modify: `src/server/actions/actions.test.ts`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `changeAccountRoleInputSchema`, `changeAccountRole`, and `AccountRoleChangeServiceError`.
- Produces: `ChangeAccountRoleActionResult` and `changeAccountRoleAction(input)`.

Use this result shape:

```ts
export type ChangeAccountRoleActionResult =
  | {
      ok: true;
      notice: string;
      data: ChangeAccountRoleServiceSuccess;
    }
  | ({ ok: false } & AccountRoleChangeFailure);
```

- [ ] **Step 1: Write action tests before adding the export**

Mock `changeAccountRole`. Add tests that assert:

- no live principal returns exact `AUTH_EXPIRED`;
- invalid reason, role, no-op, empty ID, and unknown keys never call the service;
- the service receives only `actorUserId` from the live principal plus parsed input;
- a stale principal role of admin is not passed as authority data;
- every typed service failure retains `currentRole`, blockers, field errors, or correlation ID;
- unexpected raw errors return safe `INTERNAL_ERROR` with no SQL/path text;
- successful other-account copy names old/new roles and forced re-login;
- successful self-change returns `actorMustRelogin: true`;
- `/administration` and `/workspace` are revalidated after commit;
- a thrown cache revalidation logs a post-commit warning but still returns success.

- [ ] **Step 2: Run the action tests and verify the missing export failure**

Run:

```bash
npm test -- src/server/actions/actions.test.ts
```

Expected: FAIL because `changeAccountRoleAction` does not exist.

- [ ] **Step 3: Implement the dedicated action boundary**

Do not route role changes through the generic helper that can convert a post-commit revalidation exception into failure. Implement this sequence:

```ts
export async function changeAccountRoleAction(
  input: ChangeAccountRoleInput,
): Promise<ChangeAccountRoleActionResult> {
  const principal = await getActivePrincipal();
  if (!principal) {
    return { ok: false, code: "AUTH_EXPIRED", message: ACCOUNT_ROLE_CHANGE_COPY.AUTH_EXPIRED };
  }

  const parsed = changeAccountRoleInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationFailureFromZod(parsed.error);
  }

  try {
    const data = changeAccountRole({ actorUserId: principal.userId, input: parsed.data });
    try {
      revalidatePath("/administration");
      revalidatePath("/workspace");
    } catch {
      console.error("account role change committed but cache revalidation failed", {
        actorUserId: principal.userId,
        targetUserId: parsed.data.userId,
      });
    }
    return { ok: true, data, notice: roleChangeNotice(data) };
  } catch (error) {
    return accountRoleActionFailure(error, principal.userId, parsed.data.userId);
  }
}
```

Implement `roleChangeNotice` with role labels and the exact other-target sentence:

```ts
function roleChangeNotice(data: ChangeAccountRoleServiceSuccess) {
  return `${data.user.displayName}'s role changed from ${formatRoleLabel(data.oldRole)} to ${formatRoleLabel(data.newRole)}. Active sessions were revoked; they must sign in again.`;
}
```

The unexpected action catch generates/logs a correlation ID only if the service did not already provide one. Never log the reason.

- [ ] **Step 4: Add the self-change landing notice**

Add this branch before the generic no-notice return in `buildNotice`:

```ts
if (reason === "role-changed") {
  return {
    tone: "ok" as const,
    message: "Your account role changed. Sign in again to continue.",
    focusHeading: true,
  };
}
```

- [ ] **Step 5: Run action tests and commit**

Run:

```bash
npm test -- src/server/actions/actions.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/server/actions/administration-actions.ts src/server/actions/actions.test.ts app/page.tsx
git commit -m "feat: expose governed account role action"
```

---

### Task 6: Build the controlled accessible inline editor

**Files:**
- Create: `src/components/admin/account-role-editor.tsx`
- Create: `src/components/admin/account-role-editor.test.tsx`

**Interfaces:**
- Consumes: account row fields, `USER_ROLES`, `AccountRoleChangeFailure`, and role labels.
- Produces: `RoleEditorState`, `emptyRoleEditorState(role)`, and `AccountRoleEditor` as a controlled form.

Use the approved state exactly:

```ts
export type RoleEditorState = {
  selectedRole: UserRole;
  reason: string;
  phase: "persisted" | "dirty" | "pending" | "error";
  fieldError: string | null;
  operationError: AccountRoleChangeFailure | null;
};
```

- [ ] **Step 1: Write editor component tests**

Use a small controlled harness and test both `presentationId="table-user-1"` and `presentationId="card-user-1"`. Assert:

- native select accessible name `Role for Reviewer One`;
- persisted state renders only the select;
- dirty state renders required `Change reason for Reviewer One`, Save role, and Cancel in DOM order;
- OIDC note names the selected role and exact one-group requirement;
- known break-glass, final-admin, and assignment facts render guidance but do not disable Save;
- field errors set `aria-invalid` only on reason and connect with `aria-describedby`;
- operation errors are focusable `role="alert"` and include assignment counts/titles, `and N more`, and `Open active assignments`;
- pending form has `aria-busy`, reads `Saving role...`, and disables select, reason, Save, and Cancel;
- Escape calls Cancel only in dirty/error state, while pending Escape is a no-op;
- Enter from reason invokes one form submit;
- IDs differ by presentation ID.

- [ ] **Step 2: Run the component test and verify the module is missing**

Run:

```bash
npm test -- src/components/admin/account-role-editor.test.tsx
```

Expected: FAIL with module resolution failure.

- [ ] **Step 3: Implement the presentational form**

Define controlled props rather than calling the server action inside the editor:

```ts
export type AccountRoleEditorProps = {
  user: AdministrationAccountsViewModel["users"][number];
  presentationId: string;
  state: RoleEditorState;
  mutationsDisabled: boolean;
  onSelectedRoleChange(role: UserRole): void;
  onReasonChange(reason: string): void;
  onSubmit(): void;
  onCancel(): void;
};
```

The form must use native `<select>`, `<input>`, and `<button>` elements, `noValidate`, and `onSubmit` that prevents default then invokes `onSubmit`. Keep focus on the select after role selection. Add form-level `onKeyDown` for Escape, checking `phase !== "pending"`.

Use unique IDs formed from `presentationId` only, and data attributes `data-account-role-select` plus `data-account-user-id={user.id}` for visible-copy focus lookup without interpolating a user ID into a CSS selector.

- [ ] **Step 4: Run the editor suite and commit**

Run:

```bash
npm test -- src/components/admin/account-role-editor.test.tsx
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/components/admin/account-role-editor.tsx src/components/admin/account-role-editor.test.tsx
git commit -m "feat: add inline account role editor"
```

---

### Task 7: Integrate shared row state, focus, responsive layout, and phone safety

**Files:**
- Modify: `src/components/admin/accounts-section.tsx`
- Modify: `src/components/admin/accounts-section.test.tsx`
- Modify: `src/components/admin/administration-shell.tsx`
- Modify: `src/components/admin/administration-shell.test.tsx`
- Modify: `src/components/admin/break-glass-panel.tsx`
- Modify: `src/components/admin/break-glass-panel.test.tsx`
- Modify: `src/styles/administration.css`
- Modify: `src/styles/responsive.css`

**Interfaces:**
- Consumes: `AccountRoleEditor`, `changeAccountRoleAction`, role-management read facts, and `phoneSafetyMode`.
- Produces: one state record per user ID shared by the table/card copies, visible-copy focus routing, and facts-only phone administration.

- [ ] **Step 1: Expand `AccountsSection` tests before integration**

Inject `changeAccountRoleAction` and a `navigateToSignIn` function as optional props. Add component tests for:

- every model row has two controlled editor copies in jsdom, one table and one card, with unique IDs and shared values;
- selecting another role reveals reason/Save/Cancel in both copies;
- selecting the persisted role or Cancel clears reason/errors and focuses the visible select;
- 9-character reason stays client-side and focuses reason; 10 and 500 submit; 501 does not;
- one pending request despite repeated Enter/click, `Saving role...`, all role selects disabled, Create account disabled, and Cancel disabled;
- pending other-account success updates the local role immediately, announces old/new/re-login, refreshes, and focuses the visible select;
- self success invokes `navigateToSignIn("/?reason=role-changed")` and does not restore row focus;
- field error focuses reason and retains draft;
- break-glass, final-admin, assignment, stale, access-denied, not-found, network, and internal errors follow their specified focus/recovery behavior without losing the reason;
- `NOT_FOUND` refreshes and clears the missing row's editor state so the refreshed model can remove it;
- `ACCESS_DENIED` focuses the alert and prevents retry under the stale session;
- `STATE_CHANGED` refreshes the local persisted role, retains reason when the desired role still differs, and collapses to persisted with a polite announcement when another writer already selected the desired role;
- rejected server-action promises use the same unconfirmed-outcome recovery as `INTERNAL_ERROR`, retain input, and require refresh before retry;
- unknown outcome copy includes only the safe correlation ID when one exists and requires refresh before retry;
- switching to phone safety discards dirty/error draft and renders text facts only;
- switching to phone while pending hides controls but consumes the response and follows the self redirect when applicable.

- [ ] **Step 2: Add phone propagation and emergency-panel tests**

Update shell mocks to capture props and assert both `AccountsSection` and `BreakGlassPanel` receive the same `phoneSafetyMode` value.

Update break-glass tests to call `BreakGlassPanel({ model, phoneSafetyMode })` and prove phone mode always keeps `break-glass-status` visible while omitting:

- Designate active admin and Change reason fields;
- Designate custodian;
- Security key label and Enroll security key;
- Issue new recovery codes;
- any one-time recovery-code display initiated before the transition.

- [ ] **Step 3: Run component tests and verify the missing integration**

Run:

```bash
npm test -- src/components/admin/accounts-section.test.tsx src/components/admin/administration-shell.test.tsx src/components/admin/break-glass-panel.test.tsx
```

Expected: FAIL because the editor/action and break-glass phone prop are not integrated.

- [ ] **Step 4: Implement shared per-user orchestration**

Default the injectable navigation boundary to a full document navigation so revoked self-sessions cannot remain on protected client state:

```ts
const defaultNavigateToSignIn = (href: string) => window.location.assign(href);
```

In `AccountsSection`, add:

```ts
const [roleEditorStates, setRoleEditorStates] = useState<Record<string, RoleEditorState>>({});
const [roleOverrides, setRoleOverrides] = useState<Partial<Record<string, UserRole>>>({});
const [pendingRoleUserId, setPendingRoleUserId] = useState<string | null>(null);
const [roleFocusRequest, setRoleFocusRequest] = useState<{
  userId: string;
  target: "select" | "reason" | "alert";
} | null>(null);
```

Apply role overrides to rendered users until a refreshed model matches them. Use one editor state keyed by user ID for both presentations. A new selection creates Dirty state; reselect and Cancel delete that state. Client validation uses `changeAccountRoleInputSchema`. When mapping a just-created local account into the richer row type, initialize zero assignment counts, no active OIDC link, no break-glass designation, and `isSoleActiveAdministrator: false`; the mandatory refresh replaces those known-safe creation facts with the authoritative read model.

Only one role request may run. Set `pendingRoleUserId` before awaiting. Disable Create account and every role select when account creation or role mutation is pending. Do not clear draft in a `finally`; success and each failure own their explicit state transition.

- [ ] **Step 5: Implement visible-copy focus and result recovery**

Create a helper that scans all `[data-account-role-select]`, reason, or alert nodes, filters by `dataset.accountUserId`, and chooses the first element with non-empty `getClientRects()`. In jsdom, fall back to the first matching node so unit tests can assert focus. Retry for up to ten 30 ms intervals, matching the existing created-row focus pattern.

Handle action results exactly as specified:

- reason validation or reason field error: Error state and reason focus;
- protection, assignments, stale, access-denied, and unexpected: Error state and alert focus;
- other success: override row role, clear editor state, announce, refresh, select focus;
- self success: call `navigateToSignIn("/?reason=role-changed")` immediately;
- AUTH_EXPIRED: navigate to `/?reason=session-expired&returnTo=%2Fadministration%3Fsection%3Daccounts`;
- NOT_FOUND: clear that editor state, refresh, and allow the refreshed model to remove the row;
- ACCESS_DENIED: retain context in a focused alert but disable retry under that session;
- STATE_CHANGED: set role override from `currentRole`, refresh, retain reason only if requested role still differs, or collapse and politely announce when it already equals the requested role;
- INTERNAL_ERROR or a rejected action promise: retain inputs and prevent another save until the administrator refreshes the account list.

- [ ] **Step 6: Render editor copies and phone text facts**

Replace table role text and card role fact with `AccountRoleEditor` only when `phoneSafetyMode` is false. Use `presentationId={`table-${user.id}`}` and `presentationId={`card-${user.id}`}`. In phone mode retain `user.roleLabel` and render no role form.

Thread `phoneSafetyMode` from `AdministrationShell` into `BreakGlassPanel`, guard every mutation/recovery-code block with `!phoneSafetyMode`, and clear any one-time `recoveryCodes` state when phone mode begins so it cannot reappear after a viewport round trip.

- [ ] **Step 7: Add compact editor styling without touching appearance-bug selectors**

Add focused classes such as `.account-role-editor`, `.account-role-editor__controls`, `.account-role-editor__guidance`, and `.account-role-editor__alert`. Use existing spacing, line, focus, danger, muted, and control tokens. Allow reason and button rows to wrap in tables, stack them in cards, and keep 32 px minimum interactive target size. Do not edit unrelated selectors or snapshots.

- [ ] **Step 8: Run component and accessibility-adjacent tests and commit**

Run:

```bash
npm test -- src/components/admin/account-role-editor.test.tsx src/components/admin/accounts-section.test.tsx src/components/admin/administration-shell.test.tsx src/components/admin/break-glass-panel.test.tsx
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/components/admin/accounts-section.tsx src/components/admin/accounts-section.test.tsx src/components/admin/administration-shell.tsx src/components/admin/administration-shell.test.tsx src/components/admin/break-glass-panel.tsx src/components/admin/break-glass-panel.test.tsx src/styles/administration.css src/styles/responsive.css
git commit -m "feat: integrate responsive account role editing"
```

---

### Task 8: Add the core end-user role, keyboard, focus, and revocation flows

**Files:**
- Create: `e2e/account-role-management.spec.ts`
- Modify: `e2e/support/appliance.ts`
- Modify: `e2e/accessibility.spec.ts`

**Interfaces:**
- Consumes: the complete local role action and existing local login/session poll harness.
- Produces: reusable E2E account helpers and browser evidence for discovery, supported surfaces, keyboard, pending, focus, other-account change, self-change, and revocation.

- [ ] **Step 1: Export deterministic E2E account helpers**

Rename private `createLocalAccount` to exported `ensureLocalAccount` without changing its idempotent UI behavior. Add helpers:

```ts
export function accountRoleFactsForEmail(email: string) {
  return queryRuntimeRows<{
    id: string;
    role: string;
    isActive: number;
    authVersion: number;
  }>(
    "select id, role, is_active as isActive, auth_version as authVersion from users where email = ?",
    [email],
  )[0];
}

export function accountRoleAuditRows(userId: string) {
  return queryRuntimeRows<{
    actorUserId: string | null;
    createdAt: string;
    metadata: string;
  }>(
    "select actor_user_id as actorUserId, created_at as createdAt, metadata from audit_events where type = 'account.role_changed' and json_extract(metadata, '$.data.targetUserId') = ? order by created_at",
    [userId],
  );
}
```

Retain `execRuntimeSql`, `queryRuntimeRows`, and `authSessionRowsForEmail` for rollback/protection tasks.

- [ ] **Step 2: Recreate the initial failing scenario as permanent acceptance coverage**

Start `e2e/account-role-management.spec.ts` with `test.describe.serial`. Bootstrap admin, ensure several uniquely named role-test accounts, navigate to Accounts, and assert each seeded row exposes a role combobox on desktop. Use a 768 x 1024 authenticated tablet context and assert the card presentation exposes the same label/value.

- [ ] **Step 3: Add pointer-free keyboard and focus coverage**

Drive one reviewer row only with `focus`, arrow/type-ahead, Tab, Enter, and Escape. Assert:

1. role selection leaves focus on select;
2. Tab moves reason, Save role, Cancel in visual order;
3. Escape cancels and returns focus to select;
4. short reason submitted with Enter focuses reason;
5. valid Enter shows pending exactly once;
6. successful other-account change focuses select and announces old/new/session revocation.

Use a unique target so the final persisted role can remain changed without affecting another test.

- [ ] **Step 4: Add delayed-request pending and duplicate-submit coverage**

After page load, route only POST requests to `**/administration**` through a controllable promise. Count matching POSTs, submit, hold the request, assert `Saving role...`, `aria-busy`, disabled role controls, disabled Create account, disabled Cancel, and pending Escape no-op. Trigger repeated Enter/click attempts, release the route, and assert `postCount === 1` plus one role audit event.

- [ ] **Step 5: Add multi-context target session revocation**

Sign the target reviewer into two browser contexts, then change that target to uploader from the admin page. Assert:

- runtime user role changed and auth version incremented exactly once;
- all previously active target sessions are revoked with `account_role_changed`;
- a protected request in one context fails immediately to `reason=session-expired`;
- the other open context converges within 15 seconds through the existing poll;
- re-login succeeds with the same local identity and uploader navigation/capabilities.

- [ ] **Step 6: Add self-demotion and sign-in focus coverage**

Ensure a second active non-designated admin, sign in as that account, and demote it to reviewer while the bootstrap admin remains active. Assert immediate `/?reason=role-changed`, exact notice, sign-in heading focus, self session revocation, audit actor snapshot `admin`, successful reviewer re-login, and no Administration navigation.

- [ ] **Step 7: Extend axe coverage to the dirty editor**

In `e2e/accessibility.spec.ts`, open Accounts, select a different role for a non-protected target, fill a valid reason without saving, and run the existing `expectNoViolations` helper against that dirty state.

- [ ] **Step 8: Run the targeted browser suite and commit**

Run:

```bash
npm run e2e:container -- e2e/account-role-management.spec.ts e2e/accessibility.spec.ts
```

Expected: PASS.

Commit:

```bash
git add e2e/account-role-management.spec.ts e2e/support/appliance.ts e2e/accessibility.spec.ts
git commit -m "test: cover account role editing end to end"
```

---

### Task 9: Add end-user protection, rollback, concurrency, error, and phone flows

**Files:**
- Modify: `e2e/account-role-management.spec.ts`

**Interfaces:**
- Consumes: runtime SQL helpers, unique E2E accounts, assignment UI, and completed role editor.
- Produces: end-user evidence for final admin, break-glass, assignments, rollback, stale writers, stale actor authority, safe errors, and phone inspection-only behavior.

- [ ] **Step 1: Add final-admin E2E protection with full database restoration**

Snapshot all admin `is_active` values and the singleton `auth_control` row. In a `try/finally`, temporarily remove the designation, set every admin except the signed-in bootstrap admin inactive, and attempt self-demotion. Assert exact actionable `LAST_ACTIVE_ADMIN` copy, alert focus, retained reason, unchanged role/auth version/session/audit/state version. In `finally`, restore every active flag and the exact designation row.

- [ ] **Step 2: Add break-glass protection and transfer recovery**

Ensure a dedicated active admin target. Snapshot designation, designate that target with `auth_control` through runtime SQL, attempt demotion from another admin, and assert transfer-before-change copy, alert focus, and no governed role/session/success-audit/state writes beyond the redacted denial diagnostic. Transfer designation back to a different active admin, refresh, and prove the old custodian can then be changed. Restore the original designation in `finally`.

- [ ] **Step 3: Add active-assignment block and recovery**

Create a recording and assign a unique reviewer through Administration. Attempt reviewer-to-approver. Assert grouped reviewer count, recording title, `Open active assignments` href containing `section=assignments`, `status=active`, and target user ID, plus retained reason and alert focus. Follow the link, remove the active assignment through the product, return to Accounts, and complete the role change. Assert completed/removed history did not block.

- [ ] **Step 4: Add atomic rollback through the browser**

Install this temporary runtime trigger in `try/finally`:

```sql
CREATE TRIGGER e2e_abort_account_role_audit
BEFORE INSERT ON audit_events
WHEN NEW.type = 'account.role_changed'
BEGIN
  SELECT RAISE(ABORT, 'e2e account role audit failure');
END
```

Submit a valid change and assert the UI shows only safe unconfirmed-outcome copy plus a correlation ID, retains selected role/reason, and focuses the alert. Runtime assertions must prove old role, auth version, active session rows, audit count, security-event count, and state version are unchanged. Drop the trigger in `finally` and prove retry succeeds after refresh.

- [ ] **Step 5: Add stale-target and concurrent-final-admin browser contexts**

Open the same target row in two admin contexts with one expected role. Submit different new roles at nearly the same time. Assert one success, one `STATE_CHANGED`, no silent overwrite, current role refresh, and retained reason when still different.

For final-admin concurrency, use two active admins with designation temporarily absent and no other active admins, then submit both demotions concurrently. Assert exactly one commits and the other receives `LAST_ACTIVE_ADMIN`; query exactly one active admin afterward. Restore fixture state in `finally`.

- [ ] **Step 6: Add stale-actor authority E2E**

Open Accounts in an admin target's stale tab. From another admin context, demote that actor. Before relying on the five-second poll, submit the stale tab's prepared role change. Assert it cannot mutate the second target and reaches `AUTH_EXPIRED` or sign-in. Query no audit for the forged second change.

- [ ] **Step 7: Add exact phone safety tests**

Use authenticated contexts for:

```ts
[
  { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true },
]
```

For each, assert account and break-glass facts remain visible while no Role combobox, Change reason, Save role, Cancel, Create account, Designate custodian, Enroll security key, or Issue new recovery codes control exists. Navigate to Administration > Assignments in the same context and separately assert assignment facts remain while `Assign work` and row removal controls are absent. Start a dirty desktop draft, transition to phone viewport, and assert only unsaved draft disappears. Start a delayed pending request, transition to phone, release, and assert the committed outcome is consumed without rendering mutation controls.

- [ ] **Step 8: Run the protection suite and commit**

Run:

```bash
npm run e2e:container -- e2e/account-role-management.spec.ts
```

Expected: PASS with all `try/finally` restoration paths exercised.

Commit:

```bash
git add e2e/account-role-management.spec.ts
git commit -m "test: cover account role protections end to end"
```

---

### Task 10: Prove linked-identity semantics and update operator/product documentation

**Files:**
- Modify: `e2e/oidc.spec.ts`
- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `docs/operators/authentik-oidc.md`
- Modify: `docs/operators/break-glass.md`
- Modify: `src/server/auth/operator-docs.test.ts`

**Interfaces:**
- Consumes: fake OIDC control, strict OIDC admission, local role editor, and approved operator procedure.
- Produces: linked-role E2E evidence and durable documentation that matches shipped behavior.

- [ ] **Step 1: Add the linked-user role transition E2E test**

In the existing OIDC serial suite, seed a unique linked reviewer with a local password. Configure the fake provider with its reviewer group, sign in successfully, then sign in as admin and change the local row to approver through the inline editor.

Assert the same user ID and identity-link row remain. Then:

```ts
await control.setUser({
  sub: linked.subject,
  name: linked.displayName,
  groups: [E2E_OIDC_GROUPS.reviewer],
});
await oidcSignIn(page);
await expect(page.locator("p.banner")).toContainText("Access is not provisioned");

await control.setUser({
  sub: linked.subject,
  name: linked.displayName,
  groups: [E2E_OIDC_GROUPS.approver],
});
await oidcSignIn(page);
await expect(page).toHaveURL(/\/workspace$/);
```

Query the redacted denial reason as `role_mismatch`, assert no subject/group in browser session JSON or role audit, and prove dual-mode local login resolves the same user ID and new approver role.

- [ ] **Step 2: Run the OIDC test and verify behavior**

Run:

```bash
npm run e2e:container -- e2e/oidc.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Write documentation assertions before editing docs**

Extend `operator-docs.test.ts` to require `authentik-oidc.md` to contain `change direct Authentik group membership first`, `exactly one`, `role mismatch`, and `Superscriber role`. Require `break-glass.md` to contain `Transfer the designation before changing the custodian's role`.

- [ ] **Step 4: Run the documentation test and verify it fails on missing procedure copy**

Run:

```bash
npm test -- src/server/auth/operator-docs.test.ts
```

Expected: FAIL on the new required phrases.

- [ ] **Step 5: Update authoritative docs without changing release metadata**

Make these exact content changes:

- `DESIGN.md`: replace the obsolete sentence saying role changes are not rendered with the inline dropdown/reason/Save/Cancel behavior; document server-side immediate transaction, final-admin, break-glass, assignment compatibility, audit, auth version, session revocation, forced re-login, OIDC local authority, and phone facts-only behavior. Remove role changes from the later out-of-scope list while leaving deactivation and password reset out of scope.
- `README.md`: add a concise Administration > Accounts role-edit procedure and mention all target sessions are revoked and re-login is mandatory.
- `docs/operators/authentik-oidc.md`: prescribe direct group membership change first, exactly one target role group, immediate matching Superscriber role save, fail-closed mismatch window, and dual versus authentik-primary behavior.
- `docs/operators/break-glass.md`: state that the designated custodian cannot be demoted and must be transferred first with the existing command/runbook.

Do not edit `CHANGELOG.md`, VERSION, release notes, or appearance documentation.

- [ ] **Step 6: Run docs/OIDC-adjacent tests and commit**

Run:

```bash
npm test -- src/server/auth/operator-docs.test.ts src/server/auth/oidc-admission.test.ts src/server/auth/role-mapping.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add e2e/oidc.spec.ts README.md DESIGN.md docs/operators/authentik-oidc.md docs/operators/break-glass.md src/server/auth/operator-docs.test.ts
git commit -m "docs: document governed account role changes"
```

---

### Task 11: Run repository validation and review the completed implementation

**Files:**
- Review only unless a failing check identifies a task-scoped defect.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that the branch satisfies the repository gate and contains no unrelated appearance fix.

- [ ] **Step 1: Run focused unit/component suites together**

Run:

```bash
npm test -- src/lib/account-role-management.test.ts src/server/db/migrations.test.ts src/server/db/transaction.test.ts src/server/auth/session-registry.test.ts src/server/access/service.test.ts src/server/administration/service.test.ts src/server/administration/account-role-service.test.ts src/server/actions/actions.test.ts src/components/admin/account-role-editor.test.tsx src/components/admin/accounts-section.test.tsx src/components/admin/administration-shell.test.tsx src/components/admin/break-glass-panel.test.tsx src/server/auth/operator-docs.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full non-browser repository gate**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run worker:check
```

Expected: every command exits 0.

- [ ] **Step 3: Run both browser lanes**

Run:

```bash
npm run e2e
npm run e2e:container
```

Expected: all local and container Playwright tests pass, including account role, OIDC, accessibility, responsive, session revocation, and break-glass coverage.

- [ ] **Step 4: Inspect the final branch for scope and generated-file violations**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
git log --oneline origin/main..HEAD
python3 - <<'PY'
from pathlib import Path
words = ["T" + "BD", "TO" + "DO", "FIX" + "ME"]
paths = [
    Path("src/lib/account-role-management.ts"),
    Path("src/server/administration/account-role-service.ts"),
    Path("src/components/admin/account-role-editor.tsx"),
    Path("e2e/account-role-management.spec.ts"),
]
for path in paths:
    text = path.read_text()
    for word in words:
        if word in text:
            raise SystemExit(f"placeholder marker found in {path}: {word}")
PY
```

Expected: clean worktree; no whitespace errors; no placeholders; no `CHANGELOG.md`; no appearance-rendering files/selectors; no uncommitted fixes; atomic commits contain no co-author trailer.

- [ ] **Step 5: Record any validation-only correction as a focused commit**

If and only if a validation command exposes a task-scoped defect, first add a failing regression assertion, make the smallest correction, rerun the failed command plus its neighboring suite, and commit only those files:

Because the tree is clean before validation and the regression belongs in an existing nearest test file, stage only tracked modifications, inspect their names, then commit:

```bash
git add -u
git diff --cached --name-only
git commit -m "fix: close account role validation gap"
```

Do not use this step for cleanup outside the approved role-management and phone-safety scope.

---

### Task 12: Enter the no-mistakes delivery path after implementation approval

**Files:**
- No manual edits while a no-mistakes run is active; the pipeline owns review findings and fixes.

**Interfaces:**
- Consumes: clean, locally validated implementation branch and the full accepted captain contract.
- Produces: no-mistakes review evidence, safely pushed task branch, pull request, and green CI-ready return point.

- [ ] **Step 1: Invoke the no-mistakes skill with yolo off**

Load the installed `no-mistakes` skill and use its version-matched `no-mistakes axi run --help` guidance. Start without `--yes`. The `--intent` must preserve every accepted product requirement from the task and approved spec, including the appearance-bug exclusion, test matrix, phone behavior, OIDC semantics, transaction sequence, and later captain decisions. Exclude generic Firstmate scaffold boilerplate.

- [ ] **Step 2: Respond to gates without hand-editing**

Use `no-mistakes axi` status/help responses as authoritative. Do not manually fix findings while the run is active. Escalate every ask-user finding to Firstmate with a keyed `needs-decision` status, wait for its keyed resolution, then feed the decision to `no-mistakes axi respond`.

- [ ] **Step 3: Stop at CI green**

Allow the pipeline to review, test, apply approved fixes, commit, push the task branch, and open the pull request. Do not merge. When no-mistakes reaches its CI-ready green return point, append the required Firstmate `done: PR {url} checks green` status and stop.

---

## Requirement-to-task coverage

| Approved requirement | Plan coverage |
|---|---|
| Inline dropdown on every row; reason, Save, Cancel | Tasks 1, 6, 7, 8 |
| Phone safety remains read-only, including break-glass controls | Tasks 7 and 9 |
| Admin may change any account, including self | Tasks 3, 5, 7, 8 |
| Self-demotion only with another active admin | Tasks 2, 3, 8, 9 |
| Break-glass custodian cannot be demoted | Tasks 2, 3, 7, 9, 10 |
| Assignment compatibility and actionable guidance | Tasks 2, 3, 4, 6, 7, 9 |
| Atomic role, audit, auth version, session revocation, re-login | Tasks 2, 3, 5, 7, 8, 9 |
| Server-side authorization and transactionality | Tasks 2, 3, 5 |
| Local and OIDC-linked role-source semantics | Tasks 3, 4, 6, 10 |
| Race/concurrency handling | Tasks 2, 3, 4, 9 |
| Rollback and safe unconfirmed outcome | Tasks 2, 3, 7, 9 |
| Keyboard, focus, pending, duplicate-submit, error recovery | Tasks 6, 7, 8, 9 |
| Unit, component, end-user, local E2E, container E2E | Tasks 1 through 11 |
| Migration and backward compatibility | Tasks 2 and 11 |
| Observability and redaction | Tasks 3, 5, 9, 10 |
| Appearance defect excluded | Global constraints, Tasks 7, 10, 11 |
| no-mistakes delivery with yolo off | Task 12 |
