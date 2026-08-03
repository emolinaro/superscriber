# Superscriber Governed Casefile Design

**Date:** 2026-08-01

**Status:** Ready for implementation planning after captain review

**Scope:** One coordinated redesign of authenticated Superscriber product surfaces and the workflow contracts required to make those surfaces truthful

## 1. Product intent

Superscriber will become a role-aware governed casefile. A compact work inbox leads into a transcript-first record whose state, assignment, actions, provenance, and audit history agree at all times.

The redesign uses three complementary patterns:

- Governed Casefile is the organizing model for each recording.
- Editorial transcript details make long-form review efficient and readable.
- Ledger worklists make assignments and workflow state scannable at operational volume.

This is not a visual reskin. The interface must stop offering actions that the domain does not safely support, and the domain must record the identity and context behind every governed action.

### 1.1 Goals

1. Put actionable work and transcript content before policy explanation or decorative chrome.
2. Give each role a compact home with a trustworthy next action and one ledger of relevant work.
3. Make draft, pending, approved, withdrawn, changes-requested, and reopened behavior explicit and race-safe.
4. Let the submitting reviewer deliberately withdraw a pending revision before an approver acts, with a required reason and complete audit attribution.
5. Complete active reviewer and approver assignments automatically on approval without deleting assignment history.
6. Separate an administrator's default oversight authority from explicit reviewer or approver action mode.
7. Keep phones useful for authentication, setup, status, read-only casefile review, and supported ingest while preventing governed review, decision, administration, and export actions.
8. Preserve the appliance's offline, server-bound media posture and policy-gated approved export.
9. Meet WCAG 2.2 AA and provide deterministic focus, loading, error, conflict, and recovery behavior.
10. Keep the result implementable as one staged implementation plan in the existing Next.js, React, TypeScript, SQLite, and Playwright stack.

### 1.2 Non-goals

- Full phone transcript editing, approval, request-changes, withdrawal, reopen, export, account management, assignment management, or admin action mode
- Raw media download
- Transcript timing edits or segment split and merge tools
- A patch-based segment editing protocol; saves continue to submit the complete current segment array
- Bulk workflow decisions or bulk assignment changes
- Policy authoring or policy-profile switching in the UI
- Account deactivation, role changes, password reset, institutional SSO, or multi-tenant administration
- New transcription, diarization, worker, or model behavior
- Persistent browser storage of transcript text or credentials
- A new upload cancellation or retention-policy editor
- A separate reporting or export center

## 2. Problems this design corrects

The current product has real access control and workflow foundations, but its interface and state model create unsafe or misleading expectations.

| Current problem | Required correction |
|---|---|
| Repeated session panels, heroes, metrics, policy cards, and empty queue cards bury the task. | Use one 64 px app header, a compact role summary, status tabs, and one ledger. |
| The transcript begins after roughly 1.5 desktop viewports and more than 2.5 phone viewports. | Place the transcript within the first 400 px on desktop and 500 px on a 390 px phone. |
| Pending and approved revisions still look editable. | Render immutable text in non-draft states and expose only state-valid actions. |
| Saving after submission can silently replace pending state. | Reject draft saves outside the active draft state. Withdrawal and request changes are the only paths from pending back to draft. |
| Approved records retain draft-oriented copy. | Use state-specific headers, copy, controls, and locked revision treatment. |
| Approved export is positioned relative to the review shell and can render offscreen. | Render a viewport-fixed modal or bounded bottom sheet with inert background and scroll containment. |
| Approval leaves assigned records presented as active work. | Complete every active reviewer and approver assignment in the approval transaction and never fall back to a non-actionable next item. |
| Admin is an implicit super-role. | Default admin casefile access is read-only oversight. Reviewer and approver actions require an explicit, record-bound, audited action mode. |
| Assignment rows are reactivated and overwritten, so cycles are not historical. | Make each assignment activation append-only and end it with an explicit outcome. |
| Audit events contain a role but not a durable user identity or effective admin mode. | Store base actor, effective role, user identity, action-mode identifier, structured metadata, and UTC time. |
| Phone review is safe only because controls are visually removed at one breakpoint. | Define a complete phone support contract, guard all client commands, and test portrait and landscape phone modes. |
| Action redirects lose transcript position and focus. | Return typed action results in place, preserve editor state, and move focus only when the workflow state changes. |
| Prototype and implementation language appears in user-facing copy. | Use procedural copy that states what happened, what is safe, and what happens next. |

## 3. Design principles

1. **State is a promise.** Labels, field affordances, available commands, work counts, and server permissions must describe the same state.
2. **One dominant job.** Work pages prioritize the next role-valid action. Casefiles prioritize transcript review. Administration prioritizes the selected administrative task.
3. **Transcript first.** Playback and transcript occupy the primary visual zone. Governance is available without outranking the work.
4. **Deliberate governance.** Submission, withdrawal, approval, request changes, reopen, export, assignment removal, and admin action-mode entry use explicit confirmations appropriate to their consequence.
5. **Attribution over impersonation.** An admin never becomes another user. The audit states the admin's identity and the effective reviewer or approver role.
6. **History is append-only.** Revisions, decisions, assignments, exports, and admin action sessions remain attributable after the active work clears.
7. **Safe interruption.** Unsaved transcript text is not placed in local storage. In-memory edits survive recoverable action errors and in-page reauthentication. Resumable media upload retains only non-content session metadata in local storage.
8. **Progressive disclosure.** Current state is always visible; provenance, policy, assignment history, revision history, and audit detail open on demand.
9. **Offline consistency.** Fonts, icons, and core interaction behavior ship with the appliance and require no third-party runtime service.
10. **Accessibility is part of correctness.** A workflow action is incomplete until its keyboard, focus, announcement, contrast, reflow, and error behavior is verified.

## 4. Information architecture

### 4.1 Routes

| Route | Purpose | Access |
|---|---|---|
| `/` | First-run setup when no user exists; steady-state login otherwise | Public |
| `/workspace` | Role-aware Work inbox | Every authenticated role |
| `/ingest` | Focused upload or supported browser-record flow | Uploader and admin |
| `/recordings/[recordingId]` | Current casefile or an authorized historical approved snapshot | Authorized principals described in Section 6 |
| `/administration?section=accounts` | Local account directory and account creation | Admin |
| `/administration?section=assignments` | Active assignments and assignment history | Admin |
| `/administration?section=policy` | Read-only active policy profile and permission matrix | Admin |

Existing `/workspace` remains the authenticated landing route, so saved links and the Auth.js callback do not need a route migration. The current inline ingest and administration panels move to dedicated routes. Unknown or unauthorized administration sections resolve to `accounts` for admins and to `/workspace` with an access notice for non-admins.

Casefile URLs use these optional query parameters:

- `revision=<revisionId>` requests an authorized historical approved snapshot.
- `actionMode=<adminActionSessionId>` activates a validated admin reviewer or approver mode for that recording.

Neither value grants access by itself. The server validates it against the signed-in user, recording, assignment history, and action-session record.

### 4.2 App shell and role-aware navigation

Authenticated pages share a 64 px `AppShell` header containing:

- Superscriber mark and product name, linked to `/workspace`
- Primary navigation
- Current role label
- Account menu with display name, email, and Sign out

Primary navigation is exact:

| Role | Destinations |
|---|---|
| Uploader | Work, Ingest |
| Reviewer | Work |
| Approver | Work |
| Admin | Work, Ingest, Administration |

The casefile is contextual content and is not a persistent primary navigation item. The header includes a skip link whose first target is the page's dominant work region. Marketing copy, policy summaries, and session details do not repeat below the app header.

An admin action mode does not change primary navigation or account identity. A persistent casefile banner states `Admin action mode: Reviewer` or `Admin action mode: Approver`, identifies the admin, shows the required reason and expiry, and provides `Exit action mode`.

### 4.3 Work inbox views

All roles use the same ledger framework with role-specific tabs and row content.

