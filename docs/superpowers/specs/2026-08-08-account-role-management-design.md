# Superscriber Account Role Management Design

**Date:** 2026-08-08

**Status:** Written-design review gate

**Scope:** Product-facing account role editing in Administration > Accounts

## 1. Product contract

This design implements the captain-approved contract without changing its product choices:

- On supported tablet and desktop surfaces, every account row has an inline role dropdown.
- Choosing a role other than the persisted role reveals a required **Change reason** field and explicit **Save role** and **Cancel** actions.
- Phone safety mode remains inspection-only.
- An administrator may change any account, including their own.
- A role change that would leave no active administrator is rejected. Self-demotion is allowed when at least one other active administrator remains.
- The designated break-glass administrator cannot be demoted.
- Active assignments whose role snapshots are incompatible with the requested role block the change and identify the assignments that must be resolved.
- A successful change atomically updates the role, writes the governance audit event, increments the target account's authorization version, revokes every active target session, and requires the target to sign in again.
- Administrator authorization and every invariant are enforced in the server transaction. The client is guidance, not an authority boundary.

Account deactivation, password management, bulk role changes, role-map authoring, break-glass transfer, assignment removal from the Accounts row, and the separate appearance-rendering defect are outside this ship.

## 2. Current-state findings and governing invariants

### 2.1 Administration surface

- `app/(authenticated)/administration/page.tsx` requires a live principal, redirects non-admins, and asks `src/server/administration/service.ts` for the selected section.
- `src/components/admin/accounts-section.tsx` currently renders role as text in both the wide table and responsive account facts. It supports account search and a create-account drawer, but no account lifecycle controls.
- `src/components/admin/administration-shell.tsx` derives phone safety mode on the client. The hook initializes to safe mode until the browser is classified, preventing a mutation-control flash during hydration.
- The current phone contract is explicit: administration facts remain visible, while mutation controls are omitted. `AccountsSection` already omits account creation and `AssignmentsSection` omits assignment changes in phone safety mode. Role editing must follow that pattern rather than rendering a disabled select as a false read-only control.
- Inspection found one safety gap on the same Accounts surface: `BreakGlassPanel` does not receive phone safety mode and can still expose designation, key-enrollment, or recovery-code mutations. Preserving the approved read-only phone contract requires threading the existing safety state into that panel and rendering only its facts on phones. This is a behavior correction required by this ship, not the unrelated appearance-rendering defect.
- Desktop and responsive account presentations coexist in the DOM and are selected by CSS. Any role editor state must therefore be shared by account ID, not independently owned by the table and card copies.

### 2.2 User and authorization model

- The durable authority is `users.role`, one of `uploader`, `reviewer`, `approver`, or `admin` from `USER_ROLES` in `src/domain/models.ts`.
- `users.is_active` determines whether an account is active. `users.auth_version` starts at 1 and is the version checked by durable sessions.
- Auth.js is cookie transport only. `src/server/auth/session-registry.ts` validates the durable `auth_sessions` row and the live `users` row on every protected session read. Roles are not trusted from a stale cookie.
- A target role change must increment `users.auth_version` exactly once and revoke all active `auth_sessions` rows for that target. Either mechanism invalidates stale authority; doing both is the existing defense-in-depth contract.
- The authenticated shell polls `/api/auth/session-state` every five seconds. Revoked target sessions therefore converge to the session-expired sign-in surface without waiting for another explicit navigation.

### 2.3 Local and OIDC-linked identities

- All application authorization resolves from the local `users` row, whether sign-in is local, Authentik OIDC, or break-glass.
- An account may have a local credential, an active exact `(issuer, subject)` identity link, or both. OIDC-only shadow users have a null password hash but are still normal rows in the same account directory.
- OIDC admission does not overwrite the local role. `resolveOidcAdmission` requires exactly one mapped Authentik role group and requires that mapped role to equal `users.role`. A zero-role, multi-role, malformed, or mismatched claim is denied.
- Account role editing must not modify `external_identities`, the mounted role-map file, or Authentik membership. For an OIDC-linked target, the UI must explain that the institution must place the identity in exactly one Authentik group for the requested role. During any cross-system coordination gap, OIDC admission fails closed rather than granting either role.
- Recommended operator order for a linked identity is to change direct Authentik group membership to the target role, then immediately save the matching Superscriber role. A sign-in during the brief mismatch is denied. The local database transaction remains the atomic boundary; Superscriber cannot make an external IdP write part of its SQLite transaction.
- In dual mode, a linked account that also has a local credential may sign in locally with the newly persisted local role. In authentik-primary mode, normal local credentials remain disabled and the OIDC role must match before sign-in succeeds.

