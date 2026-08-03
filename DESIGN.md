# DESIGN

## Purpose

Superscriber is a calm, governed institutional workspace, not a generic AI dashboard and not a developer console. The core product promise is simple: sensitive recordings enter one controlled system, reviewers do careful work in the browser, and approvals happen against an explicit, traceable record.

This file is the design record and the visual and interaction source of truth for the product as shipped on `main` (v0.3.0.0). It records both how the product looks and how its governed workflow behaves; code is authoritative for anything beyond what is written here.

## The Governed Casefile Model

### Product intent

Each recording is a governed casefile: a compact work inbox leads into a transcript-first record whose state, assignment, actions, provenance, and audit history agree at all times. Three patterns organize it:

- **Governed casefile** is the organizing model for each recording.
- **Editorial transcript details** make long-form review efficient and readable.
- **Ledger worklists** make assignments and workflow state scannable at operational volume.

This is a behavioral contract, not a visual reskin. The interface never offers an action the domain cannot safely honor, and the domain records the identity and context behind every governed action.

### Design principles

1. **State is a promise.** Labels, affordances, commands, work counts, and server permissions all describe the same state.
2. **One dominant job.** Work pages prioritize the next role-valid action; the casefile prioritizes transcript review; administration prioritizes the selected task.
3. **Transcript first.** Playback and transcript occupy the primary zone; governance is available without outranking the work.
4. **Deliberate governance.** Submit, withdraw, approve, request changes, reopen, export, assignment removal, and admin action-mode entry get explicit confirmations proportional to their consequence.
5. **Attribution over impersonation.** An admin never becomes another user; audit states the admin's identity and the effective reviewer or approver role.
6. **History is append-only.** Revisions, decisions, assignments, exports, and admin action sessions remain attributable after active work clears.
7. **Safe interruption.** Transcript text lives only in memory; nothing persists it to browser storage. Resumable upload keeps only non-content session metadata in local storage.
8. **Progressive disclosure.** Current state is always visible; provenance, policy, assignment history, revision history, and audit detail open on demand.
9. **Offline consistency.** Fonts, icons, and core behavior ship inside the appliance; no third-party runtime service is required.
10. **Accessibility is part of correctness.** An action is incomplete until its keyboard, focus, announcement, contrast, reflow, and error behavior is verified.

### Governing state

Progress is never collapsed into one uncontrolled status string. The UI derives a display stage from five authoritative dimensions:

1. **Integrity state:** capturing, uploading, verifying, verified, verification failed, or interrupted.
2. **Transcript job state:** queued, running, partial result, completed, failed, or cancelled.
3. **Current revision state:** draft, pending approval, or none.
4. **Active approved pointer:** the revision currently approved for export, or none.
5. **Assignment state:** active, completed, or removed, per reviewer/approver activation.

Historical revision terminal states are `superseded`, `withdrawn`, and `changes_requested`; `approved` stays on an approved revision even after a reopen, and the recording's `approvedRevisionId` decides whether it is the active approved record.

Derived stages, evaluated in order: `Needs ingest attention`, `Verifying`, `Transcribing`, `Pending approval`, `Approved`, `Changes requested`, `Reopened`, and `Draft review`. A withdrawn submission returns to `Draft review`.

### Revision and decision commands

Every governed command carries an expected revision identifier and runs in one database transaction; the first valid transition wins and a racer receives a typed conflict. The command set:

- **Save draft** - only while the current revision is a draft; supersedes the prior draft and creates the next numbered draft with complete segment content. The full segment array is submitted on save; there is no per-keystroke serialization.
- **Submit revision** - saves dirty content first, then marks the draft `pending_approval` and records `submittedAt`/`submittedByUserId`.
- **Withdraw submission** - only the recorded submitter, only while pending, with a required 10-500 character reason. The pending revision becomes historical and its content is cloned into a new draft.
- **Request changes** - any authorized approver who is not the submitter, with a required reason. The pending revision becomes historical and its content is cloned into a new draft; assignments stay active.
- **Approve** - any authorized approver who is not the submitter, with an optional note. Locks the revision, sets `approvedRevisionId`, and completes every active reviewer and approver assignment in the same transaction.
- **Reopen** - requires an active approved revision and a required reason. Keeps the old revision historically approved, clears `approvedRevisionId`, clones the approved content into a new draft, and does not reactivate completed assignments.
- **Export** - builds the selected format from the active approved revision, appends an audited `export.issued` event, and returns `Cache-Control: no-store` bytes. Export never changes workflow state.