| Role | Tabs and ordering |
|---|---|
| Uploader | `My uploads`, `Needs attention`, `Processing`, `Ready`. Rows are limited to recordings created by the signed-in user and sort newest first. |
| Reviewer | `To review`, `Waiting`, `Completed`. `To review` shows active assignments with a current draft, with changes-requested drafts first and then oldest updated. `Waiting` shows active assignments still processing or pending approval. `Completed` shows assignments completed by approval, newest completion first. |
| Approver | `To decide`, `Waiting`, `Completed`. `To decide` shows active assignments with a pending revision, oldest submission first. `Waiting` shows active assignments not yet pending. `Completed` shows assignments completed by approval, newest completion first. |
| Admin | `All`, `Needs attention`, `Review`, `Approval`, `Approved`. Attention sorts by severity and age; other views sort newest update first except Approval, which sorts oldest submission first. |

The next-action area appears only when at least one role-valid actionable row exists. It points to the first row under the ordering above. It never falls back to a waiting, completed, approved, or merely visible recording.

The ledger supports server-backed title or recording-ID search, state filtering, assignment filtering for admins, source filtering, and sort order in URL search parameters. The default view requires no query parameters. A filter update replaces the URL, preserves keyboard focus on the changed control, and announces the new result count.

Desktop columns are Title, State, Revision, Assignment, Updated, and Next action. Uploader rows replace Assignment and Revision with Source and Progress. At narrow widths the same data becomes a semantic list with labeled values rather than a horizontally scrolling table.

## 5. Governing domain model

### 5.1 Distinct state dimensions

The UI must not collapse all progress into one uncontrolled status string. It derives a display stage from these authoritative dimensions:

1. **Integrity state:** capturing, uploading, verifying, verified, verification failed, or interrupted
2. **Transcript job state:** queued, running, partial result, completed, failed, or cancelled
3. **Current revision state:** draft, pending approval, or no active current revision
4. **Active approved pointer:** the revision currently approved for export, or none
5. **Assignment state:** active, completed, or removed for each reviewer and approver activation

Historical revision terminal states are `superseded`, `withdrawn`, and `changes_requested`; `approved` remains on an approved revision even after reopen. The recording's `approvedRevisionId` determines whether that approved revision is the active approved record.

The derived casefile stages are evaluated in this order:

1. `Needs ingest attention` for interrupted, verification-failed, failed, or cancelled work
2. `Verifying` while integrity is verifying
3. `Transcribing` while the job is queued, running, or partial
4. `Pending approval` when `pendingRevisionId` is present
5. `Approved` when `approvedRevisionId` is present and the current revision is that revision
6. `Changes requested` when the active draft is based on a revision whose latest decision is changes requested
7. `Reopened` when the active draft is based on an approved revision whose latest decision is reopened
8. `Draft review` for every other active draft

A withdrawn revision produces a new draft with a visible `Withdrawn submission` origin notice but uses the `Draft review` work stage.

### 5.2 Revision and decision transitions

All commands use an expected revision identifier and execute in one database transaction. The first valid transition wins. A second racing command receives a typed conflict and cannot overwrite the winner.

| Command | Preconditions | Atomic result |
|---|---|---|
| Save draft | Current revision is draft; actor has review authority; expected current ID matches; at least one segment remains when the loaded draft had segments | Mark prior draft `superseded`; create the next numbered draft with complete segment content and summary; move `currentRevisionId`; append `revision.saved` audit event |
| Submit revision | Current revision is draft; actor has review authority; expected current ID matches | Save unsaved content first when present; mark resulting draft `pending_approval`; set `submittedAt` and `submittedByUserId`; set `pendingRevisionId`; append pending decision and `revision.submitted` audit event |
| Withdraw submission | Current revision is pending; actor is the same user recorded in `submittedByUserId`; no approver decision exists; expected pending ID matches; reason is 10 to 500 trimmed characters | Mark pending revision `withdrawn`; append withdrawn decision with reason; clear `pendingRevisionId`; clone its content into the next draft based on the withdrawn revision; set `currentRevisionId`; append `revision.withdrawn` audit event |
| Request changes | Current revision is pending; actor has approver authority; actor is not `submittedByUserId`; expected pending ID matches; reason is 10 to 500 trimmed characters | Mark pending revision `changes_requested`; append changes-requested decision with reason; clear `pendingRevisionId`; clone its content into the next draft based on the returned revision; set `currentRevisionId`; append `approval.changes_requested` audit event |
| Approve | Current revision is pending; actor has approver authority; actor is not `submittedByUserId`; expected pending ID matches | Mark revision `approved`; set approval time and `approvedRevisionId`; clear `pendingRevisionId`; append approved decision and audit event; complete every active reviewer and approver assignment for the recording against the approved revision; append one `assignment.completed` event for each completed assignment |
| Reopen | Recording has an active approved revision; actor has reopen authority; expected approved ID matches; reason is 10 to 500 trimmed characters | Keep the old revision historically approved; append reopened decision with reason; clear `approvedRevisionId`; clone the approved content into the next draft; set `currentRevisionId`; append `approval.reopened` audit event; do not reactivate completed assignments |
| Export | Recording has an active approved revision; policy, access grant, role, device support, and admin action mode permit export | Build the selected format from the approved revision; append `export.issued` audit event with format and revision before returning a no-store response; do not change workflow state |

Submission, withdrawal, request changes, approval, and reopen never mutate transcript text on the submitted or approved revision. Transition-created drafts preserve the prior summary and segments and point to the source revision through `basedOnRevisionId`.

The new workflow never writes the legacy approval state `rejected`. Existing rejected records display as `Changes requested (legacy)` and remain in history.

### 5.3 Assignment semantics

Each assignment activation is an append-only record with:

- recording, user, and assignment role snapshot
- assigning admin identity
- assigned UTC time
- active, completed, or removed status
- ended UTC time when no longer active
- ending reason
- completion revision when completed by approval

A user can have at most one active assignment for the same recording and role. Attempting the same active assignment returns an idempotent `Already assigned` result. Reassigning a user after completion creates a new row; it never reactivates or overwrites the prior row.

Assignment behavior is exact:

- Submission, withdrawal, and request changes leave reviewer and approver assignments active. State-aware inbox filters remove waiting work from the actionable tab without pretending the assignment ended.
- Approval completes all active reviewer and approver assignments in the same transaction as approval. Each receives ending reason `approved_revision` and the approved revision ID.
- Assignment creation appends `assignment.created` with the assignment and assigning admin identities.
- Manual admin removal sets status `removed`, ending reason `removed_by_admin`, and the removal time. It revokes the user's current and historical casefile access from that assignment and appends `assignment.removed`.
- Reopen does not reactivate prior assignments. The reopened draft remains unassigned until an admin creates new assignments.
- Completed assignments remain visible to the assigned user in the Completed tab and to admins in assignment history.
- A completed assignment grants read-only access to the approved revision snapshot recorded on that assignment. It does not grant visibility into a later reopened cycle.
- A completed approver assignment for the currently active approved revision grants desktop reopen and policy-gated export authority. A completed reviewer assignment grants export only under the `reviewable-approved-export` policy.
- The assignment timeline shows assigned user, role snapshot, assigning admin, start time, end time, ending reason, and completion revision. All times display in UTC.

Approval can therefore clear the active work promise without erasing provenance or making approved export impossible for the people who completed the record.

### 5.4 Identity and separation of duties

Every new revision submission stores `submittedByUserId`. Approval and request changes are forbidden when the acting user is that same person, including an admin switching from reviewer to approver action mode. The UI suppresses the decision controls and explains `A different person must decide this submitted revision`; the server independently rejects the command.

For legacy pending revisions without a submitting user identity:

- Reviewer withdrawal is unavailable because the server cannot prove submitter identity.
- An authorized approver can approve or request changes.
- The decision audit metadata includes `legacySubmitterIdentityMissing: true`.

### 5.5 Admin oversight and action mode

Admin base access is oversight, not implicit reviewer or approver authority.

In oversight mode an admin can:

- view every inbox row and current casefile
- play media when workspace policy permits
- inspect transcript, policy, provenance, assignments, revision history, decisions, and audit events
- ingest media
- create local accounts
- create and remove assignments

In oversight mode an admin cannot edit, save, submit, withdraw, approve, request changes, reopen, or export.