### 2.4 Break-glass designation

- `auth_control` is a singleton naming one active administrator.
- Schema v6 triggers already reject demotion, deactivation, or deletion of the designated user even if a service check is bypassed.
- The role-change service must detect the designation before the update and return procedural copy: **This account is the designated break-glass administrator. Transfer the designation before changing its role.** The existing trigger remains the final database defense.
- Transfer remains the existing separate, atomic operator ceremony. This feature does not add a transfer shortcut.

### 2.5 Assignments

- Every assignment activation is an append-only `recording_assignments` row. `assignment_role` is the reviewer or approver role snapshot for that activation; `status` is authoritative for active, completed, or removed history.
- Assignment access is resolved from the assignment row, while policy capabilities also depend on the principal's current local role. Leaving an active role snapshot that disagrees with the user's new role would produce contradictory inbox, access, and policy behavior.
- An active assignment is compatible with a requested role only when `assignment_role === requestedRole`. Because only reviewer and approver assignments exist, changing to uploader or admin is incompatible with every active assignment. Completed and removed assignments are historical and never block a role change.
- The current assignment writer derives `assignment_role` from the user before entering its transaction. This creates a race with role editing and must be tightened as part of this feature: reload the user and derive the role inside the assignment transaction immediately before insertion.

### 2.6 Audit and transaction patterns

- Governed product events use `audit_events`, with actor snapshot columns, a versioned metadata envelope, and `recording_id = null` for a workspace-level event. This is the right canonical stream for an account governance change.
- Authentication diagnostics use the redacted `security_events` stream. Existing session revocation writes `auth.session.revoked` records and must continue to do so without becoming the canonical role-change audit.
- `runGovernedTransaction` updates `app_state_meta.state_version` in the same transaction as governed writes. Account role changes must preserve this synchronization invariant.
- SQLite is opened with WAL and foreign keys enabled. Security-sensitive role changes should acquire the write reservation before evaluating final-admin and assignment preconditions so two writers cannot both act from the same stale snapshot.

### 2.7 Relevant history

Recent authentication work deliberately established these constraints:

- `58b1587` introduced the live, revocable session registry and documented local role changes as an authorization-version invalidation cause.
- `479d192` introduced exact identity links and strict one-group-to-one-local-role agreement, explicitly rejecting silent role grant or downgrade.
- `7f7aceb` introduced database-enforced break-glass designation and transfer.
- `4189d3b` shipped those slices together with OIDC, break-glass, session-revocation E2E coverage, and operator runbooks.
- `605ad65` hardened the container E2E lane. New browser coverage must use its existing runtime and in-container database helpers rather than inventing another harness.

These are governing invariants, not implementation details to replace.

## 3. Recommended architecture

Use one dedicated account-role command with four layers:

1. **Account directory read model** supplies each row's persisted role and non-authoritative guidance facts: active assignment counts by role, active OIDC-link presence, break-glass designation, and whether the row is currently the sole active administrator.
2. **Inline role editor** owns no authority. It manages the draft role, reason, pending state, announcements, and focus for one account ID, with the table and responsive presentations controlled from one shared state record.
3. **Server action boundary** resolves the live session, validates the request shape, calls the domain service, maps typed failures to safe response codes, and revalidates affected routes.
4. **Transactional role service** re-reads actor, target, designation, active-admin count, active assignments, and sessions under an immediate SQLite transaction. It performs every required durable write or rolls all of them back.

Add schema v8 guard triggers for final-admin demotion and active-assignment role agreement. Service checks produce product copy; triggers prevent alternate writers and races from violating the invariant.

### 3.1 Why this architecture

- It follows the existing typed server-action pattern used by account creation and assignments.
- It keeps UI state local to the Accounts surface while making the service independently testable against a real SQLite database.
- It reuses the durable session registry and governed audit model rather than creating parallel authority or audit systems.
- It gives product-friendly errors before a trigger fires while retaining database-level protection for the two cross-writer invariants.
- It makes self-demotion safe: the request can complete and return success after revoking its own session, then the client leaves the protected surface immediately.

## 4. Rejected alternatives

### 4.1 Client-only checks around a generic user update

Rejected. A disabled option or hidden button cannot protect a forged server action, a stale tab, or another writer. It also cannot make role, audit, auth-version, and session writes atomic.

### 4.2 Calling `retireUserSessions` before or after a separate role update

Rejected as the command boundary. Separate transactions can leave a new role with old sessions or revoked sessions with an unchanged role. The role command must own one transaction and use the session-revocation primitive inside it.

### 4.3 Letting Authentik claims overwrite `users.role` on login