Submit, withdraw, request changes, approve, and reopen never mutate transcript text on the submitted or approved revision. Transition-created drafts preserve the prior summary and segments through `basedOnRevisionId`. The legacy `rejected` state is no longer written; existing rejected records display as `Changes requested (legacy)`.

### Assignment semantics

Each assignment activation is an append-only row: recording, user, role snapshot, assigning admin identity, assigned time, status, end time, ending reason, and completion revision when completed by approval. At most one active assignment exists per recording, user, and role; reassigning after completion appends a new row.

- Submission, withdrawal, and request changes leave assignments active.
- Approval completes all active reviewer and approver assignments in the same transaction, recording the approved revision as each assignment's completion revision.
- Manual admin removal sets status `removed` with ending reason `removed_by_admin`, revoking the user's casefile access from that assignment while history remains.
- A completed assignment grants read-only access to its recorded approved snapshot, not to any later reopened cycle. A completed approver assignment for the currently active approved revision retains reopen and policy-gated export authority.

Approval therefore clears active work without erasing provenance or breaking approved export for the people who finished the record.

### Identity and separation of duties

Every submission stores `submittedByUserId`. Approval and request changes are forbidden to the submitting user, including an admin switching from reviewer to approver action mode; the UI suppresses decision controls with an explanation and the server independently rejects the command. Legacy pending revisions without a submitter identity cannot be withdrawn but can be decided by an authorized approver, with the missing identity noted in audit metadata.

### Admin oversight and action mode

Admin base access is read-only oversight: every inbox row, every current casefile, transcript, policy, provenance, assignments, revision history, decisions, and audit - plus ingest, account creation, and assignment management as native admin duties. Oversight cannot edit, save, submit, withdraw, approve, request changes, reopen, or export.

For governed casefile work the admin enters an explicit, record-bound reviewer or approver action mode from the casefile header. Entry requires a 10-500 character purpose, creates an `admin_action_sessions` row with a fixed 30-minute expiry, and is audited. A persistent banner names the admin, the effective role, the purpose, and the expiry, with `Exit action mode`. Only one active session per admin and recording is valid; every governed command validates the session. Audit attribution reads in the form `Morgan Lee (Admin), acting as Approver, approved revision v4.` Action mode never creates an assignment and never impersonates an assigned user; approval in approver mode still completes all real active assignments.

### Access grants and policy overlay

The server computes an access grant before policy capabilities:

- Uploader who created the recording: status, ingest progress, and non-transcript metadata only.
- Active reviewer/approver assignment: current casefile transcript plus policy-permitted media.
- Assignment completed by approval: the approved snapshot named by the assignment.
- Removed assignment: no access from that assignment.
- Admin oversight: every current casefile, read-only.
- No relationship: no inbox row and no direct-route access.

Role and state authority are necessary but not sufficient: the active workspace policy can remove media and export capabilities, and raw media download is always unavailable. The server ships a derived `capabilities` object per casefile (with machine-readable denial reasons) and recomputes it on every command; the client never reconstructs governed permissions from role strings.

### Phone safety overlay

Phone safety mode applies below 768 CSS px width, or when the primary pointer is coarse and viewport height is below 768 CSS px (landscape phones). It permits setup, login, session recovery, worklists, status, authorized read-only casefile content, policy-permitted playback, and supported ingest. It removes and client-guards every governed mutation - transcript editing, withdrawal, approval, request changes, reopen, export, administration changes, and action-mode entry - with copy stating that review and decisions require a tablet or desktop. Viewport classification is a supported-surface rule only; server role, state, assignment, self-approval, policy, and action-mode checks remain the security boundary.

### Shared error and conflict behavior

Errors use stable codes with procedural messages: `AUTH_EXPIRED` (in-page recovery when unsaved content exists, otherwise login with a sanitized return route), `ACCESS_DENIED`, `NOT_FOUND`, `VALIDATION_ERROR`, `ACTION_MODE_REQUIRED`, `ACTION_MODE_EXPIRED`, `ACTION_MODE_FORBIDDEN`, `ACTION_MODE_ENDED`, `SELF_APPROVAL_FORBIDDEN`, `STALE_REVISION`, `STATE_CHANGED`, and `INTERNAL_ERROR`. Draft-save conflicts preserve local text in memory, name the loaded and current revision IDs, offer open-latest-in-a-new-tab comparison, and require explicit confirmation before discarding. Decision conflicts close the dialog and announce the winning transition. Unknown errors never expose stack traces, paths, adapter names, or raw exception text.