To perform governed casefile work, an admin selects `Enter reviewer action mode` or `Enter approver action mode` from the casefile header. Entry opens a confirmation dialog that:

1. names the recording and effective role;
2. lists the actions the current state will enable;
3. requires a 10 to 500 character purpose;
4. states that all actions remain attributed to the admin;
5. uses the final button `Enter reviewer mode` or `Enter approver mode`.

The server creates an `admin_action_sessions` row bound to the admin user, recording, effective role, purpose, and a fixed expiry 30 minutes after entry. It appends `admin.action_mode.entered`. Only one active action session per admin and recording is valid; entering another ends the previous session as `switched`.

Every governed command validates the action-session ID, signed-in admin, recording, effective role, ended state, and expiry. An expired session is ended lazily, records `admin.action_mode.expired`, removes action controls, and preserves unsaved in-memory edits. Explicit exit records `admin.action_mode.exited`.

The casefile header, sticky action bar, dialogs, and audit attribution all show the effective role. Audit entries read in this form:

`Morgan Lee (Admin), acting as Approver, approved revision v4.`

Admin action mode never creates a reviewer or approver assignment and never impersonates an assigned user. Approval in approver mode still completes all real active reviewer and approver assignments. Admin ingest and administration remain native admin actions and do not require an action mode.

Action-mode choices are state-specific:

- Draft: reviewer mode
- Pending: approver mode, plus reviewer mode only when this admin submitted the pending revision and can withdraw it
- Approved: approver mode
- Processing or failed ingest: no reviewer or approver mode

The pending approver option is unavailable when the admin submitted that revision.

## 6. Access and permission model

### 6.1 Access grants

The server computes a casefile access grant before policy capabilities:

| Principal relationship | Access grant |
|---|---|
| Uploader who created the recording | Status, ingest progress, and non-transcript metadata only |
| Active reviewer or approver assignment | Current casefile transcript and policy-permitted media |
| Assignment completed by approval | Approved snapshot named by the assignment; no later cycle |
| Removed assignment | No access from that assignment |
| Admin oversight | Every current casefile, read-only |
| No relationship | No row and no direct-route access |

New recordings store `uploadedByUserId`; role alone never grants uploader visibility. An admin still sees all recordings.

### 6.2 Desktop and tablet action matrix

`Read` below means transcript and metadata. `Media` remains subject to the active policy profile. `Export` remains subject to the active export policy. All reviewer and approver commands also require the access grant and state preconditions above.

| Revision stage | Uploader owner | Active reviewer | Active approver | Completed reviewer snapshot | Completed approver snapshot | Admin oversight | Admin reviewer mode | Admin approver mode |
|---|---|---|---|---|---|---|---|---|
| Processing or ingest error | Status only; own resumable ingest actions | Status only | Status only | No current-cycle access | No current-cycle access | Read status | Not offered | Not offered |
| Draft, including returned or reopened | Status only | Read, Media, Edit, Save, Submit | Read, Media | Prior approved snapshot only | Prior approved snapshot only | Read, Media | Read, Media, Edit, Save, Submit | Not offered |
| Pending approval | Status only | Read, Media; submitting user can Withdraw | Read, Media, Approve, Request changes | Prior approved snapshot only | Prior approved snapshot only | Read, Media | Withdraw only when this admin submitted | Read, Media, Approve, Request changes |
| Active approved revision | Status only | Reviewer assignment unavailable | A post-approval active assignment can Read, use Media, Export, and Reopen | Read snapshot, Media, policy-gated Export | Read snapshot, Media, Export, Reopen | Read, Media | Not offered | Read, Media, Export, Reopen |
| Historical non-approved revision | Status only | Visible inside authorized casefile history, not directly actionable | Same | Only when part of assigned approved snapshot history | Same | Read | No actions | No actions |

An approver does not edit transcript text. A reviewer does not make approval decisions. An admin uses exactly one effective role at a time.

### 6.3 Policy overlay

Role and state authority are necessary but not sufficient. Workspace policy can remove Media and Export capabilities. Raw media download is always false. The strict profile allows approved export to approvers and admins acting as approver. The reviewable-approved-export profile additionally allows completed reviewers to export their currently active approved snapshot.

The UI receives a server-derived capability object and does not reconstruct governed permissions from role strings. The server recomputes every capability on every command.

### 6.4 Phone support overlay

Phone safety mode applies when either condition is true:

- viewport width is below 768 CSS px; or
- the primary pointer is coarse and viewport height is below 768 CSS px, which covers landscape phones.

Phone safety mode permits:

- first-run setup and authentication
- logout and in-page session recovery
- role worklist, filters, status, assignment labels, and read-only casefile content authorized above
- policy-permitted media playback
- file upload, resume, restart, and supported browser audio recording

Phone safety mode removes and client-guards every other mutation, including transcript edit/save/submit, withdrawal, approval, request changes, reopen, export, account creation, assignment changes, and admin action-mode entry. The casefile states `Review and decisions require a tablet or desktop. Your access and place in the record are unchanged.` Administration is inspect-only on a phone.

Viewport classification is a supported-surface rule, not a substitute for role authorization. Server role, state, assignment, self-approval, policy, and admin-mode checks remain the security boundary. The client never renders or dispatches unsupported phone commands, and portrait plus landscape phone E2E tests enforce that contract.

## 7. Screen specifications

### 7.1 First-run setup

**Dominant job:** establish a safe first administrator.

When no users exist, `/` renders a setup page rather than the login page. Desktop uses a two-column layout with the form first in DOM order and on the left; a restrained trust and readiness aside sits on the right. Phone uses one column with the form before the aside.

The page contains:

- Superscriber identity
- `Set up this appliance` heading
- readiness list for database write access, media and upload storage write access, auth-secret availability, and engine configuration
- fields for administrator name, email, password, and password confirmation
- one `Create administrator` primary button

Database, storage, and auth-secret failures are blocking. Engine worker availability is informational because the worker can start after setup; invalid engine configuration is blocking. Readiness output never reveals paths, secrets, hashes, or environment values. `Retry checks` reruns readiness without clearing valid form fields.

Validation requirements remain the repository's auth-validation source of truth. On invalid submit, an error summary receives programmatic focus, links to each invalid field, and the first invalid field receives focus when the user activates its link. Password fields clear after a failed server submit; name and email remain. A double-submit is disabled while pending.

Successful creation redirects to steady-state login with `First administrator created. Sign in to continue.` The login heading receives focus and the email field is prefilled with the new admin email but contains no password.

A concurrent bootstrap attempt that loses the race returns `Setup was completed in another session. Sign in with an existing account.` and changes the page to login without creating a second admin.

### 7.2 Login, logout, and session recovery

**Dominant job:** enter or safely resume the governed workspace.

Steady-state `/` is a compact login surface. Desktop shows a short trust aside after the form; phone shows it in a collapsed `About this appliance` disclosure. User-facing copy contains no migration or implementation commentary.

The form has Email, Password, and Sign in. Wrong credentials mark both fields invalid, place focus on Password, and announce `Email or password was not accepted. Check both fields and try again.` A service error uses `Sign-in is temporarily unavailable. Your password was not saved. Try again.` and focuses the error summary.

Protected-route redirects include a server-sanitized relative `returnTo` value. After login, the user returns to that authorized route; invalid, external, or unauthorized targets resolve to `/workspace`.

Session expiry has two paths:

- A navigation with no unsaved work redirects to login with `Session expired. Sign in again to continue.` and the sanitized return route.
- An in-place casefile command with unsaved work returns `AUTH_EXPIRED` without navigation. A modal login form reauthenticates in place so transcript text remains only in memory. After success, the modal closes, focus returns to the invoking action, and the user explicitly retries the command. The app never automatically resubmits a governed decision.

Before unload or internal navigation with unsaved transcript changes triggers a confirmation. Hard refresh can still discard in-memory edits, and the warning states that plainly. Transcript content is never written to local storage, session storage, a query string, or an analytics event.

Successful logout clears the session, returns to login, focuses the heading, and announces `Your session ended safely.`

### 7.3 Work inbox