Rejected. It conflicts with existing strict local-role agreement, makes local and OIDC sign-in produce different authority, and turns a login callback into an unaudited role administration path.

### 4.4 Making Authentik the only role editor

Rejected. It fails the approved product contract, does not cover local-only accounts, and cannot provide the required local atomic audit and session retirement.

### 4.5 A modal or bulk account editor

Rejected. The approved interaction is inline per row. Bulk changes also make reason attribution, final-admin handling, assignment guidance, focus, and rollback less clear.

### 4.6 Reusing the break-glass transfer ceremony for demotion

Rejected. Transfer and role change have different governance meanings and audit facts. The role editor should link to the existing transfer procedure, not combine the operations.

## 5. Component and service boundaries

### 5.1 Administration account read model

Extend each account row with:

```ts
type AccountRoleManagementFacts = {
  activeAssignments: {
    reviewer: number;
    approver: number;
  };
  hasActiveOidcIdentity: boolean;
  isBreakGlassAdministrator: boolean;
  isSoleActiveAdministrator: boolean;
};
```

These fields support warnings and recovery links only. They are snapshots and are always rechecked by the service. They never disable an otherwise valid Save role request, because a stale read model must not prevent a now-permitted change.

The read model must continue to include every user row, including inactive and OIDC-only accounts. Search behavior remains unchanged.

### 5.2 Inline editor

Create a focused `AccountRoleEditor` boundary used by both account presentations. `AccountsSection` owns a map keyed by user ID so table and responsive copies share:

```ts
type RoleEditorState = {
  selectedRole: UserRole;
  reason: string;
  phase: "persisted" | "dirty" | "pending" | "error";
  fieldError: string | null;
  operationError: AccountRoleChangeFailure | null;
};
```

Each rendered copy receives a unique presentation ID for labels and DOM IDs. A visible-element focus helper chooses the currently displayed copy after responsive changes; IDs are never duplicated.

Only one role request may be pending from the Accounts surface at a time. Other role dropdowns and account creation are disabled while it is pending, preventing a second browser request from racing a self-demotion. Server concurrency handling remains mandatory.

### 5.3 Server action

Add a typed `changeAccountRoleAction(input)` beside existing administration actions. It must:

- return `AUTH_EXPIRED` when no live session exists;
- pass only the actor user ID from the live session to the service;
- never accept actor role, actor name, authorization version, assignment facts, or break-glass facts from the client;
- validate field shape before service invocation and repeat semantic checks in the service;
- revalidate `/administration` and `/workspace` after success;
- treat the committed service result as authoritative: a cache-revalidation failure is logged but does not convert a committed role change into a failure response;
- return a safe correlation ID for an unexpected error without exposing SQL, paths, role-map details, or session IDs.

### 5.4 Transactional domain service

Add a dedicated account-role service under the administration server boundary. It takes an `AppDatabaseBundle` for real-database tests and does not depend on React, Next navigation, or client state.

### 5.5 Assignment writer hardening

Move the assigned-user lookup and `assignment_role` derivation into `assignRecordingToUser`'s transaction. If a role changes before assignment insertion, the assignment operation must re-evaluate the new role and either use the current reviewer/approver role or return the existing procedural assignment error. The schema guard is defense in depth, not a substitute for this copy.

### 5.6 Phone safety propagation

Pass `phoneSafetyMode` from `AdministrationShell` to `BreakGlassPanel`. The panel keeps designation and custody counts visible but omits designation, key-enrollment, and recovery-code mutation controls while safety mode is active. Its server actions retain their existing authorization checks; viewport remains a supported-surface rule rather than a security claim.

## 6. Inline row state machine

| State | Entry | Visible controls | Exit |
|---|---|---|---|
| Persisted | Initial render, successful save, or Cancel | Inline role dropdown only | Selecting a different role enters Dirty |
| Dirty | Selected role differs from persisted role | Dropdown, required Change reason, Save role, Cancel, relevant OIDC/protection/assignment guidance | Save enters Pending; Cancel or reselecting persisted role returns to Persisted |
| Pending | Valid Save role submission | All account mutations disabled; row has `aria-busy="true"`; button reads `Saving role...` | Success returns to Persisted or navigates to sign-in for self-change; failure enters Error |
| Error | Validation, stale state, protection, assignment, or unexpected failure | Dirty controls remain with entered reason; field or row error is announced | Editing clears the corresponding error; Save retries; Cancel returns to Persisted |

Rules:

- Selecting the persisted role never asks for a reason and cannot submit a no-op.
- Reselecting the persisted role clears the unsaved reason and errors.
- Cancel restores the persisted role, clears reason and errors, and returns focus to the visible role dropdown.
- A reason is trimmed and must contain 10 to 500 characters, matching existing governed-reason semantics.
- Initial read-model facts show guidance for a known break-glass demotion, sole-active-admin demotion, or incompatible assignment, but do not disable an otherwise valid Save role request. The server checks all three because the snapshot may be stale and calls may be forged.
- A server-side stale-state response refreshes the model. If the requested role is still different from the refreshed persisted role, retain the typed reason and ask the administrator to review and retry. If another writer already made the same change, collapse to Persisted and announce the new role.
- A network or internal error retains both selected role and reason so recovery never requires retyping governance context.

## 7. Responsive and phone behavior

- At widths and pointer conditions outside phone safety mode, the existing visible account presentation renders the inline editor. This includes tablets at 768 CSS px and above.
- In phone safety mode, role remains a text fact. No role combobox, reason field, Save role, or Cancel action is rendered in either account presentation. Existing account creation, assignment, break-glass designation, key-enrollment, and recovery-code mutation controls are also absent, so the Administration > Accounts and Assignments surfaces are genuinely inspection-only.
- Because `usePhoneSafetyMode` begins as `true`, the first client render is read-only. Mutation controls appear only after a supported wider viewport is confirmed.
- If the viewport enters phone safety mode while an unsaved editor is Dirty or Error, discard only that unsaved client draft and render persisted facts. If a request is already Pending, do not attempt client cancellation; render read-only facts, consume the response, refresh data, and perform the self-change sign-in redirect if required.
- Phone classification remains a supported-surface rule, not a server authorization factor. Administrator enforcement and transaction checks do not depend on viewport claims.
- This ship does not alter unrelated account-list appearance or responsive rendering behavior.

## 8. Keyboard, focus, and accessibility

### 8.1 Semantics and labels

- Use a native `<select>` with visible role context and accessible name `Role for <display name>`.
- The revealed input has a visible **Change reason** label and accessible name `Change reason for <display name>`.
- The controls form one inline `<form>` per visible account presentation so Enter can submit naturally.
- Associate guidance and errors through `aria-describedby`. Use `aria-invalid="true"` only on the field that failed validation.
- The row operation error is a focusable `role="alert"`; success uses the existing polite administration status region.
- Pending state uses `aria-busy="true"`, disables mutable controls, and exposes the changing button label as text, not color alone.

### 8.2 Keyboard interaction

- Native arrow keys and type-ahead operate the role dropdown.
- After choosing a different role, focus stays on the dropdown. The newly revealed reason is next in DOM order, so Tab moves to Change reason, then Save role, then Cancel.
- Enter from the reason field submits the form once. Invalid input is not silently ignored.
- Escape anywhere in a Dirty or Error editor performs Cancel, unless a request is Pending. Pending Escape does nothing because the durable outcome is not yet known.
- Tab order follows visual order in both table and responsive account presentations. CSS-hidden copies are not focusable.

### 8.3 Focus outcomes

- Client reason validation or a server `reason` field error focuses the reason input.
- Break-glass, final-admin, assignment, stale-state, and unexpected errors focus the row alert after it renders. The alert contains the recovery action.
- Successful change of another account focuses that row's visible role dropdown after it displays the newly persisted value. The polite status announces old role, new role, session revocation, and re-login requirement.
- Cancel returns focus to the same visible role dropdown.
- Successful self-role change does not try to restore focus inside a surface the actor can no longer access. It immediately navigates to `/?reason=role-changed`, where the existing auth-surface focus behavior places focus on the sign-in heading.
- No control disappears while it owns focus without one of the explicit focus transfers above.

## 9. Request, response, and validation contract

### 9.1 Request

```ts
type ChangeAccountRoleInput = {
  userId: string;
  expectedRole: UserRole;
  newRole: UserRole;
  reason: string;
};
```

- `userId` is required and is resolved only against the database.
- `expectedRole` is the persisted role loaded by the row. It is a compare-and-set precondition, not authority.
- `newRole` must be one of `USER_ROLES` and must differ from `expectedRole`.
- `reason` is trimmed and must be 10 to 500 characters.
- A strict schema rejects unknown keys; they never reach the service.

### 9.2 Success

```ts
type ChangeAccountRoleSuccess = {
  ok: true;
  notice: string;
  data: {
    user: AccountDirectoryEntry;
    oldRole: UserRole;
    newRole: UserRole;
    revokedSessionCount: number;
    actorMustRelogin: boolean;
  };
};
```

For another account, the notice is:

> <Name>'s role changed from <Old role> to <New role>. Active sessions were revoked; they must sign in again.

For self-change, the client redirects instead of relying on an administration notice.

### 9.3 Typed failures