## Product Posture

- Calm, explicit, non-alarmist
- Transcript-first, not metadata-first
- Utility language over marketing language inside the app
- Trust comes from clarity: what happened, what is safe, what happens next
- Admin and bootstrap flows are part of the same product, not a separate back office

## Visual Grammar

`src/styles/tokens.css` is the authoritative token file; this section records the intent behind it.

### Typography

Fonts are bundled as WOFF2 inside the appliance (offline posture); nothing fetches fonts at runtime.

- Display/headings: Newsreader variable (serif), `--font-display`
- Body/UI text: Public Sans variable (humanist sans), `--font-ui`
- Monospace: IBM Plex Mono, `--font-mono` - reserved for revision ids, timestamps, and technical identifiers

Body is 16 px; dense ledger rows run 14 px; the main casefile title is 32 px desktop and 24 px narrow. No all-caps headings; 12 px uppercase is reserved for short eyebrows.

### Color

- Base background: warm paper (`--color-bone` / `--color-paper`)
- Primary dark surface and primary buttons: deep teal (`--color-teal-700`)
- Accent for eyebrows, links, and high-salience marks: restrained rust (`--color-rust-600`)
- Status tones: explicit success green, warning amber, danger red, informational blue-gray
- Focus ring: teal (`--color-focus`), 2 px, at least 3:1 contrast, never clipped by sticky containers
- Avoid bright SaaS gradients, purple-blue palettes, and decorative color noise

### Surfaces

- Primary work surfaces use paper, a 1 px border, and one quiet elevation; typography and spacing carry hierarchy before shadows
- Secondary context is visually lighter than the main task
- Cards only when the card is the interaction
- Spacing scale 4-48 px; control radius 8 px, surface radius 12 px, modal radius 16 px
- Motion is limited to 120-180 ms opacity/transform transitions; `prefers-reduced-motion` removes nonessential transitions and smooth scrolling

## Core Layout Rules

- Every screen has one dominant job and one dominant CTA
- Primary workspace first, secondary context second, system chrome third
- Secondary context must never outrank the transcript, worklist, or active task
- If three things cannot fit comfortably on first view, cut to the three that matter most now
- Authenticated pages share one 64 px app shell: brand mark linked to `/workspace`, exact role-based navigation, current role label, account menu, and a skip link targeting the page's dominant work region

## Information Architecture

### Routes

| Route | Purpose | Access |
|---|---|---|
| `/` | First-run setup when no user exists; steady-state login otherwise | Public |
| `/workspace` | Role-aware work inbox | Every authenticated role |
| `/ingest` | Focused upload or supported browser-record flow | Uploader and admin |
| `/recordings/[recordingId]` | Current casefile or an authorized historical approved snapshot | Principals with an access grant |
| `/administration?section=accounts` | Local account directory and creation | Admin |
| `/administration?section=assignments` | Active assignments and assignment history | Admin |
| `/administration?section=policy` | Read-only active policy profile and permission matrix | Admin |

Casefile URLs accept `revision=<revisionId>` for an authorized historical approved snapshot and `actionMode=<adminActionSessionId>` to activate a validated admin action mode. Neither grants access by itself; the server validates both against the signed-in user, recording, assignment history, and action session.

Primary navigation is exact: uploader gets Work and Ingest; reviewer and approver get Work; admin gets Work, Ingest, and Administration. An admin action mode never changes the navigation or account identity.

### First-Run And Login

- First-run setup is a dedicated one-time gate before normal login
- First-run flow has exactly three jobs:
  1. confirm appliance/environment readiness
  2. create the first admin
  3. hand off to normal login
- Daily login is a separate steady-state screen
- A concurrent bootstrap that loses the race converts to login with a completion notice; it never creates a second admin

### Work Inbox

All roles share one ledger framework with role-specific tabs, a state-aware next-action strip, and server-backed search, filters, and sort in URL parameters.

- Uploader: `My uploads`, `Needs attention`, `Processing`, `Ready`
- Reviewer: `To review`, `Waiting`, `Completed`
- Approver: `To decide`, `Waiting`, `Completed`
- Admin: `All`, `Needs attention`, `Review`, `Approval`, `Approved`