**Dominant job:** open the next valid item or understand that no action is due.

Below the app header, the page contains:

1. role heading and one-sentence responsibility
2. optional `Next action` strip with title, state, age, and primary `Open casefile`
3. status tabs with counts
4. search, filters, and sort
5. one ledger

There are no marketing hero, metric-card grid, repeated policy panel, six simultaneous queue cards, or implementation-scope notes.

Each state badge combines text with an icon or shape. Row links use the recording title as the accessible name. Assignment chips name the role and person rather than showing unlabeled initials. Dates use `01 Aug 2026, 14:32 UTC` format and provide the full ISO UTC value in accessible description text.

Empty behavior is role-specific:

- Reviewer: `No transcript review is assigned to you.`
- Approver: `No approval decision is waiting for you.`
- Uploader: `No uploads yet.` with `Start an upload`.
- Admin: `No recordings match these filters.` with `Clear filters` when filtered, or `Start an upload` when the workspace has none.

The Completed tab is not included in next-action counts. Removed assignments never appear to the removed user.

### 7.4 Ingest

**Dominant job:** safely deliver one recording into the governed pipeline.

`/ingest` uses a focused progressive surface with three labeled stages on one route:

1. **Source:** Upload file or Record audio
2. **Details:** required title from 1 to 120 trimmed characters, required language hint, and source file or recorded clip
3. **Transfer:** byte progress, resumability, verification handoff, and recovery action

The selected source is a keyboard-operable radio group styled as a segmented control, not ARIA tabs. File upload accepts browser-reported audio and video files. Browser recording is shown only when `getUserMedia` and `MediaRecorder` exist; it captures audio, provides Stop, playback preview, Replace recording, and the generated filename. Microphone denial replaces recording controls with `Microphone access was not granted. Allow access in your browser or upload a file instead.` and focuses the notice.

The primary action is `Upload recording`. During transfer it changes to a non-interactive progress label. Progress uses a native or correctly labeled progress element with current bytes, total bytes, and percent. Live announcements occur at start, every 10 percent boundary, interruption, finalization, and completion, not on every chunk.

The existing 1 MiB chunk protocol and 24-hour abandoned-session cleanup remain. Local storage contains only session ID and file identity metadata. On return:

- `Resume upload` asks the user to select the same file and states the committed byte offset.
- `Finalize upload` appears when all bytes are present but verification was not started.
- `Start again` appears when the session expired, the temporary file is missing, or byte verification failed.

Only the user who created an upload session can resume, append, or finalize its bytes. Admin oversight can inspect any session status but cannot append or finalize another user's file. Starting again creates a new session and leaves the prior failed or expired event in audit history.

Completion routes admin to the new casefile and uploader to Work. The durable success message is `Upload received. Verification has started.` Dispatch failure says `Upload is stored safely, but transcription could not start. An administrator can retry the backend.` It never asks the user to upload the same bytes after durable finalization.

Phone file upload and supported audio recording use the same flow. No new file-size limit is introduced by this redesign; existing server and storage failures remain explicit.

### 7.5 Casefile review

**Dominant job:** inspect or correct the current transcript under the record's governing state.

A recording owner with uploader-only access receives a status casefile containing ingest progress, safe recording metadata, and recovery guidance but no transcript, media, decisions, or audit content. Every transcript-capable casefile begins directly below the app header.

#### Sticky case header

A restrained header remains sticky below the app shell and contains:

- Back to Work
- recording title
- derived workflow state
- current revision number and short identifier
- active assignment summary or historical snapshot label
- unsaved-state indicator when editing
- admin oversight or action-mode control when applicable

Integrity and job details move to Governance. The header does not repeat the workspace name, policy paragraph, source card, language card, job card, or large hero treatment.

#### Primary work area

At 1100 px and above, the governance drawer defaults collapsed to a narrow labeled rail so the transcript expands into the available width. When opened, the layout is approximately 70 percent transcript and 30 percent governance. The drawer remembers its open tab only in component memory. At 768 to 1099 px, transcript is one column and Governance opens as a modal side drawer. Below 768 px, read-only transcript remains one column and governance sections use compact accordions.

A sticky `MediaTransport` sits immediately above the transcript. It uses the browser's accessible audio or video controls, a current time display, jump-back 10 seconds, playback rate, and current segment label. It has no decorative waveform or fake transport status. If playback is denied or media is missing, one clear explanation replaces the control region.

#### Transcript editor

Desktop transcript rows use:

- 96 px tabular timestamp gutter with a `Play from` button
- 128 px speaker field
- flexible transcript text
- confidence as subordinate text, announced as a percentage

The active playback row receives a subtle mint background, left marker, and programmatic `aria-current="true"`. Color is not the only indicator. At 768 to 1099 px, time and speaker share a metadata row above text. In phone mode, time and speaker are text and the transcript is never rendered in form controls.

A revision summary field sits above segments only in editable draft mode. Pending and approved summaries render as text. Empty transcript processing state replaces the editor with job progress and does not render disabled blank fields.

#### State action bar

A sticky bottom `StateActionBar` displays only valid commands:

- Editable draft: Save draft and Submit for approval
- Pending submitting reviewer: Withdraw submission
- Pending approver: Request changes and Approve revision
- Active approved approver: Export approved and Reopen casefile
- Oversight, waiting, processing, unsupported phone, or historical snapshot: no governed command

The bar reserves page padding so it never obscures the last transcript row. Save is enabled only when content changed. Submit saves changed content and submits in one command. Success updates the view model without a top-of-page redirect. Save keeps focus in the edited field and announces the new revision. Submit, withdrawal, request changes, approval, and reopen move focus to the case header's updated state.

### 7.6 Reviewer withdrawal

Withdrawal is available only on a pending revision to the same signed-in user who submitted it, or to that same admin while in reviewer action mode. It disappears as soon as an approver decision wins.

`Withdraw submission` opens a modal containing:

- revision number and submitted UTC time
- `This removes the revision from approval and creates a new editable draft. The withdrawal remains in audit history.`
- required `Reason for withdrawal` textarea, 10 to 500 trimmed characters, with count
- Cancel
- final `Withdraw revision` button using danger styling

The button remains disabled until the reason is valid. Confirming sends the expected pending revision ID. Success closes the modal, renders the new editable draft, focuses the `Draft review` state, and announces `Revision vN was withdrawn. Draft vN+1 is ready for review.`

If an approver acted first, the modal closes, local state refreshes, and the conflict notice announces either approval or changes requested. The attempted reason is not written as an audit event because no withdrawal occurred.

### 7.7 Approval, request changes, and reopen

#### Approve

`Approve revision` opens a confirmation showing revision ID, submitter, submission time, segment count, and optional approval note up to 500 characters. It states that approval locks the revision and completes active reviewer and approver assignments. The final button is `Approve and complete work`.

Success renders the locked approved revision, completes assignments atomically, removes the item from actionable inbox counts, and announces `Revision vN approved. Active review and approval assignments were completed.`

#### Request changes

`Request changes` opens a dialog with a required 10 to 500 character reason and states that the submitted revision becomes historical while a new draft is created. The final button is `Request changes`.

Success renders the cloned draft as read-only for the approver, keeps existing assignments active, focuses the `Changes requested` state, and announces `Changes requested on revision vN. Draft vN+1 is ready for the assigned reviewer.` When no active reviewer remains because an admin removed assignments, the success notice adds `No reviewer is currently assigned.`

#### Reopen

`Reopen casefile` is available to an approver with a completed or active grant for the currently approved revision and to an admin in approver action mode. It requires a 10 to 500 character reason. The dialog states:

- approved export becomes unavailable immediately;
- the approved revision remains in history;
- a new draft is created;
- completed assignments are not restored.

The final button is `Reopen as draft`. Success renders the actor's permitted result: admin oversight sees the new current draft, while a non-admin completed approver returns to Work with `Casefile reopened. An administrator must assign the new review cycle.`

### 7.8 Approved export

Export is anchored to the approved casefile action bar and has no separate route. It is absent for draft, pending, reopened, unauthorized, or phone surfaces.

