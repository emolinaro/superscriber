# Superscriber Governed Casefile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Governed Casefile redesign with truthful role and revision state, append-only assignment history, audited admin action mode, transcript-first review, role-aware work ledgers, focused ingest, safe export, and phone read-only behavior.

**Architecture:** Keep Next.js server components responsible for principal-aware read models and use small client islands for editing, media, dialogs, filtering, upload, and phone-safety behavior. Move governed revision transitions from whole-state rewrites into targeted SQLite transactions, derive all UI commands from server capabilities, and preserve the existing snapshot adapter only for ingest and orchestration while state-version conflicts prevent it from overwriting targeted writes.

**Tech Stack:** Next.js 16.2.4, React 19.2.5, TypeScript 6.0.3, SQLite with better-sqlite3 12.9.0 and Drizzle 0.45.2, Auth.js 4.24.14, Zod 4.3.6, Vitest 3.2.4, Testing Library, Playwright 1.59.1, and axe-core Playwright checks.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-08-01-superscriber-governed-casefile-design.md` is authoritative. Do not reopen product decisions.
- Preserve `/`, `/workspace`, and `/recordings/[recordingId]`; add `/ingest` and `/administration?section=accounts|assignments|policy`.
- Authenticated navigation is exact: uploader gets Work and Ingest; reviewer gets Work; approver gets Work; admin gets Work, Ingest, and Administration.
- Admin defaults to read-only oversight. Edit, save, submit, withdraw, approve, request changes, reopen, and export require a record-bound reviewer or approver action session.
- Admin action-session purpose and withdrawal, request-changes, and reopen reasons are 10 to 500 trimmed characters. Action sessions expire exactly 30 minutes after entry.
- Approval note is optional and no longer than 500 characters. Ingest title is required and 1 to 120 trimmed characters.
- Only `submittedByUserId` can withdraw a pending revision. The submitting user cannot approve or request changes, including an admin switching effective roles.
- Legacy pending revisions with null submitter identity can be approved or returned by an authorized approver but cannot be withdrawn.
- Approval completes every active reviewer and approver assignment in the same transaction and keeps append-only history. Reopen never reactivates assignments.
- Completed assignment access is limited to its approved revision snapshot. Removed assignment history grants no access.
- Raw media download remains blocked. Media playback and approved export remain policy-gated.
- Export always resolves the recording's active `approvedRevisionId`, records `export.issued` only after bytes are built, and returns `Cache-Control: no-store`.
- Keep all seven export formats and groups: Document (`DOCX`, `TXT`), Captions (`SRT`, `VTT`), Structured data (`CSV`, `TSV`, `JSON`).
- Keep ingest chunks at 1 MiB and abandoned incomplete upload cleanup at 24 hours. Local storage contains only resumable session and file identity metadata.
- Only an ingest session's creator can append or finalize bytes. Admin oversight can inspect another user's session but cannot mutate its bytes.
- Phone safety mode is active below 768 CSS px width or when the primary pointer is coarse and viewport height is below 768 CSS px. It takes precedence over width-only layout bands.
- Phone safety mode permits setup, login, logout, session recovery, work/status, authorized read-only casefile, policy-permitted playback, upload/resume/restart, and supported audio recording.
- Phone safety mode must not render or dispatch transcript mutation, withdrawal, approval, request changes, reopen, export, account mutation, assignment mutation, or admin action-mode entry.
- Do not persist transcript text or credentials to local storage, session storage, query strings, analytics, or logs.
- Transcript saves continue to send the complete current segment array. Do not add timing edits, segment split/merge, or a patch protocol.
- Preserve the appliance's offline runtime. Fonts and icons must not make runtime network requests.
- Add only these exact dependencies: `@fontsource-variable/public-sans@5.3.0`, `@fontsource-variable/newsreader@5.3.0`, `@fontsource/ibm-plex-mono@5.3.0`; add only these exact dev dependencies: `@axe-core/playwright@4.12.1`, `@testing-library/jest-dom@7.0.0`, `@testing-library/react@16.3.2`, `@testing-library/user-event@14.6.1`, `jsdom@30.0.1`.
- Bundle Public Sans variable 400-700, Newsreader variable 500-600, and IBM Plex Mono 500 plus their OFL-1.1 license files.
- Use the exact color, typography, spacing, radius, shadow, responsive, and motion tokens from the approved specification.
- Every interactive target is at least 44 by 44 CSS px. Normal text contrast is at least 4.5:1; large text and essential non-text UI are at least 3:1; focus indicator contrast is at least 3:1.
- Desktop transcript begins within 400 px of the document top; a 390 px phone transcript begins within 500 px. There is no page-level horizontal scroll at 320 or 390 CSS px.
- Use explicit UTC display such as `01 Aug 2026, 14:32 UTC`; expose the full ISO UTC value to assistive technology.
- Status is never color-only. Use one `h1`, semantic landmarks, a skip link, stable field labels, error summaries, live regions, focus containment, inert modal background, body scroll lock, and focus restoration.
- Save preserves transcript scroll and field focus. State transitions focus and announce the updated case state without redirecting to page top.
- In-place session recovery preserves unsaved transcript content in memory and never automatically retries a governed decision.
- Stale draft conflicts preserve local text, identify loaded and current revision IDs, and require explicit confirmation before discard.
- User copy must state what happened, what is safe, and what happens next. Remove prototype, migration, adapter, orchestration-layer, and implementation-scope language.
- Do not add bulk actions, policy editing, account deactivation, role changes, password reset, SSO, multi-tenancy, raw media download, upload cancellation, or a separate export center.
- Do not manually edit `CHANGELOG.md` or generated files.
- Every implementation task follows red-green TDD, runs the exact focused tests listed, runs typecheck before commit, and creates only the scoped commit listed.
- The final gate is `npm run typecheck`, `npm test`, `npm run build`, `npm run worker:check`, `npm run e2e`, and `npm run e2e:container` with all checks passing.

---

## Existing Repository Map

- `app/page.tsx` chooses bootstrap or login and currently renders a two-panel marketing-heavy auth page.
- `app/workspace/page.tsx` currently combines session chrome, role hero, metrics, assigned desk, ingest, policy, six queue cards, admin controls, and implementation notes.
- `app/recordings/[recordingId]/page.tsx` currently combines review hero, summary cards, transcript, governance, history, and audit.
- `app/actions.ts` currently owns auth, account, assignment, save, submit, approve, and reopen server actions and redirects after mutations.
- `app/api/ingest/**` exposes create, inspect, append, and finalize around the resumable upload service.
- `app/api/recordings/[recordingId]/status/route.ts` returns orchestration and revision pointers.
- `app/api/recordings/[recordingId]/transcript/route.ts` validates approved export and returns attachment bytes but does not audit issuance.
- `app/globals.css` is a 1,625-line global stylesheet with old gradients, 24-30 px radii, cards, waveform, action rail, and shell-relative export styles.
- `src/components/review-workspace.tsx` is an 870-line client component combining media analysis, waveform, transcript state, export modal, editing, and decisions.
- `src/components/ingest-panel.tsx` is a 552-line client component containing the working 1 MiB chunk protocol, MediaRecorder flow, and resumable metadata.
- `src/components/admin/admin-control-panel.tsx` combines account creation, assignment creation, active assignment listing, and removal.
- `src/components/session-bar.tsx` and `src/components/auth/logout-button.tsx` provide current account chrome.
- `src/domain/models.ts` defines role, recording, revision, approval, audit, assignment, policy, and snapshot types without actor-user or historical-assignment fields.
- `src/domain/workflow.ts` mutates an in-memory `AppState` for ingest and revision transitions; pending saves currently clear `pendingRevisionId`.
- `src/domain/policy.ts` grants admin direct reviewer and approver capabilities and has no state, assignment, or action-session context.
- `src/server/db/client.ts` creates schema imperatively with `CREATE TABLE IF NOT EXISTS` and two one-off column checks.
- `src/server/db/schema.ts` models the current SQLite schema and a unique recording-user assignment row.
- `src/server/store.ts` loads and rewrites workflow snapshot tables and guards writes with `app_state_meta.state_version`.
- `src/server/access/service.ts` lists only active assignments, reactivates existing rows, and grants admins broad access.
- `src/server/repository.ts` builds current workspace and recording read models, applies the non-actionable next-item fallback, and resolves media/export.
- `src/server/ingest/service.ts` preserves resumable transfer but authorizes by route role rather than upload owner.
- `src/server/auth/**` contains local account validation, password hashing, Auth.js configuration, and secret resolution.
- `src/lib/approved-transcript-export.ts` and `src/server/transcript-export.ts` already define and generate all seven approved formats.
- `src/lib/format.ts` currently formats dates without explicit UTC.
- `src/server/**/*.test.ts`, `src/domain/*.test.ts`, and the transcript route tests provide 44 passing unit/integration tests.
- `e2e/appliance.spec.ts` covers bootstrap through export and resumable upload but hardcodes `seg-1` and obsolete fallback text.
- `e2e/review-mobile.regression-1.spec.ts` covers portrait phone read-only behavior and also hardcodes `seg-1`.
- `vitest.config.ts` uses the Node environment; no component DOM setup exists.
- `playwright.config.ts` runs one shared appliance worker and retains trace, screenshot, and video on failure.
- `Dockerfile` copies standalone Next output and static assets but does not currently copy `public/`.

## Target File Map

### Domain, persistence, and server

- Modify `src/domain/models.ts`: add terminal revision states, decision states, actor identity, assignment history, workflow stage, action-session, capability, and view-model types.
- Modify `src/domain/workflow.ts`: retain ingest mutations and `bucketRecording`; remove governed revision mutations after callers move to targeted commands.
- Modify `src/domain/policy.ts`: retain policy profile facts and stop treating admin base role as implicit reviewer/approver authority.
- Create `src/domain/casefile.ts`: derive workflow stage and expose reason/note validators shared by commands and view models.
- Modify `src/server/db/schema.ts`: model governed columns, `schema_migrations`, partial history indexes, and `admin_action_sessions`.
- Create `src/server/db/migrations.ts`: numbered transactional baseline and governed migrations with legacy backfill.
- Create `src/server/db/migrations.test.ts`: fresh, current-schema upgrade, idempotence, assignment, reopen, and failure tests.
- Create `src/server/db/transaction.ts`: targeted transaction wrapper that increments state version.
- Create `src/server/db/mappers.ts`: one row-to-domain mapping source for recordings, revisions, approvals, audit, ingest, and assignments.
- Modify `src/server/db/client.ts`: run migrations before Drizzle access and remove ad hoc schema mutation.
- Modify `src/server/store.ts` and `src/server/store.test.ts`: map new nullable fields and reject stale snapshots after targeted commands.
- Rewrite `src/server/access/service.ts` and extend `src/server/access/service.test.ts`: append-only assignments, history, access grants, removal, completion, and idempotent active assignment.
- Create `src/server/casefile/errors.ts`: stable domain error and safe error-code mapping.
- Create `src/server/casefile/audit.ts`: actor-attributed audit insertion and legacy display normalization.
- Create `src/server/casefile/action-mode.ts` and `.test.ts`: enter, resolve, expire, switch, and exit admin action sessions.
- Create `src/server/casefile/capabilities.ts` and `.test.ts`: pure role, state, assignment, policy, self-approval, and action-mode capability matrix.
- Create `src/server/casefile/commands.ts` and `.test.ts`: targeted save, submit, withdraw, request-changes, approve, and reopen transactions.
- Create `src/server/casefile/read-model.ts` and `.test.ts`: current casefile, uploader status casefile, approved snapshot, governance, action-mode options, and capabilities.
- Create `src/server/work-inbox/service.ts` and `.test.ts`: role tabs, filtering, sorting, rows, counts, and actionable-next logic.
- Create `src/server/administration/service.ts` and `.test.ts`: account, assignment, history, and policy section read models.
- Modify `src/server/repository.ts` and `.test.ts`: delegate reads, retain media/export builders, and issue audited approved export.
- Modify `src/server/ingest/service.ts` and `.test.ts`: principal ownership and stable failures while retaining chunks and cleanup.
- Create `src/server/bootstrap/readiness.ts` and `.test.ts`: safe readiness checks.
- Create `src/lib/command-result.ts`: serializable command result, error codes, mutation result, and conflict snapshot.
- Create `src/lib/safe-return-to.ts` and `.test.ts`: relative authorized-route sanitizer.
- Modify `src/lib/format.ts` and add `src/lib/format.test.ts`: explicit UTC and accessible ISO formatting.
- Modify `src/lib/approved-transcript-export.ts` and `.test.ts`: optional validated admin action-session query parameter.
- Split `app/actions.ts` into `src/server/actions/auth-actions.ts`, `casefile-actions.ts`, `administration-actions.ts`, and `admin-action-mode-actions.ts`; delete `app/actions.ts` after all imports move.

### Routes and APIs

- Move `app/workspace/page.tsx` to `app/(authenticated)/workspace/page.tsx`.
- Move `app/recordings/[recordingId]/page.tsx` to `app/(authenticated)/recordings/[recordingId]/page.tsx`.
- Create `app/(authenticated)/layout.tsx` for the shared app shell.
- Create `app/(authenticated)/ingest/page.tsx` and `app/(authenticated)/administration/page.tsx`.
- Create layout-matched `loading.tsx` files for auth, workspace, ingest, casefile, and administration.
- Create `app/error.tsx`, `app/(authenticated)/error.tsx`, and `app/(authenticated)/recordings/[recordingId]/not-found.tsx`.
- Modify `app/page.tsx` and `app/layout.tsx` for form-first auth, readiness, local fonts, and global styles.
- Modify `app/api/ingest/sessions/**` for principal ownership and stable JSON errors.
- Modify `app/api/recordings/[recordingId]/status/route.ts` for stage/version and status-only access.
- Modify `app/api/recordings/[recordingId]/transcript/route.ts` and `.test.ts` for active approval, action-mode validation, and `export.issued`.
- Keep `app/api/media/[recordingId]/route.ts` range streaming and switch it to the new access grant.

### Components and styles

- Create `src/components/shell/app-shell.tsx` and `account-menu.tsx`.
- Create `src/components/ui/error-summary.tsx`, `inline-notice.tsx`, `status-badge.tsx`, `modal.tsx`, `empty-state.tsx`, `page-skeleton.tsx`, and `phone-safety.tsx`.
- Create component tests beside deterministic UI files with `.test.tsx` and `// @vitest-environment jsdom`.
- Rewrite auth forms and create `src/components/auth/auth-surface.tsx` plus `session-recovery-dialog.tsx`.
- Create `src/components/work/work-inbox.tsx`, `work-filters.tsx`, and `recording-ledger.tsx`.
- Create `src/components/ingest/ingest-flow.tsx`, `source-choice.tsx`, `capture-audio.tsx`, `transfer-progress.tsx`, and `resume-upload-card.tsx`.
- Create `src/components/casefile/casefile-workspace.tsx`, `case-header.tsx`, `media-transport.tsx`, `transcript-document.tsx`, `state-action-bar.tsx`, `governance-drawer.tsx`, `decision-dialog.tsx`, `admin-action-mode-banner.tsx`, `export-dialog.tsx`, and `conflict-panel.tsx`.
- Create `src/components/admin/administration-shell.tsx`, `accounts-section.tsx`, `assignments-section.tsx`, and `policy-section.tsx`.
- Delete replaced `src/components/session-bar.tsx`, `review-workspace.tsx`, `ingest-panel.tsx`, and `admin/admin-control-panel.tsx` after their routes use replacements.
- Replace `app/globals.css` and create `src/styles/tokens.css`, `base.css`, `shell.css`, `auth.css`, `inbox.css`, `ingest.css`, `casefile.css`, `administration.css`, and `responsive.css`.
- Create temporary `src/styles/legacy.css` from still-used old component selectors; remove each feature block with its replacement and delete the empty file in Task 16.
- Create `src/test/setup.ts`; modify `vitest.config.ts`.
- Add font license files under `public/licenses/fonts/`; modify `Dockerfile` to copy `public/`.

### Browser tests

- Create `e2e/support/appliance.ts` for account, auth, file, assignment, revision-row, and phone helpers.
- Rewrite `e2e/appliance.spec.ts` for auth, ingest, administration, and core workflow without generated-ID assumptions.
- Rewrite `e2e/review-mobile.regression-1.spec.ts` for portrait and landscape phone safety.
- Create `e2e/governed-casefile.spec.ts` for withdrawal, request changes, assignment completion, historical access, reopen, admin action mode, separation of duties, and conflicts.
- Create `e2e/accessibility.spec.ts` for axe scans, keyboard, focus, zoom, reduced motion, and export modal behavior.
- Create `e2e/responsive.spec.ts` for 320, 390, 768, 1024, and 1440 geometry assertions.
- Modify `playwright.config.ts` only to add deterministic project metadata or output needed by these tests; keep one worker and retained failure evidence.

## Canonical Interfaces

Use these names and shapes consistently in every task.

```ts
export type ErrorCode =
  | "AUTH_EXPIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "POLICY_DENIED"
  | "ACTION_MODE_REQUIRED"
  | "ACTION_MODE_EXPIRED"
  | "SELF_APPROVAL_FORBIDDEN"
  | "STALE_REVISION"
  | "STATE_CHANGED"
  | "INGEST_RESTART_REQUIRED"
  | "SERVER_ERROR";

export type CasefileConflictSnapshot = {
  recordingId: string;
  loadedRevisionId: string;
  currentRevisionId: string | null;
  updatedAt: string;
  winningStage: CasefileWorkflowStage;
};

export type CommandErrorResult = {
  ok: false;
  code: ErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
  latest?: CasefileConflictSnapshot;
  correlationId?: string;
};
export type CommandResult<T> = { ok: true; data: T; notice: string } | CommandErrorResult;

export function toCommandResultError(error: unknown): CommandErrorResult;
```

```ts
export type ActorContext = {
  userId: string;
  displayName: string;
  baseRole: UserRole;
  effectiveRole: UserRole;
  adminActionSessionId: string | null;
};
export function actorContextForPrincipal(principal: Principal): ActorContext;

export type AssignmentStatus = "active" | "completed" | "removed";
export type AssignmentRole = "reviewer" | "approver";
export type AssignmentEndReason =
  | "approved_revision"
  | "removed_by_admin"
  | "legacy_removed"
  | "legacy_approved_backfill";

export type CasefileWorkflowStage =
  | "needs_ingest_attention"
  | "verifying"
  | "transcribing"
  | "pending_approval"
  | "approved"
  | "changes_requested"
  | "reopened"
  | "draft_review";
export type WorkflowStageInput = Pick<
  Recording,
  | "integrityState"
  | "transcriptJobState"
  | "currentRevisionId"
  | "pendingRevisionId"
  | "approvedRevisionId"
> & {
  originDecision: "changes_requested" | "reopened" | "withdrawn" | null;
};
export function deriveWorkflowStage(input: WorkflowStageInput): CasefileWorkflowStage;

export type AuditMetadata = { version: 1; data: Record<string, unknown> };
export type GovernedAuditEventType =
  | "revision.withdrawn"
  | "approval.changes_requested"
  | "assignment.created"
  | "assignment.completed"
  | "assignment.removed"
  | "admin.action_mode.entered"
  | "admin.action_mode.exited"
  | "admin.action_mode.expired"
  | "export.issued";

export type AssignmentSummary = {
  id: string;
  recordingId: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  userRole: UserRole;
  assignmentRole: AssignmentRole;
  status: AssignmentStatus;
  assignedByUserId: string | null;
  assignedByDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  endReason: AssignmentEndReason | null;
  completedRevisionId: string | null;
};

export type AdminActionSession = {
  id: string;
  adminUserId: string;
  recordingId: string;
  effectiveRole: "reviewer" | "approver";
  purpose: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: "exited" | "expired" | "switched" | null;
};
```

```ts
export type CasefileAccessGrant =
  | { kind: "uploader_status"; recordingId: string }
  | { kind: "active_reviewer"; recordingId: string; assignmentId: string }
  | { kind: "active_approver"; recordingId: string; assignmentId: string }
  | {
      kind: "completed_reviewer" | "completed_approver";
      recordingId: string;
      assignmentId: string;
      revisionId: string;
    }
  | { kind: "admin_oversight"; recordingId: string };

export type CapabilityDenial =
  | "status_only"
  | "not_assigned"
  | "historical_snapshot"
  | "wrong_revision_state"
  | "not_submitter"
  | "same_submitter"
  | "policy"
  | "admin_action_mode_required"
  | "admin_action_mode_expired"
  | "legacy_submitter_unknown";

export type CasefileCapabilities = {
  canViewStatus: boolean;
  canViewTranscript: boolean;
  canViewMedia: boolean;
  canEdit: boolean;
  canSave: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canReopen: boolean;
  canExport: boolean;
  denials: Partial<Record<
    | "viewTranscript"
    | "viewMedia"
    | "edit"
    | "save"
    | "submit"
    | "withdraw"
    | "approve"
    | "requestChanges"
    | "reopen"
    | "export",
    CapabilityDenial
  >>;
};
```

```ts
export type SaveDraftInput = {
  recordingId: string;
  expectedCurrentRevisionId: string;
  summary: string;
  segments: TranscriptSegment[];
  actionModeId?: string | null;
};

export type SubmitRevisionInput = SaveDraftInput & { hasUnsavedChanges: boolean };

export type PendingDecisionInput = {
  recordingId: string;
  expectedPendingRevisionId: string;
  reason: string;
  actionModeId?: string | null;
};

export type ApproveRevisionInput = {
  recordingId: string;
  expectedPendingRevisionId: string;
  note: string;
  actionModeId?: string | null;
};

export type ReopenRevisionInput = {
  recordingId: string;
  expectedApprovedRevisionId: string;
  reason: string;
  actionModeId?: string | null;
};
```

```ts
export type CasefileMutationResult = {
  casefile: CasefileViewModel | null;
  nextPath: string | null;
  focusTarget: "retain" | "case-state";
};

export type CasefileViewModel = {
  recording: Recording;
  workflowStage: CasefileWorkflowStage;
  statusOnly: boolean;
  historicalSnapshot: boolean;
  revision: TranscriptRevision | null;
  accessGrant: CasefileAccessGrant;
  capabilities: CasefileCapabilities;
  assignments: AssignmentSummary[];
  decisions: ApprovalRecord[];
  auditEvents: AuditEvent[];
  ingestionSession: IngestionSession | null;
  transcriptJob: TranscriptJob | null;
  actionMode: AdminActionSession | null;
  actionModeOptions: Array<"reviewer" | "approver">;
  policySummary: string;
};
```

```ts
export type WorkInboxFilters = {
  tab: string | null;
  query: string;
  stage: CasefileWorkflowStage | null;
  source: RecordingSource | null;
  assignmentUserId: string | null;
  sort: "default" | "updated_desc" | "updated_asc";
};

export type WorkInboxRow = {
  recordingId: string;
  title: string;
  stage: CasefileWorkflowStage;
  revisionLabel: string | null;
  sourceLabel: string;
  progressLabel: string | null;
  assignmentLabels: string[];
  updatedAt: string;
  href: string;
  actionable: boolean;
  actionLabel: string | null;
};

export type WorkInboxViewModel = {
  role: UserRole;
  heading: string;
  responsibility: string;
  tabs: Array<{ id: string; label: string; count: number }>;
  activeTab: string;
  resultCount: number;
  nextAction: WorkInboxRow | null;
  rows: WorkInboxRow[];
  filters: WorkInboxFilters;
};

export type AdministrationSection = "accounts" | "assignments" | "policy";
export type AdministrationFilters = {
  query: string;
  assignmentStatus: AssignmentStatus | null;
  assignmentRole: AssignmentRole | null;
  recordingId: string | null;
  userId: string | null;
  fromUtc: string | null;
  toUtc: string | null;
};
export type AdministrationViewModel =
  | { section: "accounts"; users: AccountDirectoryEntry[]; query: string }
  | {
      section: "assignments";
      assignments: AssignmentSummary[];
      recordings: Array<{ id: string; title: string; stage: CasefileWorkflowStage }>;
      assignableUsers: AccountDirectoryEntry[];
      filters: AdministrationFilters;
    }
  | {
      section: "policy";
      profile: PolicyProfile;
      rows: Array<{ capability: string; uploader: string; reviewer: string; approver: string; admin: string }>;
    };

export type UploadSessionStatus = {
  sessionId: string;
  recordingId: string;
  state: IntegrityState;
  integrityState: IntegrityState;
  bytesReceived: number;
  bytesExpected: number;
  progressPercent: number;
  nextAction: "resume" | "restart" | "finalize" | "none";
  verificationSummary: string | null;
  title: string;
  source: RecordingSource;
  tempFilePresent: boolean;
};

export function nextProgressAnnouncement(
  previousBoundary: number,
  nextPercent: number,
): { boundary: number; message: string } | null;

export type BootstrapReadiness = {
  overall: "ready" | "warning" | "blocked";
  checks: Array<{
    id: "database" | "media_storage" | "upload_storage" | "auth_secret" | "engine_configuration";
    state: "ready" | "warning" | "blocked";
    message: string;
  }>;
};
```

```ts
export function runGovernedTransaction<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle?: AppDatabaseBundle,
): T;

export function resolveCasefileAccess(
  principal: Principal,
  recordingId: string,
  requestedRevisionId: string | null,
  db?: AppDatabase,
): CasefileAccessGrant | null;

export type CapabilityFlags = Omit<CasefileCapabilities, "denials">;
export function deriveCapabilityDenials(
  input: {
    principal: Principal;
    grant: CasefileAccessGrant;
    recording: Recording;
    revision: TranscriptRevision | null;
    policyProfileId: PolicyProfileId;
    actionMode: AdminActionSession | null;
  },
  flags: CapabilityFlags,
): CasefileCapabilities["denials"];
export function deriveCasefileCapabilities(input: {
  principal: Principal;
  grant: CasefileAccessGrant;
  recording: Recording;
  revision: TranscriptRevision | null;
  policyProfileId: PolicyProfileId;
  actionMode: AdminActionSession | null;
}): CasefileCapabilities;

export function startAdminActionSession(
  principal: Principal,
  input: { recordingId: string; effectiveRole: "reviewer" | "approver"; purpose: string },
  bundle?: AppDatabaseBundle,
): AdminActionSession;

export function endAdminActionSession(
  principal: Principal,
  input: { recordingId: string; actionModeId: string },
  bundle?: AppDatabaseBundle,
): AdminActionSession;

export function resolveActorContext(
  principal: Principal,
  input: {
    recordingId: string;
    requiredEffectiveRole: "reviewer" | "approver";
    actionModeId: string | null;
  },
  db: AppDatabase,
  now: string,
): ActorContext;
```

```ts
export function saveDraftCommand(
  principal: Principal,
  input: SaveDraftInput,
  bundle?: AppDatabaseBundle,
): TranscriptRevision;
export function submitRevisionCommand(
  principal: Principal,
  input: SubmitRevisionInput,
  bundle?: AppDatabaseBundle,
): TranscriptRevision;
export function withdrawRevisionCommand(
  principal: Principal,
  input: PendingDecisionInput,
  bundle?: AppDatabaseBundle,
): TranscriptRevision;
export function requestChangesCommand(
  principal: Principal,
  input: PendingDecisionInput,
  bundle?: AppDatabaseBundle,
): TranscriptRevision;
export function approveRevisionCommand(
  principal: Principal,
  input: ApproveRevisionInput,
  bundle?: AppDatabaseBundle,
): { revision: TranscriptRevision; completedAssignments: RecordingAssignment[] };
export function reopenRevisionCommand(
  principal: Principal,
  input: ReopenRevisionInput,
  bundle?: AppDatabaseBundle,
): TranscriptRevision;
```

```ts
export async function saveDraftAction(
  input: SaveDraftInput,
): Promise<CommandResult<CasefileMutationResult>>;
export async function submitRevisionAction(
  input: SubmitRevisionInput,
): Promise<CommandResult<CasefileMutationResult>>;
export async function withdrawRevisionAction(
  input: PendingDecisionInput,
): Promise<CommandResult<CasefileMutationResult>>;
export async function requestChangesAction(
  input: PendingDecisionInput,
): Promise<CommandResult<CasefileMutationResult>>;
export async function approveRevisionAction(
  input: ApproveRevisionInput,
): Promise<CommandResult<CasefileMutationResult>>;
export async function reopenRevisionAction(
  input: ReopenRevisionInput,
): Promise<CommandResult<CasefileMutationResult>>;

export type CreateUserInput = {
  displayName: string;
  email: string;
  password: string;
  role: UserRole;
};
export type AssignRecordingInput = { recordingId: string; userId: string };
export type RemoveAssignmentInput = { assignmentId: string };
export type StartAdminActionModeInput = {
  recordingId: string;
  effectiveRole: "reviewer" | "approver";
  purpose: string;
};

export async function createUserAction(
  input: CreateUserInput,
): Promise<CommandResult<{ user: AccountDirectoryEntry }>>;
export async function assignRecordingAction(
  input: AssignRecordingInput,
): Promise<CommandResult<{ assignment: AssignmentSummary; alreadyActive: boolean }>>;
export async function removeRecordingAssignmentAction(
  input: RemoveAssignmentInput,
): Promise<CommandResult<{ assignment: AssignmentSummary }>>;
export async function startAdminActionModeAction(
  input: StartAdminActionModeInput,
): Promise<CommandResult<{ session: AdminActionSession; href: string }>>;
export async function endAdminActionModeAction(
  input: { recordingId: string; actionModeId: string },
): Promise<CommandResult<{ href: string }>>;
```

```ts
export function getCasefile(
  principal: Principal,
  recordingId: string,
  options?: { revisionId?: string | null; actionModeId?: string | null },
  db?: AppDatabase,
): CasefileViewModel | null;
export function parseWorkInboxFilters(
  values: Record<string, string | string[] | undefined>,
  role: UserRole,
): WorkInboxFilters;
export function listWorkInbox(
  principal: Principal,
  filters: WorkInboxFilters,
  db?: AppDatabase,
): WorkInboxViewModel;
export function parseAdministrationSection(value: string | null | undefined): AdministrationSection;
export function parseAdministrationFilters(
  values: Record<string, string | string[] | undefined>,
): AdministrationFilters;
export function listAdministration(
  principal: Principal,
  section: AdministrationSection,
  filters: AdministrationFilters,
  db?: AppDatabase,
): AdministrationViewModel;
export function getBootstrapReadiness(): BootstrapReadiness;
export function sanitizeReturnTo(value: string | null | undefined): string;
export function requireActivePrincipal(returnTo?: string): Promise<Principal>;
export function recordExportIssued(
  input: {
    principal: Principal;
    recordingId: string;
    expectedApprovedRevisionId: string;
    format: ApprovedTranscriptExportFormat;
    actionModeId: string | null;
  },
  bundle?: AppDatabaseBundle,
): AuditEvent;
```

### Test Helper Contracts

Test-only helpers used in snippets must be defined in the named test file with these signatures so examples remain executable:

```ts
function seedCurrentSchemaFixture(
  sqlite: Database.Database,
  options: { approvedWithActiveAssignments: boolean; approvedPointerWithDifferentDraft: boolean },
): void;
function completeForTest(assignmentId: string, revisionId: string, bundle: AppDatabaseBundle): void;
function readRevision(bundle: AppDatabaseBundle, revisionId: string): TranscriptRevision | null;
function readRecording(bundle: AppDatabaseBundle, recordingId?: string): Recording;
function runDecision(
  action: "approve" | "requestChanges",
  principal: Principal,
  bundle: AppDatabaseBundle,
): unknown;
function seedReviewerRows(input: { draft: string[]; pending: string[]; completed: string[] }): void;
function renderCasefile(input: { stage: CasefileWorkflowStage; canEdit: boolean }): RenderResult;
function readAllProductCss(): string;
```

`baseStageInput`, `defaultFilters`, `adminPrincipal`, `reviewerPrincipal`, `submitterPrincipal`, `approver`, `draftInput`, `reviewerInbox`, and database bundles are explicit constants in each owning test file, built from complete model factories in that file. `ModalTestHarness` is a local test component that renders `#app-root`, an Open button, and the modal under test.

## Task 1: Add Numbered Governed Schema Migrations

**Files:**
- Create: `src/server/db/migrations.ts`
- Create: `src/server/db/migrations.test.ts`
- Create: `src/server/db/transaction.ts`
- Create: `src/server/db/mappers.ts`
- Modify: `src/domain/models.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/client.ts`
- Modify: `src/server/store.ts`
- Modify: `src/server/store.test.ts`
- Modify: current model fixtures in `src/domain/workflow.test.ts`, `src/server/orchestration/*.test.ts`, `src/server/ingest/service.test.ts`, and `src/server/repository.test.ts`

**Interfaces:**
- Consumes: current `openAppDatabase`, `AppDatabaseBundle`, `app_state_meta.state_version`, and snapshot mappings.
- Produces: `runMigrations(sqlite, targetVersion?)`, `LATEST_SCHEMA_VERSION`, governed schema columns and tables, `runGovernedTransaction<T>()`, `toRecording(row: RecordingRow): Recording`, and `toRevision(row: RevisionRow): TranscriptRevision`.

- [ ] **Step 1: Write migration tests for a fresh database and current-schema upgrade**

```ts
it("applies baseline and governed migrations exactly once", () => {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  runMigrations(sqlite);
  expect(sqlite.prepare("select version from schema_migrations order by version").all())
    .toEqual([{ version: 1 }, { version: 2 }]);
});

it("preserves legacy rows and normalizes approved assignments and reopened pointers", () => {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, 1);
  seedCurrentSchemaFixture(sqlite, {
    approvedWithActiveAssignments: true,
    approvedPointerWithDifferentDraft: true,
  });
  runMigrations(sqlite);
  expect(sqlite.prepare("select status, end_reason from recording_assignments").all())
    .toContainEqual({ status: "completed", end_reason: "legacy_approved_backfill" });
  expect(sqlite.prepare("select approved_revision_id from recordings where id = ?").get("legacy-reopened"))
    .toEqual({ approved_revision_id: null });
});
```

- [ ] **Step 2: Run the migration tests and verify the red state**

Run: `npm test -- src/server/db/migrations.test.ts`

Expected: FAIL because `@/server/db/migrations` and `schema_migrations` do not exist.

- [ ] **Step 3: Extend domain constants and normalized model fields**

```ts
export const REVISION_STATES = [
  "draft",
  "pending_approval",
  "approved",
  "superseded",
  "withdrawn",
  "changes_requested",
] as const;

export const APPROVAL_STATES = [
  "not_submitted",
  "pending",
  "approved",
  "rejected",
  "reopened",
  "withdrawn",
  "changes_requested",
] as const;
export const ASSIGNMENT_STATUSES = ["active", "completed", "removed"] as const;
export const ADMIN_ACTION_END_REASONS = ["exited", "expired", "switched"] as const;

export type AdminActionSession = {
  id: string;
  adminUserId: string;
  recordingId: string;
  effectiveRole: "reviewer" | "approver";
  purpose: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: "exited" | "expired" | "switched" | null;
};
```

Apply these exact normalized fields:

```ts
// Recording
uploadedByUserId: string | null;
// IngestionSession
createdByUserId: string | null;
// TranscriptRevision
createdByUserId: string | null;
submittedByUserId: string | null;
// ApprovalRecord
actorUserId: string | null;
actorDisplayName: string | null;
effectiveRole: UserRole | null;
adminActionSessionId: string | null;
// AuditEvent
actorUserId: string | null;
actorDisplayName: string | null;
effectiveRole: UserRole | "system" | null;
adminActionSessionId: string | null;
metadata: AuditMetadata;
// RecordingAssignment
assignmentRole: AssignmentRole;
status: AssignmentStatus;
endedAt: string | null;
endReason: AssignmentEndReason | null;
completedRevisionId: string | null;
removedByUserId: string | null;
```

Keep legacy `actorRole` as the base role on approval and audit rows. Keep legacy `rejected` in `APPROVAL_STATES`, and add `withdrawn` plus `changes_requested`; new commands will never write `rejected`.

- [ ] **Step 4: Model the migration table, governed columns, assignment history, and action sessions in Drizzle**

```ts
export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const adminActionSessions = sqliteTable("admin_action_sessions", {
  id: text("id").primaryKey(),
  adminUserId: text("admin_user_id").notNull().references(() => users.id),
  recordingId: text("recording_id").notNull(),
  effectiveRole: text("effective_role").$type<"reviewer" | "approver">().notNull(),
  purpose: text("purpose").notNull(),
  startedAt: text("started_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  endedAt: text("ended_at"),
  endReason: text("end_reason").$type<"exited" | "expired" | "switched">(),
});
```

Retain the physical `is_active` assignment column during migration compatibility, but new reads use normalized `status`.

- [ ] **Step 5: Move baseline SQL into migration 1 and add governed migration 2**

```ts
export const LATEST_SCHEMA_VERSION = 2;

const migrations: Migration[] = [
  { version: 1, name: "baseline-appliance", up: createBaselineSchema },
  { version: 2, name: "governed-casefile", up: addGovernedCasefileSchema },
];

export function runMigrations(sqlite: Database.Database, targetVersion = LATEST_SCHEMA_VERSION) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of migrations.filter((entry) => entry.version <= targetVersion)) {
    if (hasMigration(sqlite, migration.version)) continue;
    sqlite.transaction(() => {
      migration.up(sqlite);
      sqlite.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}
```

Migration 2 must add columns only when absent, default legacy audit metadata to `{ "version": 1, "data": { "legacy": true } }`, drop `recording_assignments_recording_user_unique`, create a partial unique assignment index on `(recording_id, user_id, assignment_role) WHERE status = 'active'`, create a partial unique action-session index on `(admin_user_id, recording_id) WHERE ended_at IS NULL`, backfill status and roles, complete legacy approved assignments, normalize legacy reopened pointers, and insert one system migration audit event per normalization. A migration exception rolls back that numbered migration and throws `Database migration <version> failed.` while server logs retain the original operator detail.

- [ ] **Step 6: Add the targeted transaction helper**

```ts
export function runGovernedTransaction<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): T {
  return bundle.sqlite.transaction(() => {
    const result = operation(bundle.db, new Date().toISOString());
    bundle.db.update(appStateMeta)
      .set({ stateVersion: sql`${appStateMeta.stateVersion} + 1` })
      .where(eq(appStateMeta.id, 1))
      .run();
    return result;
  })();
}
```

- [ ] **Step 7: Run migrations before Drizzle access and update snapshot mappings**

```ts
const sqlite = new Database(path);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
runMigrations(sqlite);
return { sqlite, db: drizzle(sqlite, { schema }) };
```

Move row normalization into `src/server/db/mappers.ts` and map every new nullable recording, ingest, revision, approval, audit, and assignment field there. Reuse those mappers from `loadState`, access, commands, and read models. Do not put `recording_assignments` or `admin_action_sessions` into the snapshot rewrite set.

- [ ] **Step 8: Add the stale-snapshot regression after a targeted transaction**

```ts
const snapshot = readState(first.db);
runGovernedTransaction((db) => {
  db.update(recordings).set({ title: "Targeted write" }).where(eq(recordings.id, targetId)).run();
}, second);
expect(() => writeState(snapshot, first.db)).toThrow(/State changed concurrently/);
```

- [ ] **Step 9: Run focused persistence tests**

Run: `npm test -- src/server/db/migrations.test.ts src/server/store.test.ts`

Expected: PASS for fresh migration, legacy upgrade, idempotence, normalization, and stale-snapshot protection.

- [ ] **Step 10: Run all unit tests and typecheck**

Run: `npm test && npm run typecheck`

Expected: 44 existing tests plus migration tests PASS; TypeScript exits 0 after every fixture includes the new nullable fields.

- [ ] **Step 11: Commit the persistence foundation**

```bash
git add src/domain/models.ts src/domain/workflow.test.ts src/server/db src/server/store.ts src/server/store.test.ts src/server/orchestration src/server/ingest/service.test.ts src/server/repository.test.ts
git commit -m "feat(db): add governed casefile migrations"
```

## Task 2: Make Assignments Append-Only and Access Grants Revision-Bound

**Files:**
- Modify: `src/server/access/service.ts`
- Modify: `src/server/access/service.test.ts`
- Create: `src/server/casefile/audit.ts`
- Modify: `app/actions.ts` temporarily to pass the authenticated principal into assignment calls
- Modify: `app/workspace/page.tsx` temporarily to consume normalized active assignment summaries

**Interfaces:**
- Consumes: governed assignment schema, `runGovernedTransaction`, `Principal`, `AssignmentStatus`, and audit actor fields from Task 1.
- Produces: `assignRecordingToUser`, `removeRecordingAssignment`, `completeActiveAssignmentsForApproval`, `listAssignments`, and `resolveCasefileAccess` with these exact signatures.

```ts
export function assignRecordingToUser(
  params: { recordingId: string; userId: string; assignedBy: Principal },
  bundle?: AppDatabaseBundle,
): { assignment: RecordingAssignment; alreadyActive: boolean };

export function removeRecordingAssignment(
  params: { assignmentId: string; removedBy: Principal },
  bundle?: AppDatabaseBundle,
): RecordingAssignment;

export function completeActiveAssignmentsForApproval(
  params: { recordingId: string; revisionId: string; actor: ActorContext },
  db: AppDatabase,
  now: string,
): RecordingAssignment[];
```

- [ ] **Step 1: Replace current access tests with lifecycle and grant tests**

```ts
it("keeps completed history and creates a new row on reassignment", async () => {
  const first = assignRecordingToUser({ recordingId: "rec-1", userId: reviewer.id, assignedBy: adminPrincipal }, bundle);
  completeForTest(first.assignment.id, "rev-approved", bundle);
  const second = assignRecordingToUser({ recordingId: "rec-1", userId: reviewer.id, assignedBy: adminPrincipal }, bundle);
  expect(second.assignment.id).not.toBe(first.assignment.id);
  expect(listAssignments({ recordingIds: ["rec-1"], statuses: ["completed", "active"] }, bundle.db))
    .toHaveLength(2);
});

it("grants a completed user only the recorded approved snapshot", () => {
  expect(resolveCasefileAccess(reviewerPrincipal, "rec-1", "rev-approved", bundle.db)?.kind)
    .toBe("completed_reviewer");
  expect(resolveCasefileAccess(reviewerPrincipal, "rec-1", "rev-reopened", bundle.db)).toBeNull();
});
```

Also test duplicate active assignment idempotence, partial-index race, manual removal revocation, uploader ownership status grant, active reviewer and approver grants, and admin oversight.

- [ ] **Step 2: Run focused tests and verify old reactivation behavior fails**

Run: `npm test -- src/server/access/service.test.ts`

Expected: FAIL because the current service reactivates the same assignment row and has no completed snapshot grant.

- [ ] **Step 3: Add one audit insertion helper**

```ts
export function insertAuditEvent(
  db: AppDatabase,
  params: {
    workspaceId: string;
    recordingId: string | null;
    actor: ActorContext | null;
    type: AuditEvent["type"];
    detail: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  },
): AuditEvent;
```

`insertAuditEvent` serializes `metadata` as `{ version: 1, data: metadata } satisfies AuditMetadata`. For native uploader or admin actions, pass `actorContextForPrincipal(principal)`, which sets base/effective role to the principal role and action-session ID to null. For `actor: null`, store system base/effective role, null user, and `User identity unavailable for this legacy event.` only at display time, not as the event detail.

- [ ] **Step 4: Replace assignment reactivation with append-only insertion**

```ts
const active = db.select().from(recordingAssignments).where(and(
  eq(recordingAssignments.recordingId, params.recordingId),
  eq(recordingAssignments.userId, params.userId),
  eq(recordingAssignments.assignmentRole, user.role),
  eq(recordingAssignments.status, "active"),
)).get();
if (active) return { assignment: toAssignment(active), alreadyActive: true };
```

Insert a new UUID row with role snapshot, `status: "active"`, null ending fields, `isActive: true`, and an `assignment.created` audit event in one governed transaction.

- [ ] **Step 5: Implement removal and approval completion without deletion**

```ts
db.update(recordingAssignments).set({
  status: "removed",
  isActive: false,
  endedAt: now,
  endReason: "removed_by_admin",
  removedByUserId: params.removedBy.userId,
  updatedAt: now,
}).where(and(
  eq(recordingAssignments.id, params.assignmentId),
  eq(recordingAssignments.status, "active"),
)).run();
```

`completeActiveAssignmentsForApproval` updates every active row to completed, sets `completedRevisionId`, and appends one `assignment.completed` event per row using the transaction supplied by the approval command.

- [ ] **Step 6: Implement current and historical access grants**

Use this precedence: admin oversight; uploader creator status; active assignment for current casefile; completed assignment only when `requestedRevisionId` equals `completedRevisionId`; otherwise null. Removed rows never contribute.

```ts
if (principal.role === "admin") return { kind: "admin_oversight", recordingId };
if (recording.uploadedByUserId === principal.userId) return { kind: "uploader_status", recordingId };
const active = findActiveAssignment(db, principal.userId, recordingId);
if (active) return { kind: active.assignmentRole === "reviewer" ? "active_reviewer" : "active_approver", recordingId, assignmentId: active.id };
const completed = findCompletedAssignment(db, principal.userId, recordingId, requestedRevisionId);
return completed ? toCompletedGrant(completed) : null;
```

- [ ] **Step 7: Update temporary current callers so the intermediate commit compiles**

Pass `assignedBy: principal` and `removedBy: principal` from `app/actions.ts`. Keep `listAssignments()` defaulting to active rows so the old admin panel remains functional until Task 15.

```ts
assignRecordingToUser({ recordingId, userId, assignedBy: principal });
removeRecordingAssignment({ assignmentId, removedBy: principal });
```

- [ ] **Step 8: Run focused tests, all tests, and typecheck**

Run: `npm test -- src/server/access/service.test.ts && npm test && npm run typecheck`

Expected: lifecycle and grant tests PASS; all repository tests PASS; TypeScript exits 0.

- [ ] **Step 9: Commit assignment history**

```bash
git add src/server/access src/server/casefile/audit.ts app/actions.ts app/workspace/page.tsx
git commit -m "feat(access): preserve assignment history"
```

## Task 3: Add Audited Admin Action Sessions and Server Capabilities

**Files:**
- Create: `src/domain/casefile.ts`
- Create: `src/server/casefile/errors.ts`
- Create: `src/server/casefile/action-mode.ts`
- Create: `src/server/casefile/action-mode.test.ts`
- Create: `src/server/casefile/capabilities.ts`
- Create: `src/server/casefile/capabilities.test.ts`
- Modify: `src/domain/policy.ts`
- Modify: `src/domain/policy.test.ts`

**Interfaces:**
- Consumes: models, policy profiles, access grants, audit insertion, and targeted transactions.
- Produces: `deriveWorkflowStage`, `validateGovernedReason`, `CasefileCommandError`, action-session lifecycle, `resolveActorContext`, and `deriveCasefileCapabilities` exactly as declared in Canonical Interfaces.

- [ ] **Step 1: Write the workflow-stage table test**

```ts
it.each([
  [{ integrityState: "interrupted" }, "needs_ingest_attention"],
  [{ integrityState: "verifying" }, "verifying"],
  [{ transcriptJobState: "running" }, "transcribing"],
  [{ pendingRevisionId: "rev-pending" }, "pending_approval"],
  [{ approvedRevisionId: "rev-approved", currentRevisionId: "rev-approved" }, "approved"],
  [{ originDecision: "changes_requested" }, "changes_requested"],
  [{ originDecision: "reopened" }, "reopened"],
  [{ currentRevisionId: "rev-draft" }, "draft_review"],
])("derives stage in governing precedence", (overrides, expected) => {
  expect(deriveWorkflowStage({ ...baseStageInput, ...overrides })).toBe(expected);
});
```

- [ ] **Step 2: Write action-session lifecycle tests**

Test entry purpose limits, fixed 30-minute expiry, one active session per admin and recording, switched end reason, explicit exit, lazy expiry audit, wrong user, wrong recording, wrong effective role, non-admin rejection, and ended-session rejection.

```ts
expect(() => resolveActorContext(admin, {
  recordingId: "rec-other",
  requiredEffectiveRole: "approver",
  actionModeId: session.id,
}, db, now)).toThrowError(expect.objectContaining({ code: "ACTION_MODE_REQUIRED" }));
```

- [ ] **Step 3: Write the complete capability matrix as table-driven tests**

Include processing, draft, pending, approved, historical, uploader status, active reviewer, active approver, completed reviewer, completed approver, admin oversight, admin reviewer mode, admin approver mode, strict policy, reviewable export policy, legacy null submitter, and same-submitter denial.

- [ ] **Step 4: Run focused tests and verify the missing-module failures**

Run: `npm test -- src/server/casefile/action-mode.test.ts src/server/casefile/capabilities.test.ts`

Expected: FAIL because action-mode and capability modules do not exist.

- [ ] **Step 5: Implement stage and validation helpers**

```ts
export function validateGovernedReason(value: string) {
  const reason = value.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CasefileCommandError("VALIDATION_ERROR", "Enter a reason between 10 and 500 characters.", {
      reason: "Enter a reason between 10 and 500 characters.",
    });
  }
  return reason;
}
```

Add `validateApprovalNote` with 0 to 500 characters and `deriveWorkflowStage` using the approved precedence.

- [ ] **Step 6: Implement safe typed domain errors**

```ts
export class CasefileCommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly latest?: CasefileConflictSnapshot,
  ) {
    super(message);
  }
}
```

Never pass raw caught database or filesystem exception text into this class for client display.

- [ ] **Step 7: Implement action-session enter, resolve, expire, switch, and exit**

```ts
const expiresAt = new Date(Date.parse(now) + 30 * 60 * 1000).toISOString();
```

Entering a session ends any active same-admin same-record session as switched, appends `admin.action_mode.exited` with `{ endReason: "switched" }`, inserts the new row, and writes `admin.action_mode.entered`. Expiry and explicit exit update once and append exactly one matching audit event.

- [ ] **Step 8: Remove implicit admin review powers from base policy**

`evaluatePolicy(profileId, "admin")` can still return oversight media facts, but edit, submit, approve, reopen, and export are false until `deriveCasefileCapabilities` receives a validated effective action role.

```ts
if (role === "admin") {
  return { ...base, canEditDraft: false, canSubmitForApproval: false, canApprove: false, canDownloadApprovedTranscript: false, canReopenApprovedTranscript: false };
}
```

- [ ] **Step 9: Implement capabilities from state, grant, policy, submitter, and action mode**

Set every boolean and denial reason explicitly. Admin oversight always has `canEdit`, `canSave`, `canSubmit`, `canWithdraw`, `canApprove`, `canRequestChanges`, `canReopen`, and `canExport` false. Completed snapshots cannot expose later-cycle transcript. `canExport` requires active approved pointer and matching current snapshot. `deriveCapabilityDenials` uses this precedence for each false flag: uploader status only, historical snapshot, admin action mode expired, admin action mode required, legacy submitter unknown, same submitter, not submitter, policy, wrong revision state, then not assigned.

```ts
const actorRole = input.actionMode?.effectiveRole ?? input.principal.role;
const policy = evaluatePolicy(input.policyProfileId, actorRole);
const isReviewerActor = actorRole === "reviewer";
const isApproverActor = actorRole === "approver";
const isSubmitter = input.revision?.submittedByUserId === input.principal.userId;
const isAdminOversight = input.grant.kind === "admin_oversight" && !input.actionMode;
const isPending = input.recording.pendingRevisionId === input.revision?.id;
const isApproved = input.recording.approvedRevisionId === input.revision?.id;
const flags: CapabilityFlags = {
  canViewStatus: true,
  canViewTranscript: input.grant.kind !== "uploader_status",
  canViewMedia: input.grant.kind !== "uploader_status" && policy.canViewMedia,
  canEdit: !isAdminOversight && isReviewerActor && input.revision?.state === "draft",
  canSave: !isAdminOversight && isReviewerActor && input.revision?.state === "draft",
  canSubmit: !isAdminOversight && isReviewerActor && input.revision?.state === "draft",
  canWithdraw: !isAdminOversight && isReviewerActor && isPending && isSubmitter,
  canApprove: !isAdminOversight && isApproverActor && isPending && !isSubmitter,
  canRequestChanges: !isAdminOversight && isApproverActor && isPending && !isSubmitter,
  canReopen: !isAdminOversight && isApproverActor && isApproved,
  canExport: !isAdminOversight && isApproved && policy.canDownloadApprovedTranscript,
};
return { ...flags, denials: deriveCapabilityDenials(input, flags) };
```

- [ ] **Step 10: Run focused tests, policy tests, and typecheck**

Run: `npm test -- src/server/casefile/action-mode.test.ts src/server/casefile/capabilities.test.ts src/domain/policy.test.ts && npm run typecheck`

Expected: every stage, lifecycle, and capability row PASS; TypeScript exits 0.

- [ ] **Step 11: Commit action context and capabilities**

```bash
git add src/domain/casefile.ts src/domain/policy.ts src/domain/policy.test.ts src/server/casefile
git commit -m "feat(governance): add audited admin action context"
```

## Task 4: Move Draft Save and Submission Into Targeted Transactions

**Files:**
- Create: `src/server/casefile/commands.ts`
- Create: `src/server/casefile/commands.test.ts`
- Modify: `src/domain/workflow.ts`
- Modify: `src/domain/workflow.test.ts`
- Modify: `src/server/repository.ts`
- Modify: `app/actions.ts` temporarily to call new command wrappers

**Interfaces:**
- Consumes: actor resolution, capability derivation, transaction helper, revision schema, and audit helper.
- Produces: `saveDraftCommand` and `submitRevisionCommand` with the Canonical Interfaces signatures.

- [ ] **Step 1: Write save and submit transaction tests**

```ts
it("supersedes the prior draft and saves a complete next revision", () => {
  const saved = saveDraftCommand(reviewerPrincipal, draftInput, bundle);
  expect(saved.version).toBe(2);
  expect(saved.state).toBe("draft");
  expect(readRevision(bundle, "rev-1")?.state).toBe("superseded");
  expect(readRecording(bundle).currentRevisionId).toBe(saved.id);
});

it("atomically saves unsaved content and submits the resulting revision", () => {
  const submitted = submitRevisionCommand(reviewerPrincipal, {
    ...draftInput,
    hasUnsavedChanges: true,
  }, bundle);
  expect(submitted.state).toBe("pending_approval");
  expect(submitted.submittedByUserId).toBe(reviewerPrincipal.userId);
  expect(readRecording(bundle).pendingRevisionId).toBe(submitted.id);
});
```

Also test pending and approved save rejection, complete-segment protection, stale expected ID, empty segments, active reviewer requirement, admin reviewer mode requirement, action-session expiry, and one audit event per successful command.

- [ ] **Step 2: Run focused tests and verify the red state**

Run: `npm test -- src/server/casefile/commands.test.ts`

Expected: FAIL because targeted draft commands do not exist.

- [ ] **Step 3: Implement common transaction record loading and authorization**

```ts
function requireRecording(db: AppDatabase, recordingId: string): Recording {
  const row = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
  if (!row) throw new CasefileCommandError("NOT_FOUND", "Recording not found.");
  return toRecording(row);
}

function requireRevision(db: AppDatabase, revisionId: string): TranscriptRevision {
  const row = db.select().from(revisions).where(eq(revisions.id, revisionId)).get();
  if (!row) throw new CasefileCommandError("NOT_FOUND", "Transcript revision not found.");
  return toRevision(row);
}

function loadCommandState(db: AppDatabase, principal: Principal, input: { recordingId: string; actionModeId?: string | null }, now: string) {
  const recording = requireRecording(db, input.recordingId);
  const revision = recording.currentRevisionId ? requireRevision(db, recording.currentRevisionId) : null;
  const grant = resolveCasefileAccess(principal, recording.id, null, db);
  if (!grant) throw new CasefileCommandError("ACCESS_DENIED", "This casefile is not available to your account.");
  const actor = resolveActorContext(principal, {
    recordingId: recording.id,
    requiredEffectiveRole: "reviewer",
    actionModeId: input.actionModeId ?? null,
  }, db, now);
  return { recording, revision, grant, actor };
}
```

Non-admin reviewers still require an active reviewer assignment. Admin reviewer mode does not create one.

- [ ] **Step 4: Implement immutable draft version saves**

Within one `runGovernedTransaction`, validate expected ID and draft state, set prior state to superseded, insert the next version with actor user and effective role, move the recording pointer, and append `revision.saved` metadata with prior/new IDs and version.

```ts
db.update(revisions).set({ state: "superseded" }).where(eq(revisions.id, prior.id)).run();
db.insert(revisions).values({ ...nextRevision, state: "draft", createdByUserId: actor.userId, createdByRole: actor.effectiveRole }).run();
db.update(recordings).set({ currentRevisionId: nextRevision.id, updatedAt: now }).where(eq(recordings.id, recording.id)).run();
```

- [ ] **Step 5: Implement submit with optional preceding save in the same transaction**

Do not nest `runGovernedTransaction`. Extract an internal `saveDraftInTransaction` helper. If `hasUnsavedChanges` is true, save then submit that returned ID. Mark pending, set submitter user, set pointers, append pending decision, and append `revision.submitted`.

```ts
const target = input.hasUnsavedChanges
  ? saveDraftInTransaction(db, actor, recording, revision, input, now)
  : revision;
db.update(revisions).set({ state: "pending_approval", submittedAt: now, submittedByUserId: actor.userId }).where(eq(revisions.id, target.id)).run();
db.update(recordings).set({ currentRevisionId: target.id, pendingRevisionId: target.id, updatedAt: now }).where(eq(recordings.id, recording.id)).run();
```

- [ ] **Step 6: Add conflict snapshots without overwriting local content**

```ts
const latest: CasefileConflictSnapshot = {
  recordingId: recording.id,
  loadedRevisionId: input.expectedCurrentRevisionId,
  currentRevisionId: recording.currentRevisionId,
  updatedAt: recording.updatedAt,
  winningStage: deriveWorkflowStage(loadStageInput(db, recording)),
};
throw new CasefileCommandError(
  "STALE_REVISION",
  "This recording changed since you opened it.",
  undefined,
  latest,
);
```

Define `loadStageInput(db, recording)` in `commands.ts` to read the current revision's latest decision and return the exact `deriveWorkflowStage` input type from Task 3.

- [ ] **Step 7: Move repository and temporary action callers to new commands**

Remove the repository's role-only save and submit wrappers. Update temporary action callers to pass the authenticated principal directly to canonical commands while retaining redirect behavior only until Task 7.

```ts
const saved = saveDraftCommand(principal, input);
const submitted = submitRevisionCommand(principal, submitInput);
```

- [ ] **Step 8: Remove old save and submit mutations from `src/domain/workflow.ts`**

Keep ingest functions and `bucketRecording`. Move relevant workflow tests to the SQLite command suite instead of maintaining two transition implementations.

```bash
for symbol in saveDraftRevision submitRevision approveRevision reopenApprovedRevision; do
  if rg -n "^export function ${symbol}\\b" src/domain/workflow.ts; then exit 1; fi
done
rg -n '^export function (bucketRecording|createSystemDraftRevision|createRecordingEntry|createUploadSessionEntry|noteUploadProgress|expireUploadSession|failUploadSession|finalizeUploadSession)\\b' src/domain/workflow.ts
```

- [ ] **Step 9: Run focused tests, all tests, and typecheck**

Run: `npm test -- src/server/casefile/commands.test.ts src/domain/workflow.test.ts && npm test && npm run typecheck`

Expected: save and submit tests PASS; no old workflow caller remains; all tests and typecheck PASS.

- [ ] **Step 10: Commit targeted draft handoff**

```bash
git add src/server/casefile/commands.ts src/server/casefile/commands.test.ts src/domain/workflow.ts src/domain/workflow.test.ts src/server/repository.ts app/actions.ts
git commit -m "feat(review): transact draft save and submission"
```

## Task 5: Implement Withdrawal, Request Changes, Approval, and Reopen

**Files:**
- Modify: `src/server/casefile/commands.ts`
- Modify: `src/server/casefile/commands.test.ts`
- Modify: `src/server/repository.ts`
- Modify: `app/actions.ts` temporarily

**Interfaces:**
- Consumes: pending/approved command input types, assignment completion, actor context, capabilities, and targeted transactions.
- Produces: `withdrawRevisionCommand`, `requestChangesCommand`, `approveRevisionCommand`, and `reopenRevisionCommand` exactly as declared above.

- [ ] **Step 1: Add transition and separation-of-duties tests**

```ts
it("lets only the submitting user withdraw before a decision", () => {
  const draft = withdrawRevisionCommand(submitterPrincipal, {
    recordingId: "rec-1",
    expectedPendingRevisionId: "rev-pending",
    reason: "I found a material transcript omission.",
  }, bundle);
  expect(readRevision(bundle, "rev-pending")?.state).toBe("withdrawn");
  expect(draft.basedOnRevisionId).toBe("rev-pending");
});

it.each(["approve", "requestChanges"])("prevents the submitting user from %s", (action) => {
  expect(() => runDecision(action, submitterPrincipal, bundle))
    .toThrowError(expect.objectContaining({ code: "SELF_APPROVAL_FORBIDDEN" }));
});
```

Also test legacy null submitter withdrawal denial, 10/500 reason bounds, 500 approval-note bound, request changes cloning, approval pointer/assignment completion, reopen pointer clearing/no assignment reactivation, and admin effective-role attribution.

- [ ] **Step 2: Add first-writer-wins race tests using two database connections**

```ts
const pendingId = "rev-pending";
approveRevisionCommand(approver, { recordingId: "rec-1", expectedPendingRevisionId: pendingId, note: "", actionModeId: null }, first);
expect(() => withdrawRevisionCommand(reviewer, {
  recordingId: "rec-1",
  expectedPendingRevisionId: pendingId,
  reason: "I need to correct newly discovered context.",
}, second)).toThrowError(expect.objectContaining({ code: "STATE_CHANGED" }));
```

Repeat approval versus request changes with the opposite winner.

- [ ] **Step 3: Run focused tests and verify missing transition failures**

Run: `npm test -- src/server/casefile/commands.test.ts`

Expected: FAIL because withdrawal, request-changes, targeted approval completion, reopen, and race handling are not implemented.

- [ ] **Step 4: Implement submitter-only withdrawal**

Validate pending pointer, exact submitter user, known legacy identity, reason, and reviewer actor. Mark pending revision withdrawn, append decision, clone next draft, clear pending, preserve summary/segments, and append `revision.withdrawn`.

```ts
if (!pending.submittedByUserId) throw new CasefileCommandError("ACCESS_DENIED", "Submitter identity is unavailable for this legacy revision.");
if (pending.submittedByUserId !== actor.userId) throw new CasefileCommandError("ACCESS_DENIED", "Only the submitting reviewer can withdraw this revision.");
const draft = cloneTransitionDraft(pending, "withdrawn", actor, now);
```

- [ ] **Step 5: Implement request changes**

Validate effective approver, different user from submitter, reason, and expected pending ID. Mark `changes_requested`, append decision, clone next draft, preserve all assignments, and append `approval.changes_requested` with `legacySubmitterIdentityMissing` metadata when applicable.

```ts
assertDifferentSubmitter(pending.submittedByUserId, actor.userId);
db.update(revisions).set({ state: "changes_requested" }).where(eq(revisions.id, pending.id)).run();
const draft = insertTransitionDraft(db, pending, actor, now);
db.update(recordings).set({ currentRevisionId: draft.id, pendingRevisionId: null, updatedAt: now }).where(eq(recordings.id, recording.id)).run();
```

- [ ] **Step 6: Implement approval with atomic assignment completion**

```ts
const completedAssignments = completeActiveAssignmentsForApproval({
  recordingId: recording.id,
  revisionId: revision.id,
  actor,
}, db, now);
```

In the same transaction mark approved, set pointers and time, append approved decision and `approval.approved`, complete assignments, and return both revision and completed rows.

- [ ] **Step 7: Implement reopen without mutating approved history**

Validate active approved pointer, grant, effective approver, expected ID, and reason. Append reopened decision, clear `approvedRevisionId`, clone next draft, leave old revision approved, leave assignments unchanged, and append `approval.reopened`.

```ts
const draft = insertTransitionDraft(db, approved, actor, now);
db.update(recordings).set({ currentRevisionId: draft.id, approvedRevisionId: null, pendingRevisionId: null, updatedAt: now }).where(eq(recordings.id, recording.id)).run();
```

- [ ] **Step 8: Map winning transitions to `STATE_CHANGED`**

Decision commands must distinguish stale draft (`STALE_REVISION`) from a pending/approved pointer that already transitioned (`STATE_CHANGED`) and attach the current stage snapshot.

- [ ] **Step 9: Run command tests repeatedly to check race stability**

Run: `npm test -- src/server/casefile/commands.test.ts && npm test -- src/server/casefile/commands.test.ts`

Expected: both consecutive runs PASS with deterministic first-writer outcomes and no duplicate decision/audit rows.

- [ ] **Step 10: Run all tests and typecheck**

Run: `npm test && npm run typecheck`

Expected: all tests PASS; TypeScript exits 0.

- [ ] **Step 11: Commit the full governed lifecycle**

```bash
git add src/server/casefile/commands.ts src/server/casefile/commands.test.ts src/server/repository.ts app/actions.ts
git commit -m "feat(workflow): govern revision decisions"
```

## Task 6: Build Principal-Aware Casefile, Work Inbox, and Administration Read Models

**Files:**
- Create: `src/server/casefile/read-model.ts`
- Create: `src/server/casefile/read-model.test.ts`
- Create: `src/server/work-inbox/service.ts`
- Create: `src/server/work-inbox/service.test.ts`
- Create: `src/server/administration/service.ts`
- Create: `src/server/administration/service.test.ts`
- Modify: `src/server/repository.ts`
- Modify: `src/server/repository.test.ts`
- Modify: `src/lib/format.ts`
- Create: `src/lib/format.test.ts`

**Interfaces:**
- Consumes: `resolveCasefileAccess`, stage derivation, capabilities, normalized assignments, decisions, audit, and action sessions.
- Produces: `getCasefile`, `listWorkInbox`, `listAdministration`, `WorkInboxViewModel`, `CasefileViewModel`, administration view models, and explicit UTC formatting.

- [ ] **Step 1: Write casefile access and historical snapshot read tests**

Test uploader status-only data excludes revision, media, decisions, and audit; active assignee gets current casefile; completed assignment gets only matching approved snapshot; removed/unassigned principal gets `ACCESS_DENIED`; admin oversight gets current casefile with no governed actions; legacy event attribution displays safe fallback.

- [ ] **Step 2: Write role inbox table tests**

```ts
it("never falls back to a non-actionable reviewer item", () => {
  seedReviewerRows({ draft: [], pending: ["rec-pending"], completed: ["rec-approved"] });
  const inbox = listWorkInbox(reviewer, defaultFilters, bundle.db);
  expect(inbox.nextAction).toBeNull();
  expect(inbox.tabs.find((tab) => tab.id === "waiting")?.count).toBe(1);
});
```

Cover exact tabs, ordering, title/ID search, stage/source/assignment filters, admin severity sorting, uploader ownership, completed links with `?revision=`, removed exclusion, and URL-safe defaults.

- [ ] **Step 3: Write administration and UTC tests**

Test accounts columns, active/history assignment sections, policy matrix, compatible assignment state labels, and `formatDateTimeUtc("2026-08-01T14:32:00.000Z") === "01 Aug 2026, 14:32 UTC"`.

- [ ] **Step 4: Run focused tests and verify missing-module failures**

Run: `npm test -- src/server/casefile/read-model.test.ts src/server/work-inbox/service.test.ts src/server/administration/service.test.ts src/lib/format.test.ts`

Expected: FAIL because the read-model modules and UTC formatter do not exist.

- [ ] **Step 5: Implement `getCasefile` with explicit current versus snapshot behavior**

```ts
export function getCasefile(
  principal: Principal,
  recordingId: string,
  options: { revisionId?: string | null; actionModeId?: string | null } = {},
  db: AppDatabase = getAppDb(),
): CasefileViewModel | null;
```

Return null only when the recording does not exist. Throw `ACCESS_DENIED` for a real unauthorized recording. Uploader status view sets `revision: null`, empty decisions/audit, and media capability false. Completed access resolves the exact completion revision and excludes later-cycle context. Normalize legacy `rejected` decision labels to `Changes requested (legacy)` without changing stored history.

- [ ] **Step 6: Implement role tabs and actionable-next ordering**

Use role-specific tab IDs from the specification. `nextAction` is the first `actionable` row under the role's default ordering or null. Never use `visibleRows[0]` as fallback.

```ts
const ROLE_TABS: Record<UserRole, string[]> = {
  uploader: ["my-uploads", "needs-attention", "processing", "ready"],
  reviewer: ["to-review", "waiting", "completed"],
  approver: ["to-decide", "waiting", "completed"],
  admin: ["all", "needs-attention", "review", "approval", "approved"],
};
const nextAction = orderedRows.find((row) => row.actionable) ?? null;
```

- [ ] **Step 7: Implement server-backed filter parsing and safe labels**

Normalize unknown tabs and sort values to role defaults; trim query; match title or recording ID case-insensitively; derive title, revision, source, progress, assignment, UTC update, href, and action label server-side.

```ts
const query = firstValue(values.query)?.trim() ?? "";
const requestedTab = firstValue(values.tab) ?? null;
const tab = ROLE_TABS[role].includes(requestedTab ?? "") ? requestedTab : null;
const sort = firstValue(values.sort);
return { tab, query, stage: parseStage(values.stage), source: parseSource(values.source), assignmentUserId: firstValue(values.assignmentUserId) ?? null, sort: sort === "updated_desc" || sort === "updated_asc" ? sort : "default" };
```

- [ ] **Step 8: Implement administration section read models**

Accounts returns searchable users. Assignments defaults active and supports recording, user, role, status, and UTC range. Policy returns facts for playback, raw download, draft edit, submit, withdraw, approve, request changes, reopen, export, and phone safety without mutation controls.

```ts
switch (section) {
  case "accounts": return { section, users: listLocalUsers(db).filter(matchesQuery), query: filters.query };
  case "assignments": return { section, assignments: listAssignments(toAssignmentFilters(filters), db), recordings: listAssignableRecordings(db), assignableUsers: listAssignableUsers(db), filters };
  case "policy": return { section, profile: activeProfile, rows: buildPolicyRows(activeProfile) };
}
```

- [ ] **Step 9: Replace implicit local date formatting with UTC**

```ts
export function formatDateTimeUtc(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value)).replace(", UTC", " UTC");
}
```

Also export `formatDateTimeIso(value)` for accessible full ISO UTC text.

- [ ] **Step 10: Delegate old repository reads and remove non-actionable fallback**

Keep compatibility wrappers only where existing APIs still compile. New routes must use the new principal-aware services directly.

```ts
export { getCasefile } from "@/server/casefile/read-model";
export { listWorkInbox } from "@/server/work-inbox/service";
export { listAdministration } from "@/server/administration/service";
```

- [ ] **Step 11: Run focused tests, all tests, and typecheck**

Run: `npm test -- src/server/casefile/read-model.test.ts src/server/work-inbox/service.test.ts src/server/administration/service.test.ts src/lib/format.test.ts src/server/repository.test.ts && npm test && npm run typecheck`

Expected: all read-model, ordering, filter, snapshot, and UTC cases PASS.

- [ ] **Step 12: Commit read models**

```bash
git add src/server/casefile/read-model* src/server/work-inbox src/server/administration src/server/repository* src/lib/format*
git commit -m "feat(read-models): add role-aware casefile ledgers"
```

## Task 7: Return Typed In-Place Actions and Audit Export Issuance

**Files:**
- Create: `src/lib/command-result.ts`
- Create: `src/server/actions/casefile-actions.ts`
- Create: `src/server/actions/admin-action-mode-actions.ts`
- Create: `src/server/actions/administration-actions.ts`
- Create: `src/server/actions/actions.test.ts`
- Create: `src/server/actions/auth-actions.ts` by moving bootstrap behavior from `app/actions.ts`
- Delete: `app/actions.ts`
- Modify: `app/api/recordings/[recordingId]/status/route.ts`
- Modify: `app/api/recordings/[recordingId]/transcript/route.ts`
- Modify: `app/api/recordings/[recordingId]/transcript/route.test.ts`
- Modify: `app/api/media/[recordingId]/route.ts`
- Modify: `src/lib/approved-transcript-export.ts`
- Modify: `src/lib/approved-transcript-export.test.ts`
- Modify: current component imports temporarily to new action modules

**Interfaces:**
- Consumes: Canonical command inputs/results, casefile commands/read model, action-session service, export generator, and access grants.
- Produces: all six typed casefile actions declared above, typed admin/account/assignment actions, status JSON stage/version, and audited export issuance.

- [ ] **Step 1: Write action-result mapping tests**

```ts
it("maps missing sessions without redirecting or losing client state", async () => {
  vi.mocked(getActivePrincipal).mockResolvedValue(null);
  await expect(saveDraftAction(draftInput)).resolves.toEqual({
    ok: false,
    code: "AUTH_EXPIRED",
    message: "Session expired. Sign in again to continue.",
  });
});
```

Cover validation field errors, stale conflict snapshots, state changes, policy denial, action-mode expiry, self-approval, unknown safe correlation IDs, and successful `focusTarget` values.

- [ ] **Step 2: Extend transcript route tests for audit semantics**

Test admin action-mode query validation, current active approved pointer, 401, 403, 409, successful `export.issued`, and no event when byte generation throws or state is stale.

- [ ] **Step 3: Run focused tests and verify failures**

Run: `npm test -- src/server/actions/actions.test.ts 'app/api/recordings/[recordingId]/transcript/route.test.ts'`

Expected: FAIL because typed action modules and issuance audit do not exist.

- [ ] **Step 4: Implement one safe action wrapper**

```ts
async function runCasefileAction<T>(
  operation: (principal: Principal) => T,
  success: (value: T, principal: Principal) => Promise<CasefileMutationResult>,
  notice: (value: T) => string,
): Promise<CommandResult<CasefileMutationResult>> {
  const principal = await getActivePrincipal();
  if (!principal) return { ok: false, code: "AUTH_EXPIRED", message: "Session expired. Sign in again to continue." };
  try {
    const value = operation(principal);
    return { ok: true, data: await success(value, principal), notice: notice(value) };
  } catch (error) {
    return toCommandResultError(error);
  }
}
```

State-changing results use `focusTarget: "case-state"`; save uses `retain`. Completed approver reopen returns `casefile: null` and `nextPath: "/workspace"`.

- [ ] **Step 5: Implement typed administration and action-mode actions**

Account and assignment drawers receive `CommandResult` rather than query-string redirects. Action-mode entry returns the validated session and casefile URL with `actionMode=${session.id}`; exit returns the oversight URL.

```ts
const session = startAdminActionSession(principal, input);
return {
  ok: true,
  data: { session, href: `/recordings/${input.recordingId}?actionMode=${session.id}` },
  notice: `Admin action mode entered as ${session.effectiveRole}.`,
};
```

- [ ] **Step 6: Move bootstrap action and delete the old action module**

Keep bootstrap's `useActionState` shape until Task 9, but move it under `src/server/actions/auth-actions.ts`. Update every import before deleting `app/actions.ts`.

```ts
// src/server/actions/auth-actions.ts
"use server";
export { createBootstrapAdminAction };
```

Run `rg -n '@/app/actions|app/actions' app src` and require no matches before deleting the old file.

- [ ] **Step 7: Expand status JSON without transcript content**

Return `workflowStage`, `currentRevisionVersion`, pointers, progress, and `updatedAt` only after new access validation. Uploader owners can receive status but not transcript content.

- [ ] **Step 8: Audit approved export issuance after successful generation**

```ts
const payload = await buildApprovedTranscriptExport({ format, recording, revision });
recordExportIssued({
  principal,
  recordingId: recording.id,
  expectedApprovedRevisionId: revision.id,
  format,
  actionModeId,
});
return { fileName, contentType: payload.contentType, body: payload.body };
```

Revalidate active approved pointer inside the issuance transaction. For admin, require the query action-mode ID and effective approver role. Extend `buildApprovedTranscriptExportUrl(baseUrl, format, actionModeId?)` without accepting a revision ID.

- [ ] **Step 9: Switch media authorization to `resolveCasefileAccess`**

Uploader status grants never stream media. Active/current and matching completed snapshot grants can stream only when policy permits. Admin oversight can stream under policy without entering action mode.

```ts
const grant = resolveCasefileAccess(principal, recordingId, requestedRevisionId, db);
if (!grant || grant.kind === "uploader_status") return { denied: true as const, reason: "Media playback is not available for this access grant." };
```

- [ ] **Step 10: Run focused tests, all tests, and typecheck**

Run: `npm test -- src/server/actions/actions.test.ts 'app/api/recordings/[recordingId]/transcript/route.test.ts' src/lib/approved-transcript-export.test.ts && npm test && npm run typecheck`

Expected: typed actions and all export branches PASS; no import references `app/actions.ts`; TypeScript exits 0.

- [ ] **Step 11: Commit typed commands and APIs**

```bash
git add src/lib/command-result.ts src/lib/approved-transcript-export* src/server/actions app/api/recordings app/api/media src/components app/actions.ts
git commit -m "feat(actions): return governed command results"
```

## Task 8: Install UI Test and Font Assets, Then Build the App Shell and Visual Foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Create: `src/components/ui/error-summary.tsx` and `.test.tsx`
- Create: `src/components/ui/inline-notice.tsx`
- Create: `src/components/ui/status-badge.tsx`
- Create: `src/components/ui/modal.tsx` and `.test.tsx`
- Create: `src/components/ui/empty-state.tsx`
- Create: `src/components/ui/page-skeleton.tsx`
- Create: `src/components/ui/phone-safety.tsx` and `.test.ts`
- Create: `src/components/shell/app-shell.tsx` and `.test.tsx`
- Create: `src/components/shell/account-menu.tsx`
- Create: `app/(authenticated)/layout.tsx`
- Move: existing workspace and recording routes under `app/(authenticated)/`
- Create: temporary dedicated `app/(authenticated)/ingest/page.tsx` and `administration/page.tsx` using current components until Tasks 12 and 15
- Modify: moved pages to remove `SessionBar`
- Delete: `src/components/session-bar.tsx` after no imports remain
- Modify: `app/layout.tsx`
- Replace: `app/globals.css`
- Create: `src/styles/tokens.css`, `base.css`, `shell.css`, `auth.css`, `inbox.css`, `ingest.css`, `casefile.css`, `administration.css`, `responsive.css`, and temporary `legacy.css`
- Create: `public/licenses/fonts/Public-Sans-OFL.txt`, `Newsreader-OFL.txt`, `IBM-Plex-Mono-OFL.txt`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: principal, exact role navigation, CommandResult errors, and phone rules.
- Produces: shared authenticated shell, accessible primitives, deterministic phone predicate, local font/static pipeline, and exact design tokens.

- [ ] **Step 1: Write primitive and app-shell tests before installing the DOM test packages**

```tsx
// @vitest-environment jsdom
it("traps modal focus, makes the app inert, closes on Escape, and restores focus", async () => {
  const user = userEvent.setup();
  render(<ModalTestHarness />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(document.querySelector("#app-root")).toHaveAttribute("inert");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
});
```

Test ErrorSummary links/focus, status text plus icon, skip link, exact role nav, 44 px class contract, and phone predicate portrait/landscape/tablet cases.

- [ ] **Step 2: Run primitive tests and verify the red state**

Run: `npm test -- src/components/ui src/components/shell`

Expected: FAIL because Testing Library packages and shared components do not exist.

- [ ] **Step 3: Install only the approved exact dependencies**

```bash
npm install --save-exact @fontsource-variable/public-sans@5.3.0 @fontsource-variable/newsreader@5.3.0 @fontsource/ibm-plex-mono@5.3.0
npm install --save-dev --save-exact @axe-core/playwright@4.12.1 @testing-library/jest-dom@7.0.0 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 jsdom@30.0.1
```

Expected: only `package.json` and `package-lock.json` change; `npm ls` reports the exact versions.

- [ ] **Step 4: Add the DOM test setup**

```ts
// src/test/setup.ts
import "@testing-library/jest-dom/vitest";
```

Register `src/test/setup.ts` in `vitest.config.ts` through `setupFiles` while component tests select jsdom with their file directive.

- [ ] **Step 5: Implement the phone predicate and hook exactly**

```ts
export function isPhoneSafetyMode(input: { width: number; height: number; coarsePointer: boolean }) {
  return input.width < 768 || (input.coarsePointer && input.height < 768);
}
```

`usePhoneSafetyMode` listens to resize and `(pointer: coarse)` and returns safety mode true until client classification completes. Phone-prohibited controls therefore never appear in server HTML or during hydration; supported desktop/tablet controls appear only after classification and remain client-guarded before dispatch.

- [ ] **Step 6: Implement modal, errors, status, empty, and skeleton primitives**

Use a body portal, focusable-element loop, Escape, `inert` on `#app-root`, body overflow restoration, title/description IDs, and trigger focus restoration. Update `app/layout.tsx` to render `<div id="app-root">{children}</div>` so portal content stays outside the inert subtree. Skeleton status text is `Loading <surface>` and does not pulse under reduced motion.

```tsx
return createPortal(
  <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby={titleId}>{children}</section></div>,
  document.body,
);
```

- [ ] **Step 7: Implement exact role navigation in `AppShell`**

```ts
const ROLE_NAV: Record<UserRole, Array<{ href: string; label: string }>> = {
  uploader: [{ href: "/workspace", label: "Work" }, { href: "/ingest", label: "Ingest" }],
  reviewer: [{ href: "/workspace", label: "Work" }],
  approver: [{ href: "/workspace", label: "Work" }],
  admin: [
    { href: "/workspace", label: "Work" },
    { href: "/ingest", label: "Ingest" },
    { href: "/administration", label: "Administration" },
  ],
};
```

Header height is 64 px. Add skip link and account menu with name, email, role, and Sign out.

- [ ] **Step 8: Move authenticated routes under the shared layout without changing URLs**

```bash
mkdir -p 'app/(authenticated)/workspace' 'app/(authenticated)/recordings/[recordingId]'
git mv app/workspace/page.tsx 'app/(authenticated)/workspace/page.tsx'
git mv 'app/recordings/[recordingId]/page.tsx' 'app/(authenticated)/recordings/[recordingId]/page.tsx'
```

The layout calls `requireActivePrincipal` and wraps `children` in `AppShell`. Remove duplicate session panels from moved pages. Create dedicated ingest/admin wrappers in the same commit so every nav destination resolves.

- [ ] **Step 9: Add local font imports and license files**

```ts
import "@fontsource-variable/public-sans";
import "@fontsource-variable/newsreader";
import "@fontsource/ibm-plex-mono/500.css";
```

Copy the exact OFL-1.1 text from each installed package `LICENSE` into the named `public/licenses/fonts` files. Add `COPY --from=builder /app/public ./public` to the runtime image.

- [ ] **Step 10: Replace old visual tokens and global style structure**

```css
:root {
  --color-bone: #f7f3ea;
  --color-paper: #fffcf6;
  --color-ink: #172421;
  --color-teal-700: #163d38;
  --color-rust-600: #a64b2a;
  --color-muted: #596762;
  --color-line: #d8d8cf;
  --color-success-fg: #2f6b55;
  --color-success-bg: #e4f0e9;
  --color-warning-fg: #8a5a14;
  --color-warning-bg: #fff2d7;
  --color-danger-fg: #8c332a;
  --color-danger-bg: #fbe7e4;
  --color-info-fg: #315e72;
  --color-info-bg: #e5f0f4;
  --color-focus: #0b6f64;
  --font-ui: "Public Sans Variable", sans-serif;
  --font-display: "Newsreader Variable", serif;
  --font-mono: "IBM Plex Mono", monospace;
  --type-12: 12px; --type-14: 14px; --type-16: 16px; --type-18: 18px;
  --type-24: 24px; --type-32: 32px; --type-44: 44px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-6: 24px; --space-8: 32px; --space-12: 48px;
  --radius-control: 8px; --radius-surface: 12px; --radius-modal: 16px;
  --shadow-1: 0 1px 2px rgba(23, 36, 33, 0.1);
  --content-max: 1440px; --work-max: 1200px;
  --motion-fast: 120ms; --motion-slow: 180ms;
}
```

Move selectors still required by the old Work, Ingest, Casefile, export, and Administration components into `src/styles/legacy.css` and import it last. Each replacement task deletes its own legacy block. New shell and primitives use only the approved tokens; no intermediate route loses styling.

- [ ] **Step 11: Run component tests, typecheck, and build**

Run: `npm test -- src/components/ui src/components/shell && npm run typecheck && npm run build`

Expected: primitive and nav tests PASS; Next routes retain original URLs plus `/ingest` and `/administration`; build exits 0 with local font assets.

- [ ] **Step 12: Verify exact dependencies and container public copy**

Run: `npm ls @fontsource-variable/public-sans @fontsource-variable/newsreader @fontsource/ibm-plex-mono @axe-core/playwright @testing-library/react jsdom`

Expected: exact versions from Global Constraints and no extraneous package errors.

- [ ] **Step 13: Commit the visual foundation**

```bash
git add package.json package-lock.json vitest.config.ts src/test src/components/ui src/components/shell app src/styles public/licenses/fonts Dockerfile
git commit -m "feat(ui): add governed workspace foundation"
```

## Task 9: Redesign First-Run, Login, and In-Place Session Recovery

**Files:**
- Create: `src/server/bootstrap/readiness.ts`
- Create: `src/server/bootstrap/readiness.test.ts`
- Create: `src/lib/safe-return-to.ts`
- Create: `src/lib/safe-return-to.test.ts`
- Create: `src/components/auth/auth-surface.tsx`
- Rewrite: `src/components/auth/bootstrap-setup-form.tsx` and `.test.tsx`
- Rewrite: `src/components/auth/login-form.tsx` and `.test.tsx`
- Create: `src/components/auth/session-recovery-dialog.tsx` and `.test.tsx`
- Modify: `src/components/auth/logout-button.tsx`
- Modify: `src/server/actions/auth-actions.ts`
- Modify: `src/server/session.ts`
- Modify: `app/page.tsx`
- Create: `app/loading.tsx`
- Create: `app/error.tsx`
- Modify: `src/styles/auth.css`
- Modify: `src/styles/responsive.css`

**Interfaces:**
- Consumes: existing auth schemas/services, Auth.js `signIn`, UI primitives, and phone-safe auth support.
- Produces: `getBootstrapReadiness()`, `sanitizeReturnTo()`, form-first auth, focus behavior, safe return routes, logout focus, and reusable in-place reauthentication.

- [ ] **Step 1: Write readiness and safe-return tests**

```ts
it.each([
  ["/workspace", "/workspace"],
  ["/workspace?tab=waiting&sort=updated_asc", "/workspace?tab=waiting&sort=updated_asc"],
  ["/recordings/rec-1?revision=rev-1", "/recordings/rec-1?revision=rev-1"],
  ["https://evil.test", "/workspace"],
  ["//evil.test/path", "/workspace"],
  ["/administration?section=unknown", "/workspace"],
])("sanitizes %s", (value, expected) => expect(sanitizeReturnTo(value)).toBe(expected));
```

Readiness tests cover writable DB, upload/media storage, auth secret, valid engine config, non-blocking absent worker, no leaked paths/secrets, and blocking invalid mode.

- [ ] **Step 2: Write auth component focus tests**

Test error summary focus and links, first invalid field, password clearing, name/email preservation, wrong-credential focus on Password, pending double-submit, successful logout heading focus marker, and session-recovery focus return without automatic retry.

- [ ] **Step 3: Run auth tests and verify the red state**

Run: `npm test -- src/server/bootstrap/readiness.test.ts src/lib/safe-return-to.test.ts src/components/auth`

Expected: FAIL because readiness, sanitizer, auth surface, and recovery dialog do not exist.

- [ ] **Step 4: Implement safe readiness checks**

Return checks with IDs `database`, `media_storage`, `upload_storage`, `auth_secret`, and `engine_configuration`; each has `ready|warning|blocked` and safe copy. Use create/write/delete of a private sentinel in storage directories and never include the path in returned text.

```ts
const checks = [checkDatabase(), checkWritableDirectory("media_storage", mediaDir), checkWritableDirectory("upload_storage", uploadDir), checkAuthSecret(), checkEngineConfiguration()];
return { overall: checks.some((check) => check.state === "blocked") ? "blocked" : checks.some((check) => check.state === "warning") ? "warning" : "ready", checks };
```

- [ ] **Step 5: Implement sanitized route recovery**

Allow only `/workspace`, `/ingest`, `/recordings/<single encoded segment>` with approved query keys, and `/administration` with a valid section. Non-admin authorization is rechecked after login; unauthorized targets fall back to Work.

```ts
const base = new URL("https://superscriber.local");
const candidate = new URL(value ?? "/workspace", base);
if (candidate.origin !== base.origin || candidate.username || candidate.password) return "/workspace";
const allowedKeys: Record<string, Set<string>> = {
  "/workspace": new Set(["tab", "query", "stage", "source", "assignmentUserId", "sort"]),
  "/ingest": new Set(),
  "/administration": new Set(["section", "query", "assignmentStatus", "assignmentRole", "recordingId", "userId", "fromUtc", "toUtc"]),
};
const recordingPath = /^\/recordings\/[^/]+$/.test(candidate.pathname);
const keys = recordingPath ? new Set(["revision", "actionMode"]) : allowedKeys[candidate.pathname];
if (!keys || [...candidate.searchParams.keys()].some((key) => !keys.has(key))) return "/workspace";
if (candidate.pathname === "/administration" && candidate.searchParams.has("section") && !["accounts", "assignments", "policy"].includes(candidate.searchParams.get("section")!)) return "/workspace";
return `${candidate.pathname}${candidate.search}`;
```

- [ ] **Step 6: Rewrite bootstrap as a form-first surface**

Render the form first in DOM and desktop visual order. Add `ErrorSummary`, field links, readiness list, blocking disabled state, Retry checks, and exact success/concurrency copy. Preserve only name and email after error. On success set a 60-second HttpOnly, SameSite=Strict `superscriber.bootstrap-email` cookie containing the normalized first-admin email, redirect with `notice=bootstrap-complete`, read the cookie once to prefill Login Email, and expire it through the first login attempt. The redirected login heading receives focus and no password value survives.

```ts
const cookieStore = await cookies();
cookieStore.set("superscriber.bootstrap-email", parsed.data.email, { httpOnly: true, sameSite: "strict", maxAge: 60, path: "/" });
redirect("/?notice=bootstrap-complete");
```

- [ ] **Step 7: Rewrite login error and return behavior**

Mark both fields invalid on wrong credentials, focus Password, announce exact copy, and pass sanitized `callbackUrl`. On service errors focus summary and state that the password was not saved.

```ts
const result = await signIn("credentials", { email, password, redirect: false, callbackUrl: sanitizeReturnTo(returnTo) });
if (!result || result.error) {
  setError("Email or password was not accepted. Check both fields and try again.");
  passwordRef.current?.focus();
}
```

- [ ] **Step 8: Implement in-page session recovery**

```tsx
<SessionRecoveryDialog
  open={errorCode === "AUTH_EXPIRED"}
  onRecovered={() => {
    setErrorCode(null);
    invokingControlRef.current?.focus();
  }}
/>
```

Use Auth.js credentials with `redirect: false`. Keep transcript state in the parent component memory. Do not invoke or retry any prior command in `onRecovered`.

- [ ] **Step 9: Add unsaved-aware route redirects and safe logout**

Protected navigation redirects include a sanitized `returnTo`. Logout returns `/?reason=logged-out`, focuses the login heading using a server notice marker, and announces `Your session ended safely.`

```ts
if (!principal) redirect(`/?reason=session-expired&returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}`);
await signOut({ callbackUrl: "/?reason=logged-out" });
```

- [ ] **Step 10: Run auth tests, auth service tests, typecheck, and build**

Run: `npm test -- src/server/bootstrap/readiness.test.ts src/lib/safe-return-to.test.ts src/components/auth src/server/auth/service.test.ts && npm run typecheck && npm run build`

Expected: readiness, sanitizer, focus, recovery, and existing concurrent bootstrap tests PASS; build exits 0.

- [ ] **Step 11: Commit authentication and recovery**

```bash
git add src/server/bootstrap src/lib/safe-return-to* src/components/auth src/server/actions/auth-actions.ts src/server/session.ts app/page.tsx app/loading.tsx app/error.tsx src/styles/auth.css src/styles/responsive.css
git commit -m "feat(auth): add safe session recovery"
```

## Task 10: Replace the Dashboard With the Role-Aware Work Inbox

**Files:**
- Rewrite: `app/(authenticated)/workspace/page.tsx`
- Create: `app/(authenticated)/workspace/loading.tsx`
- Create: `src/components/work/work-inbox.tsx` and `.test.tsx`
- Create: `src/components/work/work-filters.tsx` and `.test.tsx`
- Create: `src/components/work/recording-ledger.tsx` and `.test.tsx`
- Modify: `src/styles/inbox.css`
- Modify: `src/styles/responsive.css`

**Interfaces:**
- Consumes: `listWorkInbox`, `WorkInboxFilters`, `WorkInboxViewModel`, UTC formatting, status badge, empty state, and app shell.
- Produces: exact role tabs, nullable next-action strip, URL-backed filters, semantic desktop table/narrow list, result announcements, and role empty states.

- [ ] **Step 1: Write WorkInbox component tests from view models**

```tsx
it("omits the next action when the server returns null", () => {
  render(<WorkInbox model={{ ...reviewerInbox, nextAction: null }} />);
  expect(screen.queryByText("Next action")).not.toBeInTheDocument();
  expect(screen.getByText("No transcript review is assigned to you.")).toBeVisible();
});
```

Test each role's tabs and empty copy, completed exclusion, row accessible names, labeled assignment chips, state icon plus text, UTC accessible text, uploader columns, and one row action.

- [ ] **Step 2: Write filter URL and announcement tests**

Mock `useRouter`. Verify query trim, valid stage/source/sort, admin assignment filter, URL replace rather than push, focus remains on control, and result-count polite announcement.

- [ ] **Step 3: Run work component tests and verify missing-component failures**

Run: `npm test -- src/components/work`

Expected: FAIL because inbox components do not exist.

- [ ] **Step 4: Render the page only from the server read model**

```tsx
const principal = await requireActivePrincipal("/workspace");
const filters = parseWorkInboxFilters(await searchParams, principal.role);
const model = listWorkInbox(principal, filters);
return <WorkInbox model={model} />;
```

No page component computes permissions, counts, or next action.

- [ ] **Step 5: Implement semantic tabs, filters, next action, and ledger**

Use nav links with `aria-current`, a form with visible labels, a real table at 960 px and above, and a labeled `<ul>` below 960 px. Do not create queue cards for empty states.

```tsx
<nav aria-label="Work status"><ul>{model.tabs.map((tab) => <li key={tab.id}><Link aria-current={tab.id === model.activeTab ? "page" : undefined} href={tabHref(tab.id)}>{tab.label} <span>{tab.count}</span></Link></li>)}</ul></nav>
{model.nextAction ? <NextAction row={model.nextAction} /> : null}
<RecordingLedger rows={model.rows} role={model.role} />
```

- [ ] **Step 6: Remove old authenticated dashboard content**

Remove role hero, metric grid, inline ingest, policy card, queue board, inline administration, and implementation notes. Keep only role heading, responsibility, next action, tabs, filters, and one ledger. Delete the dashboard, metric, queue-board, and workspace-note blocks from `src/styles/legacy.css` in the same step.

```tsx
<main id="work-main" className="work-page">
  <header><h1>{model.heading}</h1><p>{model.responsibility}</p></header>
  <WorkInbox model={model} />
</main>
```

- [ ] **Step 7: Add layout-matched loading and narrow reflow**

Skeleton geometry matches heading, tabs, filters, and rows. At 320 and 390 px there is no table overflow; every row action is 44 px high.

```css
@media (max-width: 959px) { .recording-table { display: none; } .recording-list { display: grid; } }
@media (min-width: 960px) { .recording-table { display: table; } .recording-list { display: none; } }
.recording-action { min-height: 44px; min-width: 44px; }
```

- [ ] **Step 8: Run focused tests, read-model tests, typecheck, and build**

Run: `npm test -- src/components/work src/server/work-inbox/service.test.ts && npm run typecheck && npm run build`

Expected: all role/render/filter tests PASS; `/workspace` compiles with no old dashboard component imports.

- [ ] **Step 9: Commit the work inbox**

```bash
git add 'app/(authenticated)/workspace' src/components/work src/styles/inbox.css src/styles/responsive.css src/styles/legacy.css
git commit -m "feat(work): add role-aware recording ledger"
```

## Task 11: Enforce Ingest Ownership and Stable API Recovery

**Files:**
- Modify: `src/server/ingest/service.ts`
- Modify: `src/server/ingest/service.test.ts`
- Modify: `src/domain/workflow.ts`
- Modify: `app/api/ingest/sessions/route.ts`
- Modify: `app/api/ingest/sessions/[sessionId]/route.ts`
- Modify: `app/api/ingest/sessions/[sessionId]/chunk/route.ts`
- Modify: `app/api/ingest/sessions/[sessionId]/finalize/route.ts`

**Interfaces:**
- Consumes: `Principal`, new recording/session ownership fields, existing 1 MiB client chunk behavior, 24-hour cleanup, and stable error codes.
- Produces: owner-aware create/inspect/append/finalize service calls and JSON `{ ok, code, error, fieldErrors? }` failures.

```ts
export function createResumableUploadSession(params: {
  principal: Principal;
  title: string;
  languageHint: string;
  source: RecordingSource;
  fileName: string;
  mimeType: string | null;
  fileSize: number;
}): UploadSessionStatus;

export function getResumableUploadSession(
  sessionId: string,
  principal: Principal,
): UploadSessionStatus;
```

- [ ] **Step 1: Add ownership and safe-failure tests**

Test creator uploader, creator admin, non-owner uploader denial for inspect/append/finalize, admin non-owner inspect success, admin non-owner append/finalize denial, title bounds, same-file resume, finalize warning, expiration, byte mismatch, and stable safe error codes.

```ts
it("allows admin inspection but denies mutation of another user's session", () => {
  expect(getResumableUploadSession(session.id, adminPrincipal).sessionId).toBe(session.id);
  expect(() => appendUploadChunk({ principal: adminPrincipal, sessionId: session.id, chunkStart: 0, bytes: payload }))
    .toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
});
```

- [ ] **Step 2: Run ingest tests and verify role-only authorization fails**

Run: `npm test -- src/server/ingest/service.test.ts`

Expected: FAIL because the current service has no principal/user ownership.

- [ ] **Step 3: Record creator identity on both recording and session**

Pass `principal.userId` through `createUploadSessionEntry`. Preserve `uploadedByRole` for legacy display and add `uploadedByUserId` plus session `createdByUserId`. Ingest-created audit rows use `actorContextForPrincipal(principal)` so new uploads have user attribution.

- [ ] **Step 4: Add inspect and mutate ownership assertions**

```ts
class IngestError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

function assertSessionAccess(session: IngestionSession, principal: Principal, mode: "inspect" | "mutate") {
  if (session.createdByUserId === principal.userId) return;
  if (mode === "inspect" && principal.role === "admin") return;
  throw new IngestError("ACCESS_DENIED", "This upload session is not available to your account.");
}
```

Legacy null owner is admin-inspect only. It cannot be resumed by role alone.

- [ ] **Step 5: Validate title and preserve transfer invariants**

Require 1 to 120 trimmed title characters before creating any recording. Keep chunk offset, temp-file, expected-size, finalize, cleanup, and durable dispatch behavior unchanged.

- [ ] **Step 6: Update all ingest routes to pass the principal and stable errors**

Role checks remain uploader/admin for create. Inspect calls owner-aware service. Chunk/finalize call mutate mode. Return exact safe code and message without paths or adapter details.

```ts
const principal = await getActivePrincipal();
if (!principal) return NextResponse.json({ ok: false, code: "AUTH_EXPIRED", error: "Session expired. Sign in again to continue." }, { status: 401 });
const status = appendUploadChunk({ principal, sessionId, chunkStart, bytes });
return NextResponse.json({ ok: true, status });
```

- [ ] **Step 7: Run focused tests, all tests, and typecheck**

Run: `npm test -- src/server/ingest/service.test.ts && npm test && npm run typecheck`

Expected: ownership, resume, expiry, and finalize tests PASS; all tests PASS.

- [ ] **Step 8: Commit ingest ownership**

```bash
git add src/server/ingest src/domain/workflow.ts app/api/ingest
git commit -m "feat(ingest): bind resumable uploads to creators"
```

## Task 12: Build the Focused, Accessible Ingest Flow

**Files:**
- Rewrite: `app/(authenticated)/ingest/page.tsx`
- Create: `app/(authenticated)/ingest/loading.tsx`
- Create: `src/components/ingest/ingest-flow.tsx` and `.test.tsx`
- Create: `src/components/ingest/source-choice.tsx`
- Create: `src/components/ingest/capture-audio.tsx` and `.test.tsx`
- Create: `src/components/ingest/transfer-progress.tsx` and `.test.tsx`
- Create: `src/components/ingest/resume-upload-card.tsx`
- Delete: `src/components/ingest-panel.tsx`
- Modify: `src/styles/ingest.css`
- Modify: `src/styles/responsive.css`

**Interfaces:**
- Consumes: owner-aware ingest APIs, `usePhoneSafetyMode`, existing 1 MiB chunk constant, app shell, notices, error summary, and progress semantics.
- Produces: three-stage source/details/transfer UI, supported phone upload/recording, throttled announcements, resume/finalize/restart recovery, and durable completion routing.

- [ ] **Step 1: Write source and validation component tests**

Test radio-group semantics, selected state, title 1/120 bounds, language required, upload file required, MediaRecorder unsupported fallback, microphone denial focus/copy, recording Stop/preview/Replace, and 44 px controls.

- [ ] **Step 2: Write progress announcement and recovery tests**

```tsx
it("announces only start, ten-percent boundaries, and completion", () => {
  let boundary = -1;
  const announcements: string[] = [];
  for (const percent of [1, 5, 10, 11, 20, 100]) {
    const next = nextProgressAnnouncement(boundary, percent);
    if (next) {
      boundary = next.boundary;
      announcements.push(next.message);
    }
  }
  expect(announcements).toEqual(["Upload started.", "10 percent uploaded.", "20 percent uploaded.", "Upload complete."]);
});
```

Test resume at committed bytes, finalize when bytes complete, restart when expired/missing/mismatch, same-file identity, metadata-only local storage, and durable dispatch-failure copy.

- [ ] **Step 3: Run ingest component tests and verify missing-component failures**

Run: `npm test -- src/components/ingest`

Expected: FAIL because split ingest components do not exist.

- [ ] **Step 4: Extract resumable metadata and transfer helpers from the old panel**

Keep `CHUNK_SIZE = 1024 * 1024` and `superscriber.pendingIngest`. The stored shape remains session ID, file name, size, type, last modified, and source only.

```ts
const CHUNK_SIZE = 1024 * 1024;
type PendingIngest = { sessionId: string; fileName: string; fileSize: number; fileType: string; fileLastModified: number; source: "upload" | "record" };
localStorage.setItem("superscriber.pendingIngest", JSON.stringify(pending));
```

- [ ] **Step 5: Implement source as a radio group and capture as an optional capability**

Do not use ARIA tabs. Render browser recording only when APIs exist. Denial replaces controls and focuses an assertive notice; Upload remains selectable.

```tsx
<fieldset><legend>Source</legend>
  <label><input type="radio" name="source" value="upload" checked={source === "upload"} onChange={selectUpload} />Upload file</label>
  {recordingSupported ? <label><input type="radio" name="source" value="record" checked={source === "record"} onChange={selectRecord} />Record audio</label> : null}
</fieldset>
```

- [ ] **Step 6: Implement native progress and throttled live text**

```tsx
<progress max={status.bytesExpected} value={status.bytesReceived} aria-describedby="transfer-detail" />
<p id="transfer-detail">{formatBytes(status.bytesReceived)} of {formatBytes(status.bytesExpected)} committed</p>
```

```ts
export function nextProgressAnnouncement(previousBoundary: number, nextPercent: number) {
  if (previousBoundary < 0) return { boundary: 0, message: "Upload started." };
  if (nextPercent >= 100 && previousBoundary < 100) return { boundary: 100, message: "Upload complete." };
  const boundary = Math.floor(nextPercent / 10) * 10;
  return boundary >= 10 && boundary > previousBoundary
    ? { boundary, message: `${boundary} percent uploaded.` }
    : null;
}
```

Interruption and finalization messages are explicit state transitions, not percent updates. The primary action reads `Upload recording`; during transfer use a status label rather than a clickable pending button.

- [ ] **Step 7: Implement exact completion and failure routing**

Admin routes to `/recordings/${status.recordingId}`; uploader routes to `/workspace`. Use exact durable success/dispatch copy from the specification. Never request re-upload after durable finalization.

```ts
const destination = principalRole === "admin" ? `/recordings/${status.recordingId}` : "/workspace";
router.push(`${destination}?notice=${encodeURIComponent("Upload received. Verification has started.")}`);
```

- [ ] **Step 8: Apply the same supported flow in phone safety mode**

File upload, resume, restart, and supported audio recording remain. No unrelated admin/review controls appear.

```tsx
const phoneSafety = usePhoneSafetyMode();
return <IngestFlowLayout compact={phoneSafety}>{sourceAndTransferControls}</IngestFlowLayout>;
```

- [ ] **Step 9: Delete the old panel, remove legacy ingest CSS, and run focused tests, typecheck, and build**

```bash
! rg -n 'ingest-panel|IngestPanel' app src/components
! rg -n '^\.(ingest-status-card|ingest-progress-track|ingest-progress-bar)\b' src/styles/legacy.css
```

Run: `npm test -- src/components/ingest src/server/ingest/service.test.ts && npm run typecheck && npm run build`

Expected: component and service tests PASS; no import references `ingest-panel`; `/ingest` builds.

- [ ] **Step 10: Commit focused ingest**

```bash
git add 'app/(authenticated)/ingest' src/components/ingest src/components/ingest-panel.tsx src/styles/ingest.css src/styles/responsive.css src/styles/legacy.css
git commit -m "feat(ingest): add focused resumable flow"
```

## Task 13: Build the Transcript-First Casefile Core

**Files:**
- Rewrite: `app/(authenticated)/recordings/[recordingId]/page.tsx`
- Create: `app/(authenticated)/recordings/[recordingId]/loading.tsx`
- Create: `app/(authenticated)/recordings/[recordingId]/not-found.tsx`
- Create: `src/components/casefile/casefile-workspace.tsx` and `.test.tsx`
- Create: `src/components/casefile/case-header.tsx`
- Create: `src/components/casefile/media-transport.tsx` and `.test.tsx`
- Create: `src/components/casefile/transcript-document.tsx` and `.test.tsx`
- Create: `src/components/casefile/state-action-bar.tsx` and `.test.tsx`
- Create: `src/components/casefile/governance-drawer.tsx` and `.test.tsx`
- Create: `src/components/casefile/conflict-panel.tsx` and `.test.tsx`
- Modify: `src/components/orchestration-status-poller.tsx`
- Modify: `src/styles/casefile.css`
- Modify: `src/styles/responsive.css`

**Interfaces:**
- Consumes: `CasefileViewModel`, typed save/submit actions, media URL, phone hook, session recovery, status poller, UTC format, and shared primitives.
- Produces: uploader status casefile, sticky case header/transport/action bar, editable draft only, immutable pending/approved views, governance disclosure, unsaved guard, and conflict preservation.

- [ ] **Step 1: Write casefile state rendering tests**

```tsx
it.each([
  ["draft_review", true],
  ["pending_approval", false],
  ["approved", false],
])("renders transcript fields only for editable %s", (stage, editable) => {
  renderCasefile({ stage, canEdit: editable });
  expect(screen.queryAllByRole("textbox").length > 0).toBe(editable);
});
```

Test uploader status-only exclusions, historical snapshot label, case header state/revision/assignment, processing progress, no blank disabled editor, draft summary, segment labels using order/timestamp, active row `aria-current`, confidence text, and action bar capabilities.

- [ ] **Step 2: Write media, conflict, and unsaved-state tests**

Test native controls, Jump back 10 seconds, playback rate, current segment, media denial replacement, no waveform, beforeunload registration only when dirty, save retaining focus, stale conflict preserving local segments, new-tab latest link, and discard confirmation.

- [ ] **Step 3: Run casefile component tests and verify missing-component failures**

Run: `npm test -- src/components/casefile`

Expected: FAIL because casefile components do not exist.

- [ ] **Step 4: Render the route from `getCasefile` and safe query options**

```tsx
const principal = await requireActivePrincipal(`/recordings/${recordingId}`);
const casefile = getCasefile(principal, recordingId, {
  revisionId: firstValue(search.revision),
  actionModeId: firstValue(search.actionMode),
});
if (!casefile) notFound();
return <CasefileWorkspace initialCasefile={casefile} />;
```

Catch `ACCESS_DENIED` by redirecting to Work with the safe notice. Do not compute policy or capabilities in the page.

- [ ] **Step 5: Implement uploader status and transcript-capable shells**

Uploader status renders ingest progress, safe metadata, and recovery guidance only. Transcript casefile puts state and transcript immediately below the 64 px app header with no hero or summary cards.

```tsx
if (casefile.statusOnly) return <UploaderStatusCasefile casefile={casefile} />;
return <><CaseHeader casefile={casefile} /><div className="casefile-layout"><main id="transcript-main"><MediaTransport {...mediaProps} /><TranscriptDocument {...transcriptProps} /></main><GovernanceDrawer casefile={casefile} /></div></>;
```

- [ ] **Step 6: Implement sticky accessible media transport without waveform**

Use native `<audio>` or `<video>`, current time, jump back, playback rate, and segment label. Media denial or absence replaces the control region with one reason.

```tsx
if (!mediaUrl) return <InlineNotice tone="info">{mediaDenialReason}</InlineNotice>;
return <section aria-label="Recording playback"><audio ref={mediaRef} controls src={mediaUrl} /><button onClick={() => seekBy(-10)}>Jump back 10 seconds</button><select aria-label="Playback rate" value={rate} onChange={changeRate}>{rates.map((value) => <option key={value} value={value}>{value}x</option>)}</select><span>{currentSegmentLabel}</span></section>;
```

- [ ] **Step 7: Implement aligned transcript document**

At desktop use 96 px timestamp, 128 px speaker, and flexible text. At 768-1099 place timestamp/speaker above text. In phone safety mode render speaker and text as plain content, never inputs. Use `aria-current` plus mint background and left marker.

```tsx
<article aria-current={active ? "true" : undefined} aria-label={`Transcript segment ${index + 1}, ${windowLabel}`}>
  <button aria-label={`Play from ${windowLabel}`} onClick={() => seekTo(segment.startMs)}>{windowLabel}</button>
  {editable ? <input aria-label={`Speaker for segment ${index + 1}, ${windowLabel}`} value={segment.speakerLabel} onChange={(event) => updateSpeaker(segment.id, event.currentTarget.value)} /> : <strong>{segment.speakerLabel}</strong>}
  {editable ? <textarea aria-label={`Transcript for segment ${index + 1}, ${windowLabel}`} value={segment.text} onChange={(event) => updateText(segment.id, event.currentTarget.value)} /> : <p>{segment.text}</p>}
  <span>Confidence {Math.round(segment.confidence * 100)}%</span>
</article>
```

- [ ] **Step 8: Implement save and submit from server capabilities**

Save only when dirty and `canSave`; submit optionally saves then submits through one typed action. Save updates revision IDs but preserves `document.activeElement` and scroll. State-changing submit focuses `#case-state`.

```ts
const result = await saveDraftAction({ recordingId, expectedCurrentRevisionId, summary, segments, actionModeId });
if (result.ok) {
  setCasefile(result.data.casefile!);
  setDirty(false);
  requestAnimationFrame(() => focusedEditorRef.current?.focus());
}
```

- [ ] **Step 9: Implement unsaved and session/conflict recovery**

Keep segments only in React memory. Add beforeunload and internal-link confirmation while dirty. `AUTH_EXPIRED` opens SessionRecoveryDialog. `STALE_REVISION` leaves local values intact and renders loaded/current IDs with exact two recovery actions.

```ts
useEffect(() => {
  const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
  window.addEventListener("beforeunload", warn);
  return () => window.removeEventListener("beforeunload", warn);
}, [dirty]);
```

- [ ] **Step 10: Implement governance drawer and polling semantics**

Desktop defaults collapsed; open is 70/30. Tablet uses modal side drawer; phone uses accordions. Tabs are Policy, Provenance, Assignments, Revisions, Decisions, Audit. Poll every three seconds only while active and announce stage or 10-percent boundaries.

```ts
const GOVERNANCE_TABS = ["Policy", "Provenance", "Assignments", "Revisions", "Decisions", "Audit"] as const;
const timer = activeProcessing ? window.setInterval(pollStatus, 3000) : null;
return () => { if (timer !== null) window.clearInterval(timer); };
```

- [ ] **Step 11: Add sticky geometry and phone transcript positioning styles**

Reserve bottom padding for action bar, use `scroll-padding`/`scroll-margin`, and ensure transcript starts within 400 px desktop and 500 px at 390 width.

```css
html { scroll-padding-top: 132px; }
.casefile-page { padding-bottom: calc(88px + env(safe-area-inset-bottom)); }
.transcript-segment { scroll-margin-top: 176px; }
@media (max-width: 767px) { .casefile-page { padding-inline: 16px; } }
```

- [ ] **Step 12: Run focused tests, read-model tests, typecheck, and build**

Run: `npm test -- src/components/casefile src/server/casefile/read-model.test.ts && npm run typecheck && npm run build`

Expected: state, media, transcript, conflict, and geometry-class tests PASS; casefile route builds.

- [ ] **Step 13: Commit transcript-first casefile core**

```bash
git add 'app/(authenticated)/recordings' src/components/casefile src/components/orchestration-status-poller.tsx src/styles/casefile.css src/styles/responsive.css
git commit -m "feat(casefile): add transcript-first review"
```

## Task 14: Add Deliberate Decisions, Admin Action Mode, and Viewport-Safe Export

**Files:**
- Create: `src/components/casefile/decision-dialog.tsx` and `.test.tsx`
- Create: `src/components/casefile/admin-action-mode-banner.tsx` and `.test.tsx`
- Create: `src/components/casefile/export-dialog.tsx` and `.test.tsx`
- Create: `src/components/casefile/session-recovery-dialog.integration.test.tsx`
- Modify: `src/components/casefile/casefile-workspace.tsx`
- Modify: `src/components/casefile/case-header.tsx`
- Modify: `src/components/casefile/state-action-bar.tsx`
- Modify: `src/styles/casefile.css`
- Modify: `src/styles/responsive.css`
- Delete: `src/components/review-workspace.tsx` after no imports remain

**Interfaces:**
- Consumes: typed transition and action-mode actions, capability booleans, CommandResult, Modal, phone guard, approved export URL builder, and session recovery.
- Produces: submit/withdraw/request/approve/reopen dialogs, persistent audited mode banner, effective-role UI, fetch-based export modal, and exact focus/announcement behavior.

- [ ] **Step 1: Write decision dialog tests**

Test submit confirmation and final label, exact revision/submitter/time/segment content, withdrawal warning, 10/500 reason count, optional 500 approval note, request-changes copy, reopen consequences, all final button labels, disabled invalid reasons, reason preservation after network error, and attempted reason omission from audit on conflict.

- [ ] **Step 2: Write admin action-mode tests**

Test oversight has no governed buttons, state-valid entry options, exact recording/effective role/purpose dialog, 10/500 bounds, persistent banner identity/reason/expiry, reviewer and approver effective labels, explicit exit, expiry preserving edits, self-approval option absence, and no action-mode entry on phone.

- [ ] **Step 3: Write export modal tests**

Test seven grouped formats, approved/approver metadata, legacy fallback, fixed modal, max-height token, inert/body lock/focus loop/Escape/restore, action-mode query for admin, fetch blob download, 401 recovery, 403/409 inline state, network retry, and absence on phone/draft/pending/reopened.

- [ ] **Step 4: Run focused tests and verify missing-component failures**

Run: `npm test -- src/components/casefile/decision-dialog.test.tsx src/components/casefile/admin-action-mode-banner.test.tsx src/components/casefile/export-dialog.test.tsx`

Expected: FAIL because decision, action-mode, and export components do not exist.

- [ ] **Step 5: Implement one typed decision dialog shell**

```tsx
type DecisionKind = "submit" | "withdraw" | "requestChanges" | "approve" | "reopen";
const finalLabel: Record<DecisionKind, string> = {
  submit: "Submit for approval",
  withdraw: "Withdraw revision",
  requestChanges: "Request changes",
  approve: "Approve and complete work",
  reopen: "Reopen as draft",
};
const needsReason = kind === "withdraw" || kind === "requestChanges" || kind === "reopen";
const valid = needsReason
  ? reason.trim().length >= 10 && reason.trim().length <= 500
  : kind === "approve" ? note.trim().length <= 500 : true;

<Modal titleId={`${kind}-title`} open={open} onClose={onCancel} initialFocus="close">
  <h2 id={`${kind}-title`}>{finalLabel[kind]}</h2>
  <p>Revision v{revision.version} submitted by {submitterLabel} at {submittedAtUtc}.</p>
  {needsReason ? (
    <label>Reason<textarea value={reason} minLength={10} maxLength={500} onChange={onReasonChange} /></label>
  ) : kind === "approve" ? (
    <label>Approval note, optional<textarea value={note} maxLength={500} onChange={onNoteChange} /></label>
  ) : null}
  <button disabled={!valid || pending} onClick={submit}>{finalLabel[kind]}</button>
</Modal>
```

Use exact final labels: Submit for approval, Withdraw revision, Request changes, Approve and complete work, Reopen as draft.

- [ ] **Step 6: Wire success and conflict focus behavior**

Withdrawal announces new editable draft. Request changes renders draft read-only for approver. Approval announces completed assignments. Reopen redirects completed approver to Work and keeps admin oversight on current draft. Decision conflicts close and refresh the winning immutable state.

```ts
if (result.ok) {
  setCasefile(result.data.casefile);
  setAnnouncement(result.notice);
  if (result.data.nextPath) router.push(result.data.nextPath);
  else requestAnimationFrame(() => document.querySelector<HTMLElement>("#case-state")?.focus());
} else if (result.code === "STATE_CHANGED") {
  closeDialog();
  router.refresh();
  setAnnouncement(result.message);
}
```

- [ ] **Step 7: Implement action-mode entry and banner**

Entry calls server action and routes to `?actionMode=${session.id}`. Banner always names admin, effective role, purpose, and expiry. Exit calls server then removes the query. Expiry removes controls and offers a new valid mode without discarding editor memory.

```tsx
<aside className="action-mode-banner" aria-label="Admin action mode">
  <strong>Admin action mode: {session.effectiveRole === "reviewer" ? "Reviewer" : "Approver"}</strong>
  <span>{principal.displayName} (Admin)</span><span>{session.purpose}</span><time dateTime={session.expiresAt}>{formatDateTimeUtc(session.expiresAt)}</time>
  <button onClick={exitMode}>Exit action mode</button>
</aside>
```

- [ ] **Step 8: Implement fetch-based export from the active approved pointer**

```ts
function fileNameFromDisposition(headers: Headers) {
  return /filename="([^"]+)"/.exec(headers.get("content-disposition") ?? "")?.[1]
    ?? `approved-transcript.${format}`;
}
function triggerObjectUrlDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

const response = await fetch(buildApprovedTranscriptExportUrl(baseUrl, format, actionModeId));
if (!response.ok) {
  if (response.status === 401) setNeedsSessionRecovery(true);
  else if (response.status === 403) setError("Export is no longer allowed for this account or policy.");
  else if (response.status === 409) setError("This casefile no longer has an active approved revision.");
  else setError("Export could not be prepared. Try again.");
  return;
}
const blob = await response.blob();
triggerObjectUrlDownload(blob, fileNameFromDisposition(response.headers));
setAnnouncement(`Approved revision v${revision.version} exported as ${format.toUpperCase()}.`);
```

Close only after successful bytes. Keep modal and focus on selected format after error. Revoke object URL after download trigger.

- [ ] **Step 9: Apply viewport-fixed modal and bounded sheet styles**

Use `position: fixed`, desktop centering, `max-height: calc(100dvh - 32px)`, internal scroll, and no shell-relative position variables. Compact tablet can use bottom sheet; phone renders no export trigger.

```css
.export-backdrop { position: fixed; inset: 0; display: grid; place-items: center; z-index: 1000; }
.export-dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; }
@media (min-width: 768px) and (max-width: 959px) { .export-backdrop { align-items: end; } .export-dialog { width: 100%; border-radius: 16px 16px 0 0; } }
```

- [ ] **Step 10: Remove the monolithic old review component**

Verify no imports remain, then delete `src/components/review-workspace.tsx` and all obsolete waveform, rail, hero, summary-card, prototype-note, and absolute export rules from `src/styles/legacy.css`.

```bash
! rg -n 'review-workspace|ReviewWorkspace|waveform|annotation-rail|review-hero|review-summary-card|Prototype behavior' app src/components src/styles
```

- [ ] **Step 11: Run focused tests, route tests, typecheck, and build**

Run: `npm test -- src/components/casefile 'app/api/recordings/[recordingId]/transcript/route.test.ts' && npm run typecheck && npm run build`

Expected: all decision, action-mode, export, focus, and route tests PASS; no old review workspace import or CSS selector remains.

- [ ] **Step 12: Commit governed interactions**

```bash
git add src/components/casefile src/components/review-workspace.tsx src/styles/casefile.css src/styles/responsive.css src/styles/legacy.css
git commit -m "feat(casefile): add audited decisions and export"
```

## Task 15: Split Administration Into Accounts, Assignments, and Policy

**Files:**
- Rewrite: `app/(authenticated)/administration/page.tsx`
- Create: `app/(authenticated)/administration/loading.tsx`
- Create: `src/components/admin/administration-shell.tsx` and `.test.tsx`
- Create: `src/components/admin/accounts-section.tsx` and `.test.tsx`
- Create: `src/components/admin/assignments-section.tsx` and `.test.tsx`
- Create: `src/components/admin/policy-section.tsx` and `.test.tsx`
- Delete: `src/components/admin/admin-control-panel.tsx`
- Modify: `src/server/access/service.ts`
- Modify: `src/server/access/service.test.ts`
- Modify: `src/server/actions/administration-actions.ts`
- Modify: `src/server/actions/actions.test.ts`
- Modify: `src/styles/administration.css`
- Modify: `src/styles/responsive.css`

**Interfaces:**
- Consumes: `listAdministration`, typed account/assignment actions, phone safety, Modal/drawer primitives, UTC formatting, and capability facts.
- Produces: section navigation, searchable account table/drawer, active/history assignment ledger/drawer/removal confirmation, read-only policy matrix, and phone inspect-only administration.

- [ ] **Step 1: Write administration routing and account tests**

Test default Accounts, valid query sections, unknown section normalization, non-admin redirect, columns, search, Create account drawer fields, validation summary/focus, durable success/focus new row, and absence of role-change/deactivate/password-reset controls.

- [ ] **Step 2: Write assignment and policy tests**

Test Active default and History, exact columns, reviewer/approver user filtering, processing waiting label, failed-ingest prohibition, approved reviewer prohibition, approved approver Reopen authority, duplicate active result, removal confirmation/access statement, history outcome/revision, UTC filters, and complete policy rows. Add server tests proving a forged assignment action cannot bypass those state restrictions.

- [ ] **Step 3: Write phone inspect-only tests**

At phone predicate true, account rows, assignment rows, history, and policy remain visible while Create account, Assign work, Remove assignment, and all drawers are absent. Assert exact wider-screen notice.

- [ ] **Step 4: Run admin component tests and verify old-panel failures**

Run: `npm test -- src/components/admin`

Expected: FAIL because split administration components do not exist.

- [ ] **Step 5: Render one selected section from the server route**

```tsx
const section = parseAdministrationSection(firstValue(search.section));
const model = listAdministration(principal, section, parseAdministrationFilters(search));
return <AdministrationShell section={section} model={model} />;
```

Only the selected section task renders. Secondary links use `aria-current="page"`.

- [ ] **Step 6: Implement account drawer with typed results**

Use existing `localUserSchema`, ErrorSummary, field focus, pending disable, and exact success announcement. Do not render controls for out-of-scope account lifecycle actions.

```tsx
<form onSubmit={submitAccount}><label>Name<input name="displayName" /></label><label>Email<input name="email" type="email" /></label><label>Password<input name="password" type="password" /></label><label>Role<select name="role">{USER_ROLES.map((role) => <option key={role}>{role}</option>)}</select></label><button disabled={pending}>Create account</button></form>
```

- [ ] **Step 7: Implement assignment creation and history**

Searchable recording/user controls display current state compatibility before submit. Add `assertAssignmentCompatible(recording, assignmentRole)` in `src/server/access/service.ts`: deny both roles for interrupted, verification-failed, failed, or cancelled ingest; deny reviewer for active approved; allow approver for active approved with label Reopen authority; allow both roles in processing as waiting. Call it inside the assignment transaction so a forged typed action cannot bypass the rule. Active and history ledgers remain separate and semantic.

```ts
if (isIngestFailure(recording)) throw new CasefileCommandError("VALIDATION_ERROR", "Review work cannot be assigned until ingest recovers.");
if (recording.approvedRevisionId && assignmentRole === "reviewer") throw new CasefileCommandError("VALIDATION_ERROR", "Reviewer work cannot be assigned to an approved casefile.");
return recording.approvedRevisionId ? "Reopen authority" : isProcessing(recording) ? "Waiting" : "Actionable";
```

- [ ] **Step 8: Implement deliberate removal**

Modal names recording and user, states access revocation/history retention, calls typed removal, closes on success, focuses refreshed section heading, and never deletes the row.

```ts
const result = await removeRecordingAssignmentAction({ assignmentId });
if (result.ok) {
  closeModal();
  router.refresh();
  requestAnimationFrame(() => document.querySelector<HTMLElement>("#assignments-heading")?.focus());
}
```

- [ ] **Step 9: Implement read-only policy and phone overlay**

Render playback, raw download, draft edit, submit, withdrawal, approval, request changes, reopen, approved export, and phone safety rows. There is no Save control.

```tsx
<table><thead><tr><th>Capability</th><th>Uploader</th><th>Reviewer</th><th>Approver</th><th>Admin</th></tr></thead><tbody>{model.rows.map((row) => <tr key={row.capability}><th scope="row">{row.capability}</th><td>{row.uploader}</td><td>{row.reviewer}</td><td>{row.approver}</td><td>{row.admin}</td></tr>)}</tbody></table>
```

- [ ] **Step 10: Delete the old panel, remove legacy administration CSS, and run focused tests, typecheck, and build**

```bash
! rg -n 'admin-control-panel|AdminControlPanel' app src/components
! rg -n '^\.(admin-list|policy-grid|policy-row)\b' src/styles/legacy.css
```

Run: `npm test -- src/components/admin src/server/administration/service.test.ts src/server/access/service.test.ts src/server/actions/actions.test.ts && npm run typecheck && npm run build`

Expected: admin component, read-model, assignment restriction, and typed-action tests PASS; no import references old panel; route builds.

- [ ] **Step 11: Commit split administration**

```bash
git add 'app/(authenticated)/administration' src/components/admin src/server/access src/server/actions/administration-actions.ts src/server/actions/actions.test.ts src/styles/administration.css src/styles/responsive.css src/styles/legacy.css
git commit -m "feat(admin): split institutional controls"
```

## Task 16: Complete Loading, Error, Responsive, and Accessibility Hardening

**Files:**
- Create: `app/(authenticated)/error.tsx`
- Add or refine: all route `loading.tsx` files
- Modify: `src/components/ui/page-skeleton.tsx`
- Modify: every new component test where accessibility behavior is asserted
- Modify: all `src/styles/*.css`
- Modify: `app/globals.css`
- Modify: `app/layout.tsx`
- Delete: `src/styles/legacy.css` after all feature blocks have been removed
- Create: `src/styles/styles.test.ts`

**Interfaces:**
- Consumes: shared error codes, skeleton/notice/modal primitives, all final routes/components, and exact design/accessibility constraints.
- Produces: complete shared-state behavior, final reflow/contrast/focus/motion CSS, safe errors, and no obsolete visual grammar.

- [ ] **Step 1: Add route error and loading tests**

Test auth, Work, Ingest, Casefile, and Administration skeleton labels and geometry classes; safe root/group errors; casefile not found; access-denied return; filtered empty; processing; completed-job-without-revision error; and no enabled capability buttons while unresolved.

```tsx
it.each(["authentication", "work inbox", "ingest", "casefile", "administration"])("announces the %s loading boundary", (surface) => {
  render(<PageSkeleton surface={surface} />);
  expect(screen.getByRole("status")).toHaveTextContent(`Loading ${surface}`);
});
```

- [ ] **Step 2: Add CSS contract tests for tokens and prohibited selectors**

```ts
const css = readAllProductCss();
expect(css).toContain("--color-teal-700: #163d38");
expect(css).not.toMatch(/waveform|annotation-rail|queue-card|gradient|backdrop-filter|legacy\.css/);
```

Also assert focus token, reduced-motion block, min target size, sticky offsets, 320/390 bands, 768/960/1100 bands, and export fixed positioning.

- [ ] **Step 3: Run shared-state and CSS tests and verify gaps**

Run: `npm test -- src/components src/styles/styles.test.ts`

Expected: FAIL until every route state and final CSS contract is present.

- [ ] **Step 4: Implement exact safe route boundaries**

`app/error.tsx` handles bootstrap/login failures without internal detail. Authenticated error returns Work and displays correlation ID only when supplied. Casefile not found has one Back to Work action.

```tsx
<main><h1>Superscriber could not load this page.</h1><p>Your saved server data was not changed.</p>{correlationId ? <p>Reference: {correlationId}</p> : null}<Link href="/workspace">Back to Work</Link></main>
```

- [ ] **Step 5: Complete all empty/loading/error/conflict copy**

Use the exact role empty messages and stable error behavior from specification Section 8. Unknown exceptions show safe copy and one retry. No stack, SQL, path, adapter, secret, or raw exception reaches UI. Remove the final import of `src/styles/legacy.css` and delete the now-empty file.

```ts
const EMPTY_COPY: Record<UserRole, string> = { uploader: "No uploads yet.", reviewer: "No transcript review is assigned to you.", approver: "No approval decision is waiting for you.", admin: "No recordings match these filters." };
```

- [ ] **Step 6: Complete focus, semantic, and announcement behavior**

Verify one `h1`, no heading skip, header/nav/main/aside, skip target, visible labels, error links, `aria-invalid`, polite/assertive regions, state icon/text, `aria-current`, modal/drawer focus, inert background, body lock, and focus restoration.

```tsx
<a className="skip-link" href={`#${mainTargetId}`}>Skip to main work</a>
<header><SuperscriberLogo size="sm" /><AccountMenu principal={principal} /></header><nav aria-label="Primary">{navigationLinks}</nav><main id={mainTargetId}>{primaryWork}</main><aside aria-label="Governance">{governanceContent}</aside>
```

- [ ] **Step 7: Complete responsive and zoom-safe CSS**

At 1100+ open casefile is 70/30; 960-1099 uses compact table; 768-959 uses ledger list; phone overlay takes precedence. Add 16 px phone gutters, 24 px desktop gutters, wrap long titles, reserve sticky regions, and eliminate page-level horizontal overflow.

```css
@media (min-width: 1100px) { .casefile-layout[data-governance-open="true"] { grid-template-columns: minmax(0, 7fr) minmax(280px, 3fr); } }
@media (max-width: 767px), (max-height: 767px) and (pointer: coarse) { .page-gutter { padding-inline: 16px; } }
html, body { max-width: 100%; overflow-x: clip; }
```

- [ ] **Step 8: Complete contrast and motion rules**

Primary buttons use teal/white, rust is text accent only, statuses use exact foreground/background pairs, focus ring is 2 px, motion is 120-180 ms, and reduced motion removes nonessential transitions, smooth scroll, and skeleton pulse.

```css
.button-primary { color: #fff; background: var(--color-teal-700); }
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation: none !important; } }
```

- [ ] **Step 9: Run component tests, all unit tests, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`

Expected: all unit/component tests PASS, TypeScript exits 0, and production build compiles every final route.

- [ ] **Step 10: Search for forbidden old copy and visual selectors**

Run: `rg -n 'Prototype behavior|Current implementation scope|canonical orchestration layer|Adapter|waveform|annotation-rail|queue-card|gradient|backdrop-filter' app src/components src/styles -g '*.tsx' -g '*.css'`

Expected: no matches.

- [ ] **Step 11: Commit shared-state hardening**

```bash
git add app src/components src/styles
git commit -m "fix(ui): harden responsive accessible states"
```

## Task 17: Replace Stale Browser Coverage and Validate Every Acceptance Criterion

**Files:**
- Create: `e2e/support/appliance.ts`
- Rewrite: `e2e/appliance.spec.ts`
- Rewrite: `e2e/review-mobile.regression-1.spec.ts`
- Create: `e2e/governed-casefile.spec.ts`
- Create: `e2e/accessibility.spec.ts`
- Create: `e2e/responsive.spec.ts`
- Modify: `playwright.config.ts` only if deterministic metadata/output is required
- Modify: product files only when a browser test exposes a verified defect; add the smallest matching unit regression in the owning task area

**Interfaces:**
- Consumes: final routes, role flows, stable semantic labels, dynamic revision/segment data, axe Playwright, and all AC-01 through AC-32.
- Produces: end-to-end proof for auth, ingest, assignment, workflow, admin mode, export, phone safety, accessibility, geometry, migration compatibility, and full repository validation.

- [ ] **Step 1: Extract browser helpers without generated-ID assumptions**

```ts
export type LocalUser = {
  displayName: string;
  email: string;
  password: string;
  role: "admin" | "uploader" | "reviewer" | "approver";
};
export async function bootstrapAndLogin(page: Page, user: LocalUser): Promise<void>;
export async function login(page: Page, user: LocalUser): Promise<void>;
export async function uploadFixture(page: Page, input: { title: string }): Promise<string>;
export async function createAndAssignUsers(page: Page, recordingId: string): Promise<void>;
export async function openAssignedDraft(page: Page, user: LocalUser): Promise<void>;
export async function openAssignedCasefile(page: Page): Promise<void>;
export async function openCasefile(page: Page, recordingId: string): Promise<void>;
export async function openSameDraft(page: Page): Promise<void>;
export async function saveEditedDraft(page: Page, text: string): Promise<void>;
export async function completeReasonDialog(page: Page, reason: string): Promise<void>;

export function firstTranscriptRow(page: Page) {
  return page.getByRole("article", { name: /Transcript segment 1, / });
}

export async function currentRevisionLabel(page: Page) {
  return page.getByTestId("current-revision").textContent();
}
```

Use semantic roles/labels first. Use `data-testid` only for the current revision value and geometry anchors with no user-facing semantic. Remove `seg-1` and fallback-text assumptions.

- [ ] **Step 2: Rewrite auth, ingest, and administration E2E flows**

Cover readiness, bootstrap, wrong credentials, logout, expired route return, in-place recovery, desktop/phone upload, interrupted resume, expired restart, microphone denial, dispatch failure, account creation, assignment compatibility, removal, history, and read-only policy.

```ts
test("recovers auth, ingest, and administration safely", async ({ page }) => {
  await bootstrapAndLogin(page, adminUser);
  await expect(page.getByRole("navigation", { name: "Primary" })).toContainText("Administration");
  const recordingId = await uploadFixture(page, { title: "Governed E2E recording" });
  await createAndAssignUsers(page, recordingId);
  await expect(page.getByRole("status")).toContainText("Upload received");
});
```

- [ ] **Step 3: Add full governed lifecycle E2E**

Cover reviewer edit/save position, submit lock, submitting-reviewer withdrawal, other-reviewer denial, resubmit, request changes reason, returned draft, resubmit, approval, assignment completion, Completed snapshot, export, reopen, export removal, and explicit new-cycle assignment.

```ts
test("moves one revision through withdrawal, changes, approval, export, and reopen", async ({ page }) => {
  await openAssignedDraft(page, reviewerUser);
  await firstTranscriptRow(page).getByRole("textbox", { name: /Transcript/ }).fill("Reviewed governed transcript.");
  await page.getByRole("button", { name: "Submit for approval" }).click();
  await page.getByRole("button", { name: "Withdraw revision" }).click();
  await completeReasonDialog(page, "A material omission requires another review pass.");
  await expect(page.getByRole("status", { name: "Casefile state" })).toHaveText(/Draft review/);
});
```

- [ ] **Step 4: Add admin oversight and action-mode E2E**

Cover no oversight commands, reviewer mode purpose/attribution, approver mode purpose/attribution, self-approval denial, wrong-record token denial, exit, expiry, and no implicit assignment creation.

```ts
test("requires audited admin action mode", async ({ page }) => {
  await login(page, adminUser);
  await openCasefile(page, recordingId);
  await expect(page.getByRole("button", { name: "Approve and complete work" })).toHaveCount(0);
  await page.getByRole("button", { name: "Enter approver action mode" }).click();
  await page.getByLabel("Purpose").fill("Cover the assigned approver's documented absence.");
  await page.getByRole("button", { name: "Enter approver mode" }).click();
  await expect(page.getByLabel("Admin action mode")).toContainText("acting as Approver");
});
```

- [ ] **Step 5: Add conflict and unauthorized E2E**

Use two browser contexts for stale draft and pending decision races. Verify local text preservation, winning state announcement, removed/unassigned access denial, and historical snapshot isolation from a reopened cycle.

```ts
const first = await browser.newPage();
const second = await browser.newPage();
await Promise.all([openSameDraft(first), openSameDraft(second)]);
await saveEditedDraft(first, "First writer text");
await saveEditedDraft(second, "Second writer local text");
await expect(second.getByRole("region", { name: "Revision conflict" })).toBeVisible();
await expect(second.getByDisplayValue("Second writer local text")).toBeVisible();
```

- [ ] **Step 6: Add export modal and all-format E2E**

Verify fixed geometry, internal scroll, inert background, body lock, focus loop, Escape/restore, seven formats, approved bytes, `export.issued`, 401 recovery, 403/409 state, and failed-response retry.

```ts
await page.getByRole("button", { name: "Export approved" }).click();
const dialog = page.getByRole("dialog", { name: /Approved export/ });
for (const format of ["DOCX", "TXT", "SRT", "VTT", "CSV", "TSV", "JSON"]) await expect(dialog.getByRole("button", { name: format })).toBeVisible();
expect(await page.getByTestId("export-backdrop").evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
await page.keyboard.press("Escape");
await expect(page.getByRole("button", { name: "Export approved" })).toBeFocused();
```

- [ ] **Step 7: Add phone portrait and landscape safety E2E**

Use 320 x 800, 390 x 844, and 844 x 390 with coarse-pointer emulation. Verify supported auth/status/read-only transcript/media/upload and absence of every prohibited mutation and action dispatch.

```ts
for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  const phone = await context.newPage();
  await openAssignedCasefile(phone);
  await expect(phone.getByText(/Review and decisions require a tablet or desktop/)).toBeVisible();
  await expect(phone.getByRole("button", { name: /Save|Submit|Approve|Reopen|Export|Enter .* mode/ })).toHaveCount(0);
  await context.close();
}
```

- [ ] **Step 8: Add responsive geometry E2E**

At 390 verify transcript top at or before 500 px and 16 px gutters. At 1440 verify transcript top at or before 400 px. At all specified viewports assert no page-level horizontal overflow, 44 px targets, title wrapping, sticky non-overlap, and action-bar last-row visibility.

```ts
const transcriptBox = await page.getByTestId("transcript-start").boundingBox();
expect(transcriptBox?.y).toBeLessThanOrEqual(viewport.width < 768 ? 500 : 400);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
expect(overflow).toBe(0);
for (const control of await page.getByRole("button").all()) {
  const box = await control.boundingBox();
  if (box) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
}
```

- [ ] **Step 9: Add axe, keyboard, focus, zoom, and reduced-motion E2E**

```ts
const results = await new AxeBuilder({ page }).analyze();
expect(results.violations).toEqual([]);
```

Scan auth, each inbox role, ingest, draft, pending, approved export modal, all administration sections, error summary, and conflict panel. Add keyboard-only workflows, 200 percent zoom, reduced-motion media query, and focus restoration assertions.

- [ ] **Step 10: Run focused browser tests against a fresh mock appliance**

Run:

```bash
E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/superscriber-governed.XXXXXX")"
SUPERSCRIBER_ENGINE_MODE=mock \
SUPERSCRIBER_DB_PATH="$E2E_ROOT/app.db" \
SUPERSCRIBER_UPLOAD_TMP_DIR="$E2E_ROOT/uploads" \
SUPERSCRIBER_MEDIA_DIR="$E2E_ROOT/media" \
PORT=3105 NEXTAUTH_URL=http://127.0.0.1:3105 \
npm run dev >"$E2E_ROOT/app.log" 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT
READY=0
for attempt in $(seq 1 60); do
  if python3 scripts/http_probe.py http://127.0.0.1:3105/api/health; then READY=1; break; fi
  sleep 1
done
test "$READY" = 1
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3105 npm run e2e
kill "$APP_PID"
wait "$APP_PID" 2>/dev/null || true
trap - EXIT
```

Expected: all Playwright specs PASS with no skipped workflow test and retained failure artifacts empty. This stops only the dev process started by the command and does not touch any shared agent daemon.

- [ ] **Step 11: Run migration fixture and repository validation**

Run: `npm test -- src/server/db/migrations.test.ts src/server/store.test.ts src/server/casefile src/server/access/service.test.ts`

Expected: fresh/current migration, state version, transitions, assignment, action session, capabilities, and access tests PASS.

- [ ] **Step 12: Run the complete required validation gate**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run worker:check
npm run e2e
npm run e2e:container
```

Expected: every command exits 0; all Vitest tests pass; production routes compile; Python worker syntax passes; local and container browser suites pass.

- [ ] **Step 13: Perform the required visual and accessibility inspection**

Inspect 320 x 800, 390 x 844, 844 x 390 coarse pointer, 768 x 1024, 1024 x 768, and 1440 x 1000 in a real browser. Verify pixel alignment, exact tokens, no old visual grammar, 200 percent zoom, keyboard-only flow, visible focus, reduced motion, long titles, long transcripts, empty/loading/error/conflict states, and transcript top thresholds. Record defects as failing Playwright or component regressions before fixing them.

- [ ] **Step 14: Verify acceptance-criterion coverage mechanically**

Use the matrix below. For each AC, record the passing test name or browser assertion in the implementation commit notes. No AC can be marked by visual assumption alone.

- [ ] **Step 15: Commit browser coverage and final verified fixes**

```bash
git add e2e playwright.config.ts app src
git commit -m "test(e2e): cover governed casefile workflows"
```

## Acceptance-Criterion Coverage Matrix

| Criterion | Owning tasks | Required proof |
|---|---|---|
| AC-01 | 8, 10 | AppShell role-nav component tests and route E2E |
| AC-02 | 9, 10, 12, 13, 15, 16 | UI copy search plus per-route browser assertions |
| AC-03 | 6, 10 | Work read-model no-fallback test and reviewer/approver E2E |
| AC-04 | 13, 16, 17 | 390 and 1440 transcript-top geometry assertions |
| AC-05 | 4, 13 | Pending/approved save command rejection and no-textbox component/E2E tests |
| AC-06 | 5, 14 | Submitter-only withdrawal unit, dialog, and E2E tests |
| AC-07 | 3, 5, 14, 17 | Self-decision command/capability/admin-mode E2E tests |
| AC-08 | 5, 17 | Transition pointer and two-context race tests |
| AC-09 | 2, 5, 6, 17 | Atomic completion transaction and actionable-count E2E |
| AC-10 | 2, 6, 10, 17 | Completed snapshot and removed-access unit/E2E tests |
| AC-11 | 5, 14, 17 | Reopen pointer/export/assignment tests |
| AC-12 | 3, 6, 13, 14 | Oversight capability, rendering, invocation, and E2E tests |
| AC-13 | 3, 14 | 30-minute action-session and purpose tests |
| AC-14 | 1, 2, 3, 5, 14 | Audit shape and rendered attribution tests |
| AC-15 | 3, 7, 17 | Ended/expired/wrong-boundary command and E2E tests |
| AC-16 | 8, 9, 10, 12, 13, 17 | Portrait/landscape supported-surface E2E |
| AC-17 | 8, 12, 13, 14, 15, 17 | Phone absence and no-dispatch tests |
| AC-18 | 8, 10, 12, 13, 16, 17 | 320/390 overflow and target geometry tests |
| AC-19 | 3, 6, 7, 14 | Export capability/read-model/route/component tests |
| AC-20 | 8, 14, 17 | Modal unit and browser focus/geometry tests |
| AC-21 | 7, 14, 17 | Seven-format download and `export.issued` tests |
| AC-22 | 7, 14, 17 | Negative export route/component/E2E tests |
| AC-23 | 8, 9, 10, 12, 13, 14, 15, 16, 17 | Component accessibility and axe/manual browser suite |
| AC-24 | 7, 13, 14, 17 | Save focus/scroll and transition focus tests |
| AC-25 | 9, 13, 14, 17 | In-memory reauth and no-auto-retry tests |
| AC-26 | 4, 13, 17 | Conflict snapshot/local-text/discard tests |
| AC-27 | 9, 10, 12, 13, 15, 16 | Route and shared-state component/E2E tests |
| AC-28 | 1, 17 | Current-schema fixture upgrade and container persistence tests |
| AC-29 | 1, 17 | One-time legacy assignment/reopen audit tests |
| AC-30 | 1, 2, 6, 8, 11, 17 | Route compatibility, ownership, null legacy, and access tests |
| AC-31 | 17 | Complete required validation gate |
| AC-32 | 8, 10, 13, 14, 16, 17 | CSS/copy searches and visual browser inspection |

## Plan Self-Review Checklist

Before execution begins, verify this plan against the approved specification:

- Every specification section maps to at least one task and every AC maps to explicit proof above.
- The plan contains no deferred implementation marker, incomplete code step, or unresolved product choice.
- `ActorContext`, `CasefileAccessGrant`, `CasefileCapabilities`, command input types, `CasefileViewModel`, `WorkInboxViewModel`, and `CommandResult` names and fields match in every task.
- Every governed command accepts `Principal`, expected revision ID, and optional action-mode ID exactly once; no client provides base/effective role or actor user ID.
- Assignment completion is called inside approval's targeted transaction, not in a second write.
- Export accepts format and action-mode ID but never a revision ID.
- Phone safety is a client support overlay and never replaces server role/state/access/policy checks.
- Snapshot writes keep state-version conflict protection and do not rewrite assignments or action sessions.
- Each task starts with a failing focused test, names the expected failure, runs the passing focused suite, runs typecheck, and ends with a scoped commit.