```ts
type AccountRoleChangeErrorCode =
  | "AUTH_EXPIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "STATE_CHANGED"
  | "BREAK_GLASS_PROTECTED"
  | "LAST_ACTIVE_ADMIN"
  | "ASSIGNMENTS_INCOMPATIBLE"
  | "INTERNAL_ERROR";

type AssignmentBlockers = {
  total: number;
  byRole: Array<{
    role: "reviewer" | "approver";
    count: number;
    recordingTitles: string[];
  }>;
  managementHref: string;
};
```

Failure copy and recovery:

| Code | Copy | Recovery |
|---|---|---|
| `AUTH_EXPIRED` | Session expired. Sign in again to continue. | Navigate to sign-in with a safe return route. |
| `ACCESS_DENIED` | Only active administrator accounts can change account roles. | No client retry under this session. |
| `NOT_FOUND` | This account is no longer available. Refresh the account list. | Refresh and collapse the missing row. |
| `VALIDATION_ERROR` | Enter a change reason between 10 and 500 characters. | Keep the editor open and focus Change reason. |
| `STATE_CHANGED` | This account's role changed after the list loaded. Review the current role and try again. | Refresh model, retain reason if another change is still requested. |
| `BREAK_GLASS_PROTECTED` | This account is the designated break-glass administrator. Transfer the designation before changing its role. | Follow the existing break-glass transfer runbook, then refresh. |
| `LAST_ACTIVE_ADMIN` | At least one active administrator must remain. Promote another active account to Administrator before changing this role. | Promote another account, then retry. |
| `ASSIGNMENTS_INCOMPATIBLE` | Remove the listed active assignments before changing this account to <New role>. | Render counts and recording titles, plus a link to the target's filtered Active assignments ledger. |
| `INTERNAL_ERROR` | The role change could not be confirmed. Refresh the account list before trying again. | Retain input, show correlation ID, and refresh before retry so an unknown response cannot duplicate a committed change. |

The assignment response may cap displayed recording titles per role for layout, but `total`, per-role counts, and `managementHref` must cover every incompatible active assignment. The filtered ledger is the complete resolution surface.

## 10. Authorization and role rules

### 10.1 Administrator enforcement

The server action's live principal check is the first gate. Inside the same role-change transaction, reload the actor row by ID and require:

- actor exists;
- actor is active;
- actor's current role is `admin`.

The service never trusts the role carried in request input or a previously rendered model. If the actor was demoted or deactivated after session resolution, the transaction rejects the operation.

### 10.2 Active-admin rule

When the target is an active admin and `newRole !== "admin"`:

- count other rows where `role = "admin"` and `is_active = 1`;
- reject when that count is zero;
- allow when that count is at least one, whether the target is the actor or another admin.

This defines final-admin protection consistently. Inactive admin rows may change role because they are not part of the active-admin count. Promotion to admin is not subject to the minimum check.

### 10.3 Break-glass rule

If `auth_control.break_glass_user_id` equals the target and the requested role is not admin, reject before any write. The existing database trigger independently rejects a bypass.

### 10.4 Assignment compatibility

Load active assignments for the target and compare each immutable `assignment_role` snapshot with `newRole`:

- reviewer assignment to reviewer role: compatible;
- approver assignment to approver role: compatible;
- every other pair: incompatible.

Any incompatible active row rejects the entire change. Completed and removed rows are ignored. The response groups blockers by assignment role and points to `/administration?section=assignments&status=active&userId=<target id>`.

## 11. Database transaction and rollback

### 11.1 Transaction mode

Add an immediate governed transaction variant that uses the existing database bundle and state-version increment but begins with SQLite's immediate write reservation. Use it for account role changes. This serializes the final-admin count, break-glass pointer read, assignment scan, role update, and session retirement against competing writers.

### 11.2 Exact sequence

After request-shape validation, execute this sequence inside one immediate transaction with one `now` timestamp:

1. Reload and authorize the active actor user row.
2. Reload the target user row. Reject missing target.
3. Compare `target.role` with `expectedRole`. Reject stale state and no-op requests.
4. Read `auth_control` and reject a break-glass demotion.
5. If demoting an active admin, count other active admins and reject the final-admin case.
6. Load and summarize incompatible active assignments. Reject if any exist.
7. Conditionally update the target row where both ID and expected role match:
   - set `role = newRole`;
   - set `auth_version = auth_version + 1`;
   - set `updated_at = now`.
8. If the conditional update changed no row, return `STATE_CHANGED` and roll back.
9. Revoke every active target session with `status = revoked`, `revoked_at = now`, and `revoked_reason = account_role_changed`. Do not exempt the actor's current session for self-change.
10. Insert one canonical `account.role_changed` audit event with `recording_id = null` and `created_at = now`.
11. Increment `app_state_meta.state_version`.
12. Commit and only then return success.