`Export approved` opens a portal-rendered viewport modal on desktop and a bounded bottom sheet on compact tablet layouts. It contains:

- recording title
- approved revision ID and version
- approving person and approval UTC time, or `Legacy approval, user identity unavailable`
- grouped formats: Document (`DOCX`, `TXT`), Captions (`SRT`, `VTT`), Structured data (`CSV`, `TSV`, `JSON`)
- a short format description
- Close

The surface is `position: fixed`, centered on desktop, uses `max-height: calc(100dvh - 32px)`, scrolls internally, locks body scroll, and makes the rest of the application inert. Focus enters on Close, wraps within the dialog, closes on Escape, and returns to `Export approved`.

Selecting a format begins one audited GET request. The modal remains until the response starts successfully, then closes and announces `Approved revision vN exported as FORMAT.` A 401 opens session recovery. A 403 or 409 keeps the modal open and explains the changed policy or state. Network failure keeps focus on the selected format and offers `Try again`; it never reports success based only on click.

The response uses `Cache-Control: no-store`, attachment disposition, a safe filename, and bytes generated only from the active approved revision. Each successful request records actor user, base role, effective role, action-mode ID when present, recording, revision, format, and UTC time.

### 7.9 Administration

**Dominant job:** manage the selected institutional control surface without mixing it into Work.

The desktop Administration page has secondary navigation for Accounts, Assignments, and Policy. The selected section is an `h1`, and only that section's task appears.

#### Accounts

Accounts uses a searchable table with Name, Email, Role, Active assignments, and Created. `Create account` opens a drawer with name, email, role, and password. Validation and focus behavior match first-run setup. Successful creation closes the drawer, focuses the new row, and announces the durable account and role. Existing account role changes, deactivation, and password management are outside this scope and are not rendered as inactive controls.

#### Assignments

Assignments defaults to Active and has a History tab. The active ledger shows recording, current stage, assigned person, assignment role, assigned by, assigned time, and current actionability. `Assign work` opens a drawer with searchable recording and user controls. Users are filtered to reviewer or approver accounts, and the selected recording explains whether the assignment is actionable now or waiting for a compatible state.

Reviewer assignment is unavailable for an active approved recording. Approver assignment is allowed on an approved recording and is labeled `Reopen authority`. Processing records can receive reviewer or approver assignments in a waiting state. Failed or interrupted ingest records cannot receive a review assignment until ingest recovers.

`Remove assignment` requires confirmation naming user and recording and states that current access is revoked while history remains. It records removed status rather than deleting the row.

History shows completed and removed assignments with ending reason, end time, and completion revision. Filters include recording, user, role, status, and UTC date range.

#### Policy

Policy is read-only. It identifies the active profile and shows the permission matrix for playback, raw download, draft edit, submit, withdrawal, approval, request changes, reopen, and approved export. It also states that phone safety mode removes governed mutations and export. There are no Save controls.

On a phone all Administration sections are read-only. Create account, assign, and remove controls are absent, and a notice states that administration changes require a tablet or desktop.

## 8. Shared states and recovery

### 8.1 Loading

Every route has a layout-matched skeleton through Next.js loading boundaries. Skeletons preserve final geometry, use no pulsing motion under reduced-motion preference, expose one `Loading <surface>` polite status, and are removed atomically when content arrives. Buttons never appear enabled while capability data is unresolved.

The casefile processing state uses real job progress from the status endpoint. Polling remains every three seconds only while verification or transcript generation is active, stops on terminal state, and announces only stage changes or each 10 percent boundary.

### 8.2 Empty

Empty states occupy the ledger or transcript region rather than adding cards. Each contains one reason and at most one valid action. Filtered emptiness offers Clear filters. Unassigned role inboxes explain that an admin must assign work. A missing transcript during active processing shows progress; a completed job with no revision is an error, not an empty state.

### 8.3 Errors

Errors use stable codes and procedural messages:

| Code | UI behavior |
|---|---|
| `AUTH_EXPIRED` | In-page recovery when unsaved content exists; otherwise login with return route |
| `ACCESS_DENIED` | Return to Work with `This casefile is not available to your account.` |
| `NOT_FOUND` | Casefile not-found page with Back to Work |
| `VALIDATION_ERROR` | Field summary and first invalid field |
| `POLICY_DENIED` | Inline notice naming the policy capability that changed |
| `ACTION_MODE_REQUIRED` | Admin oversight notice with state-valid entry action |
| `ACTION_MODE_EXPIRED` | Remove action controls, preserve edits in memory, offer entry into a new mode |
| `SELF_APPROVAL_FORBIDDEN` | Decision controls remain absent; explain separation of duties |
| `STALE_REVISION` | Preserve local draft in memory and show conflict recovery |
| `STATE_CHANGED` | Refresh authoritative state and announce the winning transition |
| `INGEST_RESTART_REQUIRED` | Preserve title and language; require same file selection or start again |
| `SERVER_ERROR` | Keep current data visible, do not claim success, and provide one retry |

Unknown errors never expose stack traces, SQL, file paths, adapter names, environment values, or raw exception text to users. When the server returns a correlation ID, the error detail displays it and the server log records it.

### 8.4 Conflict behavior

Draft save or submit conflicts do not overwrite local fields or auto-reload. A conflict panel states the loaded and current revision IDs and the current update time. `Open latest in a new tab` lets the reviewer compare while preserving this tab's in-memory text. `Discard my changes and load latest` requires confirmation. No automatic merge is attempted.

Decision conflicts close their dialog and refresh the state because pending or approved content is immutable. The notice names the transition that already occurred. Assignment conflicts refresh the row and state whether it is already active, completed, or removed.

## 9. Component boundaries and reuse

### 9.1 Component structure

Server route components load authoritative view models. Client components are limited to forms, dialogs, drawers, filters that update the URL, media synchronization, transcript editing, upload transfer, and phone-safety detection.

| Boundary | Responsibility | Important inputs and outputs |
|---|---|---|
| `AppShell` | Authenticated header, skip link, role navigation, account menu | Principal and allowed destinations |
| `AuthSurface` | Shared first-run and login frame | Heading, form, trust aside, notice |
| `ErrorSummary` and `InlineNotice` | Accessible errors and durable success feedback | Stable code, message, field links, live-region priority |
| `WorkInbox` | Tabs, next action, filters, and result count | Server-built `WorkInboxViewModel` |
| `RecordingLedger` | Desktop table and narrow semantic list | Rows with explicit labels and one row action |
| `IngestFlow` | Source, metadata, capture, chunks, resume, finalization | Existing ingest APIs plus owner-aware status |
| `CaseHeader` | Title, state, revision, assignment, unsaved state, admin mode | `CasefileViewModel` and editor dirty state |
| `MediaTransport` | Playback, seek, rate, current segment | Media URL and segment timing; no workflow mutation |
| `TranscriptDocument` | Read-only or editable aligned segments | Revision, editing capability, change callback |
| `StateActionBar` | State-valid actions and save status | Server-derived capabilities and expected IDs |
| `GovernanceDrawer` | Policy, provenance, assignment, revisions, decisions, audit | Read-only casefile context |
| `DecisionDialog` | Submit, withdraw, approve, request changes, reopen confirmations | Typed command, validation, expected revision |
| `AdminActionModeBanner` | Enter, show, expire, and exit admin effective role | Admin action-session view model |
| `ExportDialog` | Format choice, accessible modal behavior, audited download | Approved revision metadata and export capability |
| `AdminSection` | Accounts, assignments, or policy task | Selected section and server view model |
| `PageSkeleton`, `EmptyState`, `ConflictPanel` | Shared non-happy states | Surface-specific copy and valid recovery action |

New page components must not reproduce permission logic. `CasefileViewModel.capabilities` and command handlers are the only sources for governed action availability.

### 9.2 Reuse and replacement

Reuse these existing assets or behavior:

- `SuperscriberLogo` and `app/icon.svg`
- Auth.js local credentials and existing validation schemas
- resumable 1 MiB chunk upload, 24-hour cleanup, and browser recording mechanics
- server-side media range streaming
- complete-segment revision saves and stale-revision expected IDs
- orchestration polling concept
- approved export format generation and grouping
- SQLite optimistic state-version protection during transition to targeted commands