The next-action strip appears only when at least one role-valid actionable row exists; it never falls back to a waiting, completed, approved, or merely visible recording, and the Completed tab is excluded from actionable counts. State badges always combine text with an icon or shape; datetimes display as explicit UTC.

### Ingest

`/ingest` is a focused progressive surface with three labeled stages on one route: Source (upload file or record audio), Details (title and language hint), and Transfer (byte progress, resumability, verification handoff, and recovery action). The 1 MiB chunk protocol and 24-hour abandoned-session cleanup remain; local storage carries only session ID and file identity metadata. Only the session creator can resume, append, or finalize bytes. On return the user gets exactly one of resume, finalize, or start-again, with the committed byte offset on resume. Dispatch failure after durable finalization never asks for the same bytes again.

### Casefile review

Every transcript-capable casefile begins directly below the app shell:

1. Sticky case header: back to Work, title, derived workflow state, current revision, assignment summary or snapshot label, unsaved-state indicator, and the admin oversight/action-mode control.
2. Sticky media transport directly above the transcript: native accessible audio/video controls, current time, jump-back, playback rate, and current segment label - no decorative waveform.
3. Transcript area: 96 px timestamp gutter with play-from buttons, 128 px speaker field, flexible text, confidence as subordinate text. Editable only in draft state; pending and approved revisions render immutable text. The active playback row combines a visual marker with `aria-current`.
4. Sticky state action bar showing only state-valid commands for the current principal.
5. Governance drawer holding policy, provenance, assignment history, revision history, decisions, and audit - collapsed to a labeled rail by default on wide screens.

A recording owner with uploader-only access receives a status casefile: ingest progress, safe metadata, and recovery guidance, with no transcript, media, decisions, or audit content.

### Approved export

- Approved export stays anchored to the approved casefile action bar, not a separate reporting screen
- Export appears only when the current revision is approved and the policy profile and principal grant allow download
- The chooser is a portal-rendered viewport modal (bounded bottom sheet on compact tablet) grouped into Document (`DOCX`, `TXT`), Captions (`SRT`, `VTT`), and Structured data (`CSV`, `TSV`, `JSON`)
- Each successful download records actor, effective role, revision, format, and UTC time before bytes are returned

### Administration

Administration has secondary navigation for Accounts, Assignments, and Policy; the selected section is the page's `h1` and only its task is shown. Accounts supports search plus a create-account drawer. Assignments defaults to Active with a History tab showing outcomes and completion revisions; `Assign work` explains whether an assignment is actionable now or waiting for a compatible state. Policy is read-only: the active profile and the permission matrix, including the note that phone safety mode removes governed mutations and export. Existing account role changes, deactivation, and password management are deliberately not rendered.

## Interaction And Copy Rules

- Prefer procedural language: "Session expired. Sign in again to continue."
- Avoid vague status theater: no fake autosave, no decorative warning copy
- Warnings appear only when risk or blocked action is real
- Success messages confirm the durable thing that happened: saved revision, queued upload, approved record
- Partial states must explain whether the user can continue safely
- User copy never contains prototype, migration, adapter, or implementation-scope language

## State Specifications

### Authentication

| State | User Sees | Primary Action |
|---|---|---|
| First run | Setup gate with environment/trust framing and first-admin form | Create admin |
| Normal login | Simple sign-in surface with local account fields and policy context | Sign in |
| Wrong password | Inline error on the form, no ambiguous failure language | Retry sign-in |
| Session expired | Clear interruption message with return-to-login handoff; in-place reauthentication when unsaved work exists | Sign in again |
| Logged out | Quiet confirmation that the session ended safely | Return to login |

### Ingest Interruption

| State | User Sees | Primary Action |
|---|---|---|
| Resumable | Upload/recording was interrupted but server still has a resumable session | Resume |
| Needs restart | Verification failed or bytes mismatch prevents safe resume | Restart upload/recording |
| Expired/cleaned up | Server removed abandoned temporary material under retention policy | Start a new session |

### Review And Decision States

| State | User Sees | Primary Action |
|---|---|---|
| Stale revision conflict | "This recording changed since you opened it", loaded and current revision ids, and what changed; local text preserved | Reload and reconcile (with explicit discard confirmation) |
| Save blocked by lock/approval | Explicit lock reason and current approval state | View latest approved/reopened state |
| Self-decision forbidden | Decision controls absent; separation-of-duties explanation | None (a different person must decide) |
| Admin action mode expired | Action controls removed, edits preserved in memory | Re-enter action mode |
| Pending (submitter) | `Withdraw submission` available until an approver acts | Withdraw (with required reason) or wait |

