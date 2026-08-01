# Task 3 Report - Add Audited Admin Action Sessions and Server Capabilities

## Status
- Committed

## Implementation
- Added `src/domain/casefile.ts` with `deriveWorkflowStage`, `validateGovernedReason`, and `validateApprovalNote`.
- Added `src/server/casefile/errors.ts` with `CasefileCommandError` and stable safe action-mode error codes.
- Added `src/server/casefile/action-mode.ts` with audited admin action-mode enter, switch, resolve, lazy expiry, explicit exit, and typed actor resolution.
- Added `src/server/casefile/capabilities.ts` with explicit casefile capability booleans plus denial precedence across uploader, historical, admin oversight, submitter, policy, state, and assignment conditions.
- Updated `src/domain/policy.ts` and `src/domain/policy.test.ts` so base admin policy remains read-only oversight and reviewable export only activates through reviewer or approver authority.
- Extended `src/domain/models.ts` audit-event type union for admin action-mode lifecycle events.
- Added table-driven tests in `src/server/casefile/action-mode.test.ts` and `src/server/casefile/capabilities.test.ts` for workflow stage precedence, validation, action-session lifecycle, capability matrix coverage, denial precedence, legacy null submitter, and same-submitter separation of duties.

## RED Evidence
- Command: `npm test -- src/server/casefile/action-mode.test.ts src/server/casefile/capabilities.test.ts`
- Result: FAIL as expected.
- Evidence:
  - `Cannot find module '@/domain/casefile' imported from src/server/casefile/action-mode.test.ts`
  - `Cannot find module '@/server/casefile/capabilities' imported from src/server/casefile/capabilities.test.ts`

## GREEN Evidence
- Command: `npm test -- src/server/casefile/action-mode.test.ts src/server/casefile/capabilities.test.ts src/domain/policy.test.ts && npm run typecheck`
- Result: PASS.
- Evidence:
  - `Test Files  3 passed (3)`
  - `Tests  35 passed (35)`
  - `tsc --noEmit` exited 0

## Files
- `src/domain/casefile.ts`
- `src/domain/models.ts`
- `src/domain/policy.ts`
- `src/domain/policy.test.ts`
- `src/server/casefile/errors.ts`
- `src/server/casefile/action-mode.ts`
- `src/server/casefile/action-mode.test.ts`
- `src/server/casefile/capabilities.ts`
- `src/server/casefile/capabilities.test.ts`

## Commit
- Current HEAD: `feat(governance): add audited admin action context`

## Self-review
- Verified replacement action mode ends only one active same-admin same-record session and audits switched plus entered exactly once.
- Verified lazy expiry and explicit exit are idempotent on audit emission and return stable safe errors for expired or ended sessions.
- Verified denial precedence across uploader-only, historical, admin action mode required or expired, legacy submitter unknown, same submitter, not submitter, policy, wrong state, and not assigned.
- Verified admin oversight keeps media visibility but no implicit mutation, approval, reopen, or export authority without validated reviewer or approver action mode.
- Verified admin approver mode still denies self-decision on pending submissions.

## Concerns
- None.

## Fix Round 1
- RED command: `npm test -- src/server/casefile/action-mode.test.ts src/server/casefile/capabilities.test.ts src/domain/policy.test.ts`
- RED output:
  ```text
  FAIL  src/server/casefile/action-mode.test.ts > casefile action mode > rolls back lazy expiry when the matching audit insert fails
  AssertionError: expected '2026-08-01T12:31:00.000Z' to be null

  FAIL  src/server/casefile/action-mode.test.ts > casefile action mode > expires action mode through resolveActionMode exactly once
  AssertionError: expected 1 to be 2 // Object.is equality

  FAIL  src/server/casefile/capabilities.test.ts > deriveCasefileCapabilities > 'ignores forged approver mode for a re…'
  FAIL  src/server/casefile/capabilities.test.ts > deriveCasefileCapabilities > 'ignores forged approver mode for a re…'
  FAIL  src/server/casefile/capabilities.test.ts > deriveCasefileCapabilities > 'ignores forged approver mode for an a…'
  FAIL  src/server/casefile/capabilities.test.ts > deriveCasefileCapabilities > 'ignores forged reviewer mode when the…'
  AssertionError: expected { canViewStatus: true, …(11) } to deeply equal ObjectContaining{…}

   Test Files  2 failed | 1 passed (3)
        Tests  6 failed | 35 passed (41)
  ```
- Why expected: the new regression tests exposed that lazy expiry updated sessions outside `runGovernedTransaction`, so rollback and state-version guarantees failed, and that `deriveCasefileCapabilities` still trusted forged action-mode input.
- GREEN command: `npm test -- src/server/casefile/action-mode.test.ts src/server/casefile/capabilities.test.ts src/domain/policy.test.ts && npm run typecheck`
- GREEN output:
  ```text
   Test Files  3 passed (3)
        Tests  41 passed (41)

  > superscriber@0.2.0 typecheck
  > tsc --noEmit
  ```
- Files changed:
  - `src/server/casefile/action-mode.test.ts`
  - `src/server/casefile/action-mode.ts`
  - `src/server/casefile/capabilities.test.ts`
  - `src/server/casefile/capabilities.ts`
- Fix commit:
  - `fix(governance): enforce action session boundaries`
- Self-review:
  - Added rollback and exactly-once lazy-expiry regressions for both actor-context and action-mode resolution paths.
  - Moved lazy expiry into a governed transaction wrapper that revalidates the session, preserves atomic rollback on audit failure, and bumps state version exactly once on success.
  - Hardened capability derivation so action mode only affects authority for active, unexpired admin-oversight inputs on the matching recording, while forged non-admin or mismatched inputs are ignored.