Split or replace these existing surfaces:

- Replace `SessionBar` with `AppShell`.
- Replace the current all-in-one `/workspace` with `WorkInbox`; move ingest and admin to dedicated routes.
- Split `IngestPanel` into source, details, transfer, and recovery units without changing the chunk size.
- Replace the monolithic `ReviewWorkspace` with the casefile components above.
- Remove review hero, summary-card grid, action rail, decorative waveform, prototype assist note, and always-expanded side panels.
- Replace shell-relative export positioning with a portal modal.
- Replace queue-card buckets with one ledger.
- Split `AdminControlPanel` into the three administration sections.
- Extend rather than duplicate existing export generators, auth services, access services, and workflow tests.

## 10. Visual system

### 10.1 Color tokens

| Token | Value | Use |
|---|---|---|
| `--color-bone` | `#F7F3EA` | App background |
| `--color-paper` | `#FFFCF6` | Primary work surface |
| `--color-ink` | `#172421` | Main text |
| `--color-teal-700` | `#163D38` | Primary buttons, header emphasis |
| `--color-rust-600` | `#A64B2A` | Eyebrows, high-salience accent, links |
| `--color-muted` | `#596762` | Secondary text that still passes contrast on paper |
| `--color-line` | `#D8D8CF` | Dividers and field borders |
| `--color-success-fg` | `#2F6B55` | Success text and icon |
| `--color-success-bg` | `#E4F0E9` | Success background |
| `--color-warning-fg` | `#8A5A14` | Warning text and icon |
| `--color-warning-bg` | `#FFF2D7` | Warning background |
| `--color-danger-fg` | `#8C332A` | Danger text and icon |
| `--color-danger-bg` | `#FBE7E4` | Danger background |
| `--color-info-fg` | `#315E72` | Informational text and icon |
| `--color-info-bg` | `#E5F0F4` | Informational background |
| `--color-focus` | `#0B6F64` | 2 px focus ring |

Primary buttons use teal with white text. Rust is not used as a normal-text button fill. Status always combines text with an icon or shape. Borders and spacing carry hierarchy before shadows.

### 10.2 Typography

The appliance bundles WOFF2 assets and their license files. It does not fetch fonts at runtime.

- UI and body: Public Sans, variable 400 to 700
- Display headings: Newsreader, variable 500 to 600
- IDs, timestamps, and audit metadata: IBM Plex Mono, 500

Type sizes are 12, 14, 16, 18, 24, 32, and 44 px. Body is 16 px at 1.55 line height. Dense ledger rows are 14 px at 1.4. The main casefile title uses 32 px desktop and 24 px narrow. No heading uses all caps; 12 px uppercase is reserved for short eyebrows.

### 10.3 Spacing, surfaces, and motion

- Spacing scale: 4, 8, 12, 16, 24, 32, 48 px
- Control radius: 8 px
- Surface radius: 12 px
- Large modal radius: 16 px
- Pills only for compact status, never for every button
- One elevation: `0 1px 2px rgba(23, 36, 33, 0.10)`
- App content max width: 1440 px
- Work and admin readable max width: 1200 px
- Casefile horizontal gutters: 24 px desktop, 16 px phone

Routine panels use paper, a 1 px border, and no blur or gradient. Motion is limited to 120 to 180 ms opacity or transform transitions. `prefers-reduced-motion: reduce` removes nonessential transitions and smooth scrolling.

## 11. Responsive behavior

| Width or device condition | Behavior |
|---|---|
| 1100 px and above | Full work ledger; open casefile layout is 70/30 transcript and governance; sticky case header, transport, and action bar |
| 960 to 1099 px | Full governed actions; transcript first in one column; governance side drawer; compact semantic work table |
| 768 to 959 px | Full governed actions; transcript first in one column; governance side drawer; semantic ledger list |
| Phone safety mode | Read-only casefile and administration; semantic ledger list; compact sticky transport; governance accordions; supported ingest; no governed action bar |

Phone safety mode takes precedence over width-only layout bands. At 390 x 844, the casefile must have 16 px gutters, no page-level horizontal scroll, and transcript content starting within 500 px. At desktop sizes, transcript content starts within 400 px. At 320 CSS px width, content reflows without loss of information or two-dimensional scrolling except the media timeline itself. Long titles wrap without covering state or navigation. Sticky regions must not overlap at 200 percent browser zoom.

## 12. Accessibility acceptance criteria

The redesign must satisfy WCAG 2.2 AA and these product-specific checks:

1. Normal text contrast is at least 4.5:1; large text and essential non-text UI are at least 3:1.
2. Every interactive target is at least 44 by 44 CSS px, including timestamp seek buttons and modal close controls.
3. A visible 2 px focus indicator has at least 3:1 contrast against adjacent colors and is never clipped by sticky containers.
4. Page landmarks are header, nav, main, and contextual aside. Heading order has one `h1` and no skipped structural level.
5. The skip link moves to the ledger, ingest form, transcript, or selected admin section.
6. Form labels remain visible. Error summaries use links to fields. Invalid fields use `aria-invalid` and error descriptions.
7. Wrong-password, session-expiry, save, transition, upload stage, result-count, and conflict messages are announced once at the appropriate polite or assertive level.
8. Status does not rely on color. Active playback uses text or `aria-current` plus a visual marker.
9. Work tables use real headers. Narrow layouts use lists with explicit data labels rather than CSS-reflowed table cells with lost semantics.
10. Transcript speaker and text controls have stable labels containing segment order or timestamp, not implementation IDs alone.
11. Keyboard users can play or seek media, edit every segment, save, submit, open context, and complete every supported dialog action without pointer gestures.
12. Dialogs and drawers are titled, described where needed, focus-contained, Escape-closeable unless a transfer is in an unsafe finalization step, and restore focus.
13. Opening a modal makes outside content inert and locks body scroll.
14. Sticky headers and action bars do not hide focused controls; `scroll-padding` and `scroll-margin` account for both.
15. Reduced-motion preference removes waveform-like animation, smooth scroll, skeleton pulse, and transform movement.
16. Text remains usable at 200 percent zoom and under browser text-only enlargement.
17. Media denial replaces controls with a reason. Native audio and video controls remain labeled by surrounding content.
18. Phone read-only copy is present in accessibility output before the transcript and states where full actions are supported.

## 13. Data flow and server contracts

### 13.1 Read models

Server components call principal-aware repository functions:

- `listWorkInbox(principal, filters)` returns role tabs, counts, a nullable next action, rows, and active filter values.
- `getCasefile(principal, recordingId, options)` returns the authorized current casefile or historical snapshot, assignment relationship, admin action session, decisions, audit, and server-derived capabilities.
- `listAdministration(principal, section, filters)` returns only the selected administration dataset.
- `getBootstrapReadiness()` returns named checks with `ready`, `warning`, or `blocked` and safe user copy.

`CasefileViewModel.capabilities` contains booleans for status, transcript, media, edit, save, submit, withdraw, approve, request changes, reopen, and export plus a machine-readable denial reason for each false governed capability. The server derives this object from principal, access grant, state, policy, self-approval, and admin action session.

### 13.2 Command context

Every mutation constructs actor context from the authenticated session and validated admin action session. Clients cannot submit a user ID, base role, or effective role as authoritative values.

```ts
type ActorContext = {
  userId: string;
  baseRole: UserRole;
  effectiveRole: UserRole;
  adminActionSessionId: string | null;
};
```

For non-admins, effective role equals base role. For admin oversight, effective role is admin. Reviewer and approver effective roles require a valid action session.

### 13.3 Typed action results

Casefile and administration commands return data rather than redirecting on ordinary success or domain failure.

```ts
type CommandResult<T> =
  | { ok: true; data: T; notice: string }
  | {
      ok: false;
      code: ErrorCode;
      message: string;
      fieldErrors?: Record<string, string>;
      latest?: CasefileConflictSnapshot;
      correlationId?: string;
    };
```

Required server actions are:

- `saveDraftAction`
- `submitRevisionAction`
- `withdrawRevisionAction`
- `approveRevisionAction`
- `requestChangesAction`
- `reopenRevisionAction`
- `startAdminActionModeAction`
- `endAdminActionModeAction`
- existing account and assignment actions changed to typed results where they render in drawers

Each casefile command includes recording ID and expected current, pending, or approved revision ID. Transcript commands include complete segments and summary. Reason and note lengths are validated on the server.

### 13.4 Existing HTTP APIs

The ingest endpoints remain, with these contract changes:

- Session creation records `createdByUserId`.
- Session lookup, chunk append, and finalize validate the session owner; admin can inspect but cannot append or finalize another user's bytes.
- JSON failures include stable `code`, safe `error`, and optional `fieldErrors`.
- Status includes the derived workflow stage and only safe display data.

`GET /api/recordings/[recordingId]/status` returns state changes for an authorized principal and adds `workflowStage`, `currentRevisionVersion`, and `updatedAt`. It does not return transcript content.

`GET /api/recordings/[recordingId]/transcript?format=<format>` continues to return approved exports. Admin requests also include a validated action-mode ID. The handler validates current approval and access, builds bytes, records `export.issued`, then responds. Failed builds do not record an issued export.

### 13.5 Persistence changes

The schema requires:

- `recordings.uploaded_by_user_id`
- `ingestion_sessions.created_by_user_id`
- revision states for superseded, withdrawn, and changes requested
- `revisions.created_by_user_id` and `revisions.submitted_by_user_id`
- approval-event actor user, base role, effective role, and admin action-session ID
- audit actor user, base role, effective role, admin action-session ID, and versioned metadata JSON
- assignment role snapshot, status, ended time, ending reason, completion revision, and removing actor
- new `admin_action_sessions` table with user, recording, effective role, purpose, start, expiry, end, and end reason
- indexes for active inbox assignment queries, pending submission order, completed assignment history, audit recording time, and active admin action sessions

The current unique recording-user assignment index must be replaced with a SQLite partial unique index on recording, user, and assignment role where status is active. The database constraint and transaction validation jointly enforce one active assignment while allowing append-only reassignment history.

Approval and other governed transitions move from whole-state rewrite behavior to targeted SQLite transactions. The transition transaction validates current pointers, writes revisions and decision events, updates recording pointers, updates assignments when required, appends audit, and increments the existing state version. Existing ingest and orchestration code remains on the snapshot adapter in this redesign, and stale snapshots must fail after a targeted transition instead of overwriting it.

### 13.6 Audit event shape

Every new governed audit event contains:

- event ID and event type
- workspace and optional recording
- actor user ID, actor display snapshot, and base role
- effective role
- optional admin action-session ID
- human-readable detail
- versioned structured metadata with revision IDs, assignment IDs, reason category, export format, or other event-specific values
- UTC timestamp

Reasons are stored as entered after trimming. They are rendered as text, never HTML. Existing role-only events remain readable and display `User identity unavailable for this legacy event.`

## 14. Error handling and operational safety

- Authorization and policy checks occur in the same transaction as workflow transitions.
- The server never trusts hidden form roles, assignment labels, revision state strings, or client capability booleans.
- Expected revision IDs prevent lost updates. Recording pointer checks prevent approval, withdrawal, request-changes, and reopen races.
- Decision and assignment updates are atomic. Approval cannot succeed while leaving active assignments behind.
- No governed command is automatically retried after an ambiguous network failure. The client refreshes state first and shows whether the command committed.
- Upload chunks remain safely resumable and can retry from the server-confirmed byte offset.
- Export is generated from the active approved pointer, never from a client-provided revision ID.
- User-facing errors use safe copy and correlation IDs. Detailed exceptions remain server-side.
- All mutable forms disable duplicate submission while pending but do not erase entered reasons on recoverable validation or network failure.
- Admin action-session expiry is checked at command time, not only when rendering the page.

## 15. Migration and backward compatibility

Introduce a transactional `schema_migrations` table and numbered, idempotent migrations before adding new behavior. Existing appliance databases must upgrade in place without deleting recordings, revisions, media paths, users, decisions, assignments, or audit events.

Migration behavior is exact:

1. Add nullable actor and ownership columns so legacy rows remain valid.
2. Treat existing `createdByRole` and audit `actorRole` as both base and effective role when the new effective role is null.
3. Add assignment status fields. Existing active rows become `active`; existing inactive rows become `removed` with end time from `updatedAt` and reason `legacy_removed`.
4. Drop the recording-user unique index and add non-unique history indexes.
5. For a recording already approved, complete any still-active reviewer or approver assignments with reason `legacy_approved_backfill`, the approved revision ID, and a system migration audit event.
6. When a recording has an approved pointer but its current revision is a different draft, treat it as a legacy reopen: clear the active approved pointer, retain the old approved revision in history, and append a system migration audit event.
7. Existing pending revisions have no provable submitting user. They remain approvable or returnable by an authorized approver but cannot be withdrawn.
8. Existing recordings and ingest sessions have null creator user IDs. They remain visible to admins and assigned users; they do not appear in an uploader's My uploads view based on role alone.
9. Existing `rejected` approval events render as legacy changes-requested history. New code never creates another rejected event.
10. Existing `/workspace` and `/recordings/[id]` links remain valid. No public route is removed.

Migration runs before normal repository access, records its schema version, and is covered against both a fresh database and a fixture representing the current production schema. A migration failure aborts startup with a safe operator error rather than partially serving the app.

## 16. Test strategy

### 16.1 Unit tests

Add table-driven tests for:

- every revision transition and invalid transition
- submitting-user withdrawal and rejection of another reviewer
- self-approval and self-request-changes denial, including admin role switching
- first-writer-wins approval versus withdrawal and approval versus request-changes races
- assignment completion on approval, history preservation, manual removal, duplicate active assignment, and reassignment as a new row
- reopened approved pointer clearing and no assignment reactivation
- capability derivation for every role, state, assignment relationship, policy profile, and admin action mode
- uploader ownership and status-only access
- next-action selection with no fallback to non-actionable records
- export policy and active-approved-pointer resolution
- reason length and safe audit metadata
- date formatting with explicit UTC

### 16.2 Persistence and integration tests

Use in-memory SQLite and a current-schema fixture to verify:

- fresh migrations and upgrade migrations are idempotent
- legacy active assignments on approved records are backfilled once
- targeted transition transactions increment state version and reject stale snapshot writes
- approval, decision, assignment completion, and audit are one atomic commit
- admin action sessions are record-bound, user-bound, role-bound, expiring, and non-reusable after exit
- ingest session ownership on lookup, append, and finalize
- `export.issued` occurs only after successful byte generation
- action results map domain errors to stable safe codes
- direct unassigned and removed-assignment access is denied
- completed-assignment snapshot access cannot reveal a later reopened draft

### 16.3 Component and accessibility tests

Test deterministic UI units for:

- action bar buttons from server capabilities
- readonly versus editable transcript rendering
- reason validation and count
- error-summary focus
- modal focus trap, inert background, Escape, scroll lock, and focus restoration
- filter count announcement
- progress announcement throttling
- phone-safety detection for portrait and landscape coarse-pointer conditions
- reduced-motion behavior

Use automated accessibility checks for auth, each inbox role, ingest, draft casefile, pending casefile, approved export modal, admin sections, error summary, and conflict panel. Automated checks supplement keyboard and screen-reader acceptance rather than replacing it.

### 16.4 End-to-end workflows

Playwright must cover:

1. readiness, first-admin creation, normal login, wrong password, logout, expired route recovery, and in-place reauthentication with unsaved text retained;
2. uploader desktop and phone upload, interrupted chunk resume, expired restart, microphone denial, and durable dispatch failure;
3. admin account creation, role-filtered assignment, manual removal, assignment history, and read-only policy;
4. reviewer edit, save without scroll reset, submit lock, deliberate withdrawal, resubmit, and another reviewer's withdrawal denial;
5. approver request changes with reason, reviewer returned draft, resubmission, and approval;
6. approval clearing all active reviewer and approver work while Completed history and snapshot access remain;
7. completed approver export and reopen, export removal after reopen, and explicit new-cycle assignment requirement;
8. admin oversight with no governed buttons, audited reviewer mode, audited approver mode, expiry, exit, and self-approval denial;
9. unauthorized direct route, removed assignment, historical snapshot, policy-denied export, and stale revision conflict;
10. responsive layouts at 320 x 800, 390 x 844, 844 x 390 coarse pointer, 768 x 1024, 1024 x 768, and 1440 x 1000;
11. phone absence of transcript mutation, decision, export, administration mutation, and admin-mode controls while read-only review, status, media, and supported upload remain;
12. export modal geometry, focus loop, inert background, body lock, all seven formats, audited success, and failed-response recovery.

E2E selectors use roles, labels, revision values returned by the app, and stable `data-testid` only where no user-facing semantic exists. They must not hardcode generated segment IDs such as `seg-1` or obsolete transcript text.

### 16.5 Validation commands

Implementation is not complete until all of these pass:

```bash
npm run typecheck
npm test
npm run build
npm run worker:check
npm run e2e
npm run e2e:container
```

The browser review also includes keyboard-only operation, 200 percent zoom, reduced motion, contrast measurement, long title and long transcript fixtures, and pixel inspection at the required viewports.

## 17. Phased implementation sequence

This sequence belongs to one implementation plan. Each phase must leave tests green and a coherent product slice.

1. **Workflow correctness and migrations**
   - Add numbered migrations, actor identity, revision terminal states, assignment history, admin action sessions, targeted transactions, withdrawal, request changes, assignment completion, and capability derivation.
   - Correct actionable-next selection, reopened approved pointers, and stale E2E selectors before visual replacement.

2. **Foundations and app shell**
   - Add bundled fonts and tokens, accessible primitives, skip link, `AppShell`, role navigation, loading/error boundaries, UTC formatting, and responsive layout foundations.

3. **Authentication and session recovery**
   - Implement readiness, form-first setup/login, focus and error summary behavior, sanitized return routes, safe logout, and in-page reauthentication.

4. **Work inbox and route separation**
   - Replace bucket cards and metrics with role tabs, next action, filters, and ledger. Move ingest and administration to their dedicated routes.

5. **Focused ingest**
   - Split the ingest flow, add owner checks, accessible progress, resume/restart states, and phone behavior while preserving the chunk protocol.

6. **Transcript-first casefile**
   - Build sticky case header, media transport, transcript document, governance drawer, state action bar, unsaved guard, in-place results, and conflict recovery.

7. **Governed decisions, admin mode, and export**
   - Add withdrawal, request-changes, approval, reopen dialogs, admin action mode, assignment completion feedback, historical snapshots, viewport-safe export, and export audit.

8. **Administration and hardening**
   - Build Accounts, Assignments, and Policy sections; complete accessibility, responsive, migration, unit, integration, E2E, container, and visual validation.

## 18. Acceptance criteria

The redesign is accepted only when every criterion below is demonstrably true.

### Product and navigation

- **AC-01:** Authenticated pages use one 64 px app header and only the role destinations defined in Section 4.2.
- **AC-02:** Work, Ingest, Administration, and Casefile each present one dominant job and no prototype, migration, adapter, or implementation-scope copy.
- **AC-03:** Reviewer and approver next action is null when no state-valid assigned item exists, even when waiting or completed recordings are visible.
- **AC-04:** Desktop casefile transcript begins within 400 px of the document top; 390 px phone transcript begins within 500 px.

### Workflow truth

- **AC-05:** Pending and approved revisions render no transcript form fields and reject save attempts server-side.
- **AC-06:** Only the submitting user can withdraw a still-pending revision, with a 10 to 500 character reason and expected revision ID.
- **AC-07:** Approval and request changes reject the submitting user, including the same admin switching effective roles.
- **AC-08:** Approval, request changes, withdrawal, and reopen produce exactly the transition and pointers defined in Section 5.2 under race tests.
- **AC-09:** Approval completes all active reviewer and approver assignments in the approval transaction and removes the record from both roles' actionable counts.
- **AC-10:** Completed assignment history remains visible and grants only its approved snapshot; removed history grants no user access.
- **AC-11:** Reopen clears active export, preserves the approved revision in history, creates a new draft, and restores no assignment.

### Admin governance

- **AC-12:** Admin oversight can inspect all records but cannot render or invoke reviewer, approver, or export commands.
- **AC-13:** Admin reviewer or approver work requires a valid record-bound 30-minute action session with a 10 to 500 character purpose.
- **AC-14:** Audit output identifies admin base identity, effective role, action session, recording, revision, detail, and UTC time for every action-mode event and governed command.
- **AC-15:** Exited, expired, wrong-record, wrong-user, and wrong-role action sessions are rejected server-side.

### Phone behavior

- **AC-16:** Portrait and landscape phone safety modes provide login, setup, work/status, authorized read-only casefile, policy-permitted playback, and supported upload.
- **AC-17:** Those phone modes render and dispatch none of transcript mutation, withdrawal, approval, request changes, reopen, export, account mutation, assignment mutation, or action-mode entry.
- **AC-18:** Phone pages have no horizontal scroll at 320 or 390 CSS px and keep all supported controls at least 44 by 44 px.

### Export and audit

- **AC-19:** Export appears only for the active approved revision under role, access, policy, device, and admin-mode rules.
- **AC-20:** Export modal or sheet stays fully inside the viewport, traps focus, makes outside content inert, locks body scroll, closes on Escape, and restores focus.
- **AC-21:** All seven formats download from the active approved revision with no-store headers and an audit event containing actor and format.
- **AC-22:** Reopened, stale, missing, unauthorized, and policy-denied export requests return safe errors and no `export.issued` audit event.

### Accessibility and resilience

- **AC-23:** The surfaces listed in Section 16.3 have no automated WCAG 2.2 AA violations and pass the manual keyboard, focus, zoom, contrast, and reduced-motion checks in Section 12.
- **AC-24:** Save preserves transcript scroll and field focus; each state-changing command focuses and announces the updated case state without a page-top redirect.
- **AC-25:** Session recovery preserves unsaved text in memory, never stores transcript content in browser persistence, and never automatically retries a governed decision.
- **AC-26:** Stale draft conflicts preserve local text, identify both revisions, and require explicit discard before loading latest.
- **AC-27:** Loading, empty, error, conflict, processing, and permission-denied states use the exact recovery model in Section 8.

### Compatibility and quality

- **AC-28:** A current-schema database upgrades in place with no loss of recordings, revisions, media references, users, assignments, decisions, or audit events.
- **AC-29:** Legacy approved active assignments and legacy reopened pointers are normalized once and receive system migration audit events.
- **AC-30:** Existing `/workspace` and casefile links remain valid, uploader visibility is based on new user ownership rather than role, and legacy null ownership does not leak records.
- **AC-31:** Typecheck, unit tests, production build, worker check, browser E2E, and container E2E all pass.
- **AC-32:** The shipped interface uses bundled fonts, the specified tokens, no decorative waveform, no repeated authenticated hero, no six-card queue board, and no shell-relative export sheet.

## 19. Requirement traceability

| Approved product decision | Resolved behavior |
|---|---|
| Governed Casefile direction with editorial and ledger strengths | Casefile is the record model; transcript rows use editorial alignment; Work uses one operational ledger. |
| Reviewer can withdraw before approver acts | Submitter-only pending withdrawal uses a required reason, immutable terminal revision, cloned draft, optimistic conflict guard, and audit event. |
| Approval clears active reviewer and approver work while preserving history | Approval transaction completes every active assignment; append-only rows and approved snapshot access remain. |
| Phones are read-only for review/status with supported upload and no approval, reopen, export, or transcript edit | Phone safety overlay defines all supported and prohibited behavior, including portrait and landscape tests. |
| Admin has oversight by default and enters explicit audited action mode | Oversight has no governed commands; record-bound reviewer or approver sessions require purpose, expire after 30 minutes, and preserve base plus effective attribution. |

This design contains no unresolved product choice. Implementation planning must preserve these behaviors rather than reopening them as defaults or optional variants.