### 11.3 Rollback guarantee

Any exception or zero-row compare-and-set failure rolls back all in-transaction role, auth-version, session, audit, security-event, and state-version writes. A separate best-effort denial diagnostic may be recorded only after rollback. In particular:

- an audit insert failure leaves the old role and authorization version intact and all sessions active;
- a session update failure leaves no role or audit change;
- a state-version failure leaves no partial role change;
- a trigger rejection leaves no partial change;
- a stale expected role writes nothing.

The canonical audit insert must not be wrapped in a best-effort catch. Per-session diagnostic security events may retain their existing best-effort behavior, but they do not satisfy the audit requirement.

## 12. Audit record shape

Add `account.role_changed` to the `AuditEvent` type union. No audit table column change is required.

```ts
{
  workspaceId: currentWorkspace.id,
  recordingId: null,
  actorRole: "admin",
  actorUserId: actor.id,
  actorDisplayName: actor.displayName,
  effectiveRole: "admin",
  adminActionSessionId: null,
  type: "account.role_changed",
  detail: `${target.displayName}'s account role changed from ${oldLabel} to ${newLabel}.`,
  metadata: {
    version: 1,
    data: {
      targetUserId: target.id,
      targetDisplayName: target.displayName,
      oldRole,
      newRole,
      reason,
      resultingAuthVersion,
      revokedSessionCount
    }
  },
  createdAt: now
}
```

The actor snapshot remains `admin` for a self-demotion because that is the authority under which the command executed. The target snapshot avoids email and preserves understandable attribution if the display name changes later. The required reason is stored only in the canonical governed audit, not copied into logs or redacted denial diagnostics.

The current appliance has one workspace. If the workspace row cannot be resolved, audit cannot be completed, so the transaction fails closed and rolls back.

## 13. Session revocation and re-login

- Incrementing `users.auth_version` guarantees that any session row missed by an active-session update still fails validation on its next request.
- Explicitly revoking all active rows makes session state and operator diagnostics truthful immediately.
- Existing Auth.js cookies contain only registry pointers and cannot retain the old role.
- Other open target tabs reach sign-in through the existing five-second shell poll. A protected request before that poll also fails immediately.
- For another target, the acting admin remains on Accounts and receives the success announcement.
- For self-change, the server response is allowed to complete on the request that performed the transaction. The client then navigates immediately to `/?reason=role-changed`. The auth surface says: **Your account role changed. Sign in again to continue.**
- After re-login, navigation, inbox selection, policy, assignment access, and casefile capabilities derive from the new live role.
- OIDC-linked users whose IdP group still reflects the old role are denied with the existing generic browser message and redacted `role_mismatch` security reason until the two sources agree.

## 14. Race and concurrency handling

### 14.1 Two role changes for one target

Both requests carry `expectedRole`. The immediate transaction and conditional update allow one winner. The loser returns `STATE_CHANGED`, preserves its reason in the UI, refreshes the row, and cannot overwrite the winner silently.

### 14.2 Concurrent final-admin demotions

Immediate transactions serialize active-admin counts. If two admins are the only active admins and each is concurrently demoted, the first may commit and the second then sees itself as the final active admin and is rejected. The schema trigger independently prevents the zero-admin result.

### 14.3 Assignment creation versus role change

- If assignment creation commits first, the role transaction sees the active snapshot and rejects an incompatible change.
- If role change commits first, assignment creation reloads the user's new role inside its transaction and either uses that reviewer/approver role or rejects a non-assignable role.
- Schema v8 assignment guards reject an insert or activation whose `assignment_role` disagrees with the user's live role.

No committed ordering can leave a newly incompatible active assignment.

### 14.4 Break-glass transfer versus demotion

The role transaction reads the singleton under its write reservation. A transfer that wins first makes the old custodian eligible for a later role change and protects the new custodian. A role change that reaches the current custodian first is rejected. Existing break-glass triggers protect both orderings.

### 14.5 Actor authority changes during request

The actor is re-read in the transaction. A stale admin page cannot perform another role change after its actor has been demoted or deactivated, even before the browser's session poll redirects it.

## 15. Schema migration and backward compatibility

Add schema migration v8 with trigger-only guards:

1. A `BEFORE UPDATE OF role ON users` trigger rejects demotion of the last active administrator.
2. A `BEFORE UPDATE OF role ON users` trigger rejects a new role that disagrees with any active assignment snapshot.
3. `BEFORE INSERT` and relevant `BEFORE UPDATE` triggers on `recording_assignments` reject an active assignment whose snapshot disagrees with the assigned user's current reviewer or approver role.

The migration:

- does not rebuild a table;
- does not rewrite roles, identity links, assignments, sessions, or history;
- does not invalidate sessions merely because the software was upgraded;
- preserves all user IDs and existing foreign-key reference counts;
- leaves completed and removed assignment history untouched;
- allows a previously inconsistent row to be repaired toward agreement, while preventing any new mismatch.

Upgrade tests must cover v7 to v8, fresh schema creation, trigger idempotence through recorded migration version, `PRAGMA foreign_key_check`, and the existing user-reference inventory. Drizzle schema types need only the new audit event union; SQLite triggers remain in the migration.

## 16. Error handling and recovery details

- Expected protection and compatibility failures create no success audit and revoke no sessions.
- The client does not clear the selected role or reason on any recoverable error.
- Assignment errors show grouped role counts, representative recording titles, and **Open active assignments**. The link uses the existing user filter so the complete blocker set is visible.
- OIDC-linked rows show this note when Dirty: **Institutional sign-in is linked. Set exactly one Authentik role group for <New role> before this account signs in again.**
- Break-glass and final-admin guidance is shown before submit when the read-model snapshot already knows it, but the same typed server error is rendered if the state changed after page load.
- Unexpected errors generate a correlation ID, log only that ID plus actor ID, target ID, and stage, and return no raw exception text. Because a network response can be lost after commit, the copy says the outcome is unconfirmed and requires refresh before retry.
- `AUTH_EXPIRED` follows the existing safe sign-in return-route behavior. There is no in-place credential recovery for a role mutation because no unsaved content needs to remain after navigation; the entered reason remains only in memory and is never browser-persisted.

## 17. Observability

### 17.1 Success

- Canonical governed event: one `audit_events.type = account.role_changed` row in the transaction.
- Session diagnostics: existing `auth.session.revoked` security events use reason `account_role_changed` for each revoked active session.
- The success response includes `revokedSessionCount`; the audit metadata stores the same count and resulting authorization version.

### 17.2 Denial

Record a best-effort redacted security event for server-side denials:

- type `account.role_change.denied`;
- outcome `denied`;
- `userId` equal to actor ID;
- metadata limited to target user ID and stable denial code.

Do not log email, display name, requested reason, session IDs, Authentik subject, raw group IDs, or claims.

### 17.3 Unexpected failure

Emit a structured server error with correlation ID, actor ID, target ID, and transaction stage. The client receives only the safe copy and correlation ID. A logging or diagnostic-event failure cannot turn a denied request into success or weaken transaction rollback.

## 18. Test matrix

The Phase 2 implementation begins with a failing browser test proving that the current Accounts role cell is read-only and that no Save role flow exists. Tests then proceed from the transaction service outward. The matrix below is acceptance coverage, not optional examples.

| Approved requirement | Unit and real-DB integration | Component | End-user-aligned E2E |
|---|---|---|---|
| Every account row has inline role dropdown | Read model returns all roles and management facts for local, linked, shadow, active, and inactive rows | Table and responsive copies expose uniquely labelled controlled selects with shared state | Admin opens Accounts on desktop and tablet; every seeded account row has its role select |
| Different role reveals required reason, Save, Cancel | Strict schema rejects empty, 9-char, 501-char, invalid role, and no-op input; accepts trimmed 10-500 | Selection reveals exact controls; reselect and Cancel clear draft; reason uses visible label | Keyboard changes a role, Tabs through reason/Save/Cancel, and Escape cancels |
| Server-side administrator enforcement | Service rejects forged non-admin and inactive actor inside transaction; action rejects missing session | Client hiding is not asserted as authority | Non-admin cannot open Administration; a stale admin session demoted elsewhere cannot submit a second role change |
| Change another account | Transaction returns updated user and leaves actor session active | Success updates row, announces change, focuses select | Admin changes a local account and remains on Accounts |
| Session revocation and re-login | Success increments auth version exactly once, revokes every active target session across each applicable auth source with the correct reason, and new validation fails | Pending is single-submit; self versus other success paths differ | Target signed in in two browser contexts is redirected within the existing poll budget; protected request fails immediately; re-login reflects new role |
| Self-demotion | Self target is allowed when another active admin exists; actor audit snapshot remains admin; actor session is revoked | Self success performs sign-in navigation rather than stale focus restoration | With two active admins, actor demotes self, lands on role-changed sign-in, reauthenticates under new role, and loses Administration navigation |
| Final-admin protection | Self and other-target demotion of the sole active admin return `LAST_ACTIVE_ADMIN`; no writes; two concurrent demotions leave one admin; direct SQL trigger rejects zero-admin state | Known snapshot guidance and server error focus the alert without clearing reason | Sole active admin attempts demotion and sees actionable copy; role, auth version, session, and audit remain unchanged |
| Break-glass protection | Service and existing trigger reject demotion; transfer then allows old custodian change; no partial writes | Dirty editor shows transfer guidance; server error focuses alert | Designated custodian row cannot be demoted and points to transfer procedure; DB facts remain unchanged |
| Assignment compatibility | Reviewer to approver/uploader/admin and approver to reviewer/uploader/admin are blocked with grouped facts; compatible snapshot and historical rows behave exactly as specified; assignment-role race cannot commit mismatch | Blocker message lists counts/titles and filtered assignment link; reason is retained | Active reviewer assignment blocks change with recording guidance; after admin resolves the assignment, the role change succeeds |
| Transaction rollback | Inject an audit insert abort and separately a session update abort; assert role, auth version, sessions, audit, security events, and state version all roll back | Internal failure keeps selected role and reason and focuses safe alert | Install a temporary E2E database trigger that aborts `account.role_changed` audit insertion, submit through browser, assert safe error and unchanged role/session, then remove trigger |
| Compare-and-set concurrency | Two requests with one expected role yield one success and one `STATE_CHANGED`; stale actor authorization is rejected | Refresh preserves reason when requested role still differs and collapses if another writer made the same change | Two admin browser contexts edit the same target; loser sees current role and cannot overwrite silently |
| OIDC role-source semantics | Linked user keeps identity link; old mapped claim becomes `role_mismatch`; target mapped claim admits new role; local credential behavior follows auth mode | Dirty linked row shows exact one-group coordination note | Fake OIDC target is changed locally: old group sign-in is denied, target group sign-in succeeds, no link or user ID changes |
| Audit completeness | Exactly one event has actor, target, old role, new role, trimmed reason, same operation time, resulting auth version, and revoked count; failure writes none | Success notice uses old/new labels without exposing internals | Runtime DB assertion verifies audit event after browser save, including self-demotion attribution |
| Pending and duplicate-submit behavior | One service invocation per action call; conditional update prevents repeats | Deferred promise shows `Saving role...`, `aria-busy`, all mutations disabled, Cancel disabled, and one call despite repeated Enter/click | Delay the administration POST, assert visible pending state and disabled controls, then release and verify one audit event |
| Error copy and recovery | Every stable code maps to exact safe copy; unexpected errors include correlation ID only | Field error focuses reason; row errors focus alert; input retained; retry works | Final-admin, assignment, stale-state, and injected internal-error paths show procedural copy without SQL or stack text |
| Keyboard interaction | Native behavior needs no domain test | Arrow/type-ahead change, Tab order, Enter submit, Escape cancel, pending Escape no-op | Complete one edit without pointer input and verify focus at each step |
| Focus behavior | Success response identifies self versus other target | Cancel and other-target success focus visible select; field errors focus reason; row errors focus alert; no disappearing focused control | Browser verifies Cancel, validation failure, assignment failure, success, and self-redirect focus destinations |
| Phone read-only behavior | `isPhoneSafetyMode` boundaries remain exact | Portrait and coarse-pointer landscape render facts with no role, account-creation, assignment, designation, key-enrollment, or recovery-code mutation controls; viewport transition clears only unsaved role draft | 390x844 portrait and 844x390 coarse-pointer contexts show account and break-glass facts but no role dropdown, reason, Save role, Cancel, Create account, Assign work, designation, key-enrollment, or recovery-code actions; direct server authorization tests remain separate |
| Migration and direct-writer defense | Fresh/v7 upgrade, trigger behavior, assignment race, final-admin trigger, foreign-key check, reference inventory | Not applicable | Container suite boots and upgrades with schema v8 before role-management flows |
| Appearance defect excluded | No production or test dependency on the separate defect | No snapshots or selectors for that defect | Role E2E does not alter or assert the unrelated appearance path |

## 19. Acceptance boundary

The design is complete when the implementation demonstrates all of the following in one shipped change:

- role editing is discoverable and usable inline on supported administration surfaces;
- phone administration remains read-only;
- all authority and protection rules are enforced under one immediate server transaction;
- no successful operation can omit its audit, auth-version increment, or full active-session revocation;
- no failure can commit a subset of those writes;
- local and OIDC-linked role semantics remain fail-closed and explicit;
- assignment, final-admin, and break-glass races cannot violate durable invariants;
- keyboard, focus, pending, error, responsive, unit, component, local E2E, and container E2E evidence all pass;
- the unrelated appearance-rendering defect remains untouched.