## Responsive Behavior

- 1100 px and above: full work ledger; casefile is 70/30 transcript and governance; sticky case header, transport, and action bar
- 768 to 1099 px: full governed actions; transcript first in one column; governance opens as a side drawer; ledger becomes a semantic list on narrower widths
- Phone safety mode (below 768 px width, or coarse pointer with height below 768 px): read-only casefile and administration, semantic ledger lists, compact transport, governance accordions, supported ingest; no governed action bar
- The transcript begins within 400 px of the document top on desktop and within 500 px on a 390 px phone; there is no page-level horizontal scroll at 320 or 390 px
- Sticky regions must not overlap or hide focused controls, including at 200 percent browser zoom
- Secondary context collapses before the primary transcript/editor area does

## Accessibility Acceptance Spec

These requirements apply to the auth, work inbox, ingest, casefile, export, and administration surfaces. A feature is not design-complete until these pass. Automated enforcement exists via the axe suite (`e2e/accessibility.spec.ts`) and the responsive suites; this section remains the contract they implement.

### Global

- Normal text contrast at least 4.5:1; large text and essential non-text UI at least 3:1
- Interactive targets at least 44 px in both dimensions where practical
- Visible labels remain present even when fields contain content; placeholders are supplementary only
- Keyboard focus is always visible with a 2 px indicator at 3:1 contrast, never clipped by sticky containers
- One `h1` per page; headings and landmarks reflect the real page structure; the skip link targets the dominant work region
- Status never relies on color alone; every state badge combines text with an icon or shape
- Text remains usable at 200 percent zoom and under browser text-only enlargement

### Auth And First-Run

- Login and bootstrap screens are fully keyboard-operable without pointer input
- Focus lands on the page heading or first invalid field after navigation/submit
- Wrong-password and expired-session errors are announced and tied to the relevant form
- Successful logout returns focus to the login heading or first actionable control

### Worklists

- Ledger regions expose meaningful headings and real table semantics; narrow layouts use lists with explicit data labels
- Filter changes and empty states are announced clearly
- "Next action" is reachable without tabbing through unrelated chrome first

### Ingest

- Source selection is a keyboard-operable radio group and exposes selected state
- Progress and interruption states are exposed through live regions (start, every 10 percent boundary, interruption, finalization, completion) without spamming announcements
- Resume, start-again, and cleanup outcomes are distinguishable by text alone, not color alone

### Casefile

- The transcript, segment list, and editor are operable without mouse-only gestures
- Active segment state is communicated visually and programmatically (`aria-current` plus a marker)
- Save/submit/decision actions preserve sensible focus: save keeps focus in the edited field; state transitions focus and announce the updated case state
- Conflict states announce what changed and name the next recovery action
- The governance drawer preserves focus order and restores focus when closed

### Media

- Audio/video controls remain reachable and understandable when native controls are used
- If playback is denied or media is missing, one clear explanation replaces the control region

## Anti-Slop Rules

- No generic admin/settings visual fork for bootstrap or account screens
- No three-column SaaS feature-grid thinking inside task screens
- No centered-everything app layouts
- No decorative status cards where a list, table, or drawer is the clearer pattern
- No ornamental warning banners on routine flows
- No decorative waveforms or fake transport status
- No marketing hero, metric-card grid, repeated policy panel, or six simultaneous queue cards on the work inbox

## Deliberately Out Of Scope For V1

- Full phone editing parity for long transcript correction
- Patch-based segment editing protocol (saves submit the complete current segment array)
- Institutional SSO as an auth mode
- Timing-edit tools for transcript alignment
- Bulk workflow decisions or bulk assignment changes
- Policy authoring or policy-profile switching in the UI
- Account deactivation, role changes, or password reset
- Raw media download
- A separate reporting or export center

## Implementation Check

Before shipping a new screen, confirm:

1. What is the one dominant job on this screen?
2. Is the primary work visually stronger than the secondary context?
3. Does the copy say what happened, what is safe, and what happens next?
4. Does the screen still work by keyboard and screen reader?
5. Does this surface still feel like Superscriber, not a generic admin panel?
6. Does every offered action match the server-derived capabilities and state preconditions?
