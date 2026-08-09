# Superscriber Recording Lifecycle Controls Design

**Date:** 2026-08-09

**Status:** Written-design review gate

**Scope:** Product-facing Pause and Resume controls for an active browser audio recording, in addition to the existing Stop, preview, and Upload recording flow

## 1. Product intent

Superscriber's browser-record source currently has only Start recording and Stop recording. An active recording that needs a short interruption can only stop and either keep or replace the finished take. This feature lets the current recorder deliberately suspend and then continue the same take, without changing the governed ingest boundary.

The approved interaction is:

`Record > Pause > Resume > Stop > preview > Upload recording`

This is a client-side capture-lifecycle refinement, not a backend recording service. Pause does not create a durable casefile, upload bytes for the unfinished take, alter transcription, or reserve server storage. Stop remains the single boundary at which CaptureAudio produces an in-memory `File`; Upload recording remains the single boundary at which a durable ingest session is created.

## 2. Current-state findings

### 2.1 Capture surface

- `/ingest` is limited to uploader and admin principals in `app/(authenticated)/ingest/page.tsx`.
- `SourceChoice` (`src/components/ingest/source-choice.tsx`) exposes the Record audio radio only after client support detection sees both `navigator.mediaDevices.getUserMedia` and `window.MediaRecorder`.
- `CaptureAudio` (`src/components/ingest/capture-audio.tsx`) has client states `idle`, `recording`, `ready`, `unsupported`, and `denied`.
- Start recording requests a microphone stream, constructs one `MediaRecorder`, accumulates `dataavailable` Blobs in a refs array, and marks the surface `recording`.
- Stop recording transitions the `MediaRecorder` to inactive; its stop handler creates the preview URL and generated `File`, then calls `onRecordingReady(file)`.
- A completed, not-yet-uploaded take can be replaced client-side. The approved design renames that control **Discard**.
- Microphone permission failure replaces capture controls with an assertive notice: "Microphone access was blocked. Choose Upload file to continue safely."
- `CaptureAudio` reports changes to `IngestFlow` only through `onRecordingReady` and `onRecordingCleared`; it does not expose capture state to the overall Transfer status card.

### 2.2 Durable ingest boundary

- The productive upload path begins only after a file exists and the user selects Upload recording or Upload file.
- `IngestFlow` validates title, language, and the selected file; only then it calls `POST /api/ingest/sessions`, writes non-content pending metadata in local storage, sends fixed 1 MiB chunks, finalizes, and routes to Work or the new casefile.
- `src/server/ingest/service.ts` creates `recordings.integrity_state = 'uploading'`, the paired `ingestion_sessions` row, a queued transcript job, a zero-byte temporary upload file, and durable creator ownership.
- A lost upload response reconciles from durable server status; a durable finalize never asks for the same bytes again.
- Existing browser-record resumability applies after Upload recording starts. It does not apply to an in-progress capture.

### 2.3 Workflow and status ownership

- `INTEGRITY_STATES` in `src/domain/models.ts` already contains `capturing`, but no current server writer transitions a browser capture into it before upload session creation. Paused browser capture must not reuse that label as a durable backend state.
- `deriveWorkflowStage` and `bucketRecording` classify `capturing`, `uploading`, `interrupted`, or failed ingest as `Needs ingest attention` or ingest status. Because no server row exists during local capture, pause must not enter these work surfaces by itself.
- A resulting successful upload follows the existing sequence: durable upload session -> verification -> queued transcription -> running or partial transcription -> completed job -> system draft -> governed review. Pause and Resume occur entirely before that sequence.
- The status-only uploader casefile and orchestration status poller remain responsible for post-upload progress. They must not poll while a user is merely paused before upload.

### 2.4 Persistence and safety contract

- `DESIGN.md` states the governing safe-interruption rule: transcript content has no browser persistence, and resumable upload persistence carries only non-content session metadata.
- Pause keeps microphone audio in local memory only. No partial audio, waveform, transcript, title, language, or capture bytes may be written to local storage, session storage, cookies, or the server. Upload recording first writes the already stopped, completed file's non-content identity metadata under the existing pending-upload contract.
- Reload, page navigation, source switching, tab replacement, browser crash, and microphone permission loss necessarily abandon the in-memory take. The interface must make abandonment clear instead of implying recoverability.
- The in-flight account-role worktree was inspected only to confirm scope. Its server changes are outside this task's tree and dependency surface; no semantic dependency was found or used.

## 3. Approved decision record

Two captain approvals govern this spec:

- `recording-lifecycle-design-question-1`: Pause and Resume are limited to the current browser tab. Preserve preview-then-upload and backend lifecycle. Do not add durable capture-time persistence, server-side partial-upload state, or recovery across reload, navigation, browser crash, or tab replacement.
- `recording-lifecycle-design-approval-1`: Rename the completed-take control to Discard. Use Start > Pause > Resume > Stop > preview > Upload on one `MediaRecorder` instance. Abandon in-memory audio clearly on reload, navigation, source switch, microphone denial, or tab replacement. No implementation or implementation plan is authorized by those approvals until this written spec is separately reviewed.

The durable decision files live in the firstmate task data directory and were read before writing this document.

## 4. Goals and non-goals

### 4.1 Goals

1. Let a user pause an active recording without ending it or discarding captured audio.
2. Let a user resume the same recording from the paused position inside the same tab.
3. Keep Stop as the deliberate capture-completion action that produces one preview and one upload-ready file.
4. Rename the current completed-take Replace recording control to Discard so its destructive but in-memory behavior is clear.
5. Preserve existing support detection, microphone denial behavior, preview, upload initiation, resumable upload, authorization, server lifecycle, audit, and transcription ownership.
6. Preserve keyboard operability, focus behavior, live-region announcements, phone-safe supported ingest, and 44 px interaction targets.
7. Give users truthful state language that distinguishes local capture progress from durable upload state.

### 4.2 Non-goals

- Durable paused recordings, server-side partial captures, or capture recovery after reload, navigation, browser crash, tab replacement, device sleep, or sign-out.
- Browser persistence of audio bytes or content-bearing recording metadata before Stop.
- Server schema, ingest API, workflow-stage, work-inbox, casefile, orchestration, audit, transcription worker, or media-storage changes.
- Capture-time casefile creation or status-only casefile views for a recording that has not uploaded.
- Multiple simultaneous local recordings across tabs or browser windows.
- Pause or resume after Upload recording has started; upload progress interruption and recovery are separately governed by the existing resumable upload flow.
- Recording video using this new control set. The existing Record audio source remains audio-only.
- Renaming Upload recording, changing source-choice behavior, or changing post-upload review actions.
- Any dependency on or merge coordination with the in-flight account-role feature.

## 5. Recommended architecture

Keep the change inside the existing client capture component boundary and its focused test fixtures.

### 5.1 CaptureAudio state machine

Extend the existing local capture state from:

`idle | recording | ready | unsupported | denied`

to:

`idle | recording | paused | ready | unsupported | denied`

No new state is needed for upload. Upload starts only after `ready` and is owned by `IngestFlow`.

Allowed capture transitions:

| From | Action | To | Result |
|---|---|---|---|
| `idle` | Start recording | `recording` | Requests microphone, constructs one recorder, resets refs, starts capture |
| `recording` | Pause recording | `paused` | Calls `MediaRecorder.pause()`; keeps stream, recorder, and accumulated chunks alive |
| `paused` | Resume recording | `recording` | Calls `MediaRecorder.resume()` on the same recorder |
| `recording` | Stop recording | `ready` | Calls `MediaRecorder.stop()`, stops tracks on stop event, previews one output file |
| `paused` | Stop recording | `ready` | Calls `MediaRecorder.stop()` on the same paused recorder, then completes capture |
| `ready` | Discard | `idle` | Revokes preview, clears the completed in-memory file, calls `onRecordingCleared`, restores Start recording |
| any active capture | Track stop, unmount, source switch, or page unload | abandoned | Releases microphone resources and local refs; does not offer resume |

Invalid transitions are no-ops guarded by the current recorder state and local state. For example, Pause while `idle`, Resume while already recording, and Discard while recording do not dispatch recorder methods.

### 5.2 One-recorder rule

Pause and Resume never stop and later recreate a `MediaRecorder` for the current take. They use the browser's pause and resume methods on the recorder created by Start recording. Stop cannot occur until the user chooses it; Resume always continues the existing stream and chunk collection.

This avoids:

- shipping a pre-stop audio `File` boundary;
- joining several recorder outputs across pauses;
- creating server-owned partial content;
- creating a difference between the visible take and bytes on disk.

The capture object remains in React refs. React state remains the user-visible state and no additional persistence layer is introduced.

### 5.3 Lifecycle and cleanup ownership

The existing ownership boundaries stay in place:

- `CaptureAudio` owns the microphone stream, recorder instance, chunk list, preview URL, Start/Pause/Resume/Stop/Discard controls, support and denial notices, and post-stop preview.
- `IngestFlow` owns title and language validation, pending-upload local-storage metadata, POST/PUT/finalize requests, upload progress, upload interruption recovery, and destination navigation.
- `src/server/ingest/service.ts` owns durable session, temporary byte, final media move, and auth checks after upload begins.
- `src/server/orchestration/*` and the Python worker own transcription only after durable media handoff.

Unmount and effect cleanup already revoke the preview and stop tracks. The implementation must extend equivalent cleanup to any recorder event listeners or tracks needed by the paused state, but it must not write abandoned capture bytes anywhere.

### 5.4 Server and persistence ownership

There is deliberately no server endpoint for pause, local pause session, pause heartbeat, partial upload, or pause recovery. The server first learns about a browser recording when `POST /api/ingest/sessions` passes a non-zero file size after Stop and Upload recording.

This maintains the current contract that:

- `record` is a `RecordingSource` value describing a completed browser capture after upload begins;
- upload sessions remain creator-bound;
- only non-content session metadata is stored in browser local storage;
- 24-hour cleanup applies only to incomplete durable upload sessions, not local captures;
- interrupted upload copy applies to the transfer stage, not a local capture.

## 6. User experience contract

### 6.1 State table

| Visible capture state | Controls shown | Copy and behavior |
|---|---|---|
| `idle` | Start recording | No preview. Existing field label and source context remain. |
| `recording` | Pause recording, Stop recording | Announce that recording is in progress and pause is available. Microphone is live. |
| `paused` | Resume recording, Stop recording | Announce "Recording paused. This recording stays in this browser tab; reloading, navigating, or switching source starts over. Resume to continue the same recording, or Stop to finish and preview the audio already captured." Pause is in-tab only. |
| `ready` | Discard | Preview plays the completed in-memory take. Discard clears it and returns to idle. |
| `unsupported` | None | Existing unsupported copy; no source trap. Upload remains available. |
| `denied` | None | Existing microphone denial alert keeps focus behavior and directs the user to Upload file. |
| `abandoned` | No persistent capture control | For reload, navigation, or source switch, the new context asks the user to start again and no longer references the old in-memory take. No recovery promise is made. |

Controls remain buttons with existing `interactive-target` styling and at least 44 px touch targets.

### 6.2 Pause and Resume details

- While `recording`, Start recording is disabled, Pause recording is enabled, and Stop recording is enabled.
- While `paused`, Resume recording is enabled and Stop recording remains enabled. Pause is not rendered as a second active control.
- Pause and Resume are local imperative actions, not form submissions, uploads, or server calls.
- The capture status note and polite live region announce transitions without spamming: recording started, paused, resumed, stopped, and discarded are discrete events.
- If the browser reports that the recorder is not in a compatible state when Pause or Resume is activated, the control does nothing beyond preserving current audio and, when appropriate, showing safe copy that capture can no longer be controlled reliably; the user may Stop or begin a new recording after the active recorder has safely stopped.
- Pausing does not start upload or create pending-upload metadata. Pausing therefore cannot be mistaken for the existing upload resume state.

### 6.3 Stop and preview details

- Stop is available from both `recording` and `paused` so a user can end a short or interrupted take without resuming it first.
- On stop, the existing single Blob/`File` construction, generated filename, preview URL, and `onRecordingReady(file)` call remain. There is no preview-before-stop mode and no background upload after stop.
- The preview must continue to use an object URL and revoke prior preview URLs exactly as it does now.
- Stop releases the microphone tracks in the recorder stop event. `ready` therefore has no live microphone indicator.

### 6.4 Discard details

- The current `Replace recording` button is renamed to **Discard**.
- Discard is available only in `ready`, after Stop has produced a complete in-memory file.
- Calling Discard revokes the preview URL, clears recorded file state and the parent `recordedFile`, and returns to `idle` with Start recording available.
- No confirmation modal is added: the content has not left the browser, the action is adjacent to an explicit preview, and a new recording can be started immediately. The button label itself names the abandonment rather than the current ambiguous "replace" language.
- Discard does not clear title, language, or source selection, matching the current parent ownership boundary.
- If upload has started, Discard is disabled through the existing parent `disabled` input; upload interruption recovery behaves as it does today.

### 6.5 Abandonment and interruption behavior

- Reload, browser close, tab replacement, and browser crash abandon in-memory capture. No recovery affordance is shown afterward.
- Switching from Record audio to Upload file after recording but before upload abandons the local take when the component unmounts. The upload source must not claim it can resume that abandoned recording.
- Navigating away from `/ingest` or signing out abandons the local take through component teardown. Existing auth navigation and session-expiry surfaces must not persist it.
- `beforeunload` is not extended for capture. The existing casefile unsaved-transcript warning is separate, and browser-confirm patterns are not needed for an audio blob that intentionally has no recovery.
- A source switch after Stop but before Upload uses the existing parent behavior: `recordedFile` remains only as the active Record audio source and must not be uploaded as an unexpected file if the user switches back or starts another take.
- Existing upload interruption and expired-session copy remains scoped to an upload already started by Upload recording.

## 7. Accessibility, responsive, and environment behavior

### 7.1 Keyboard and focus

- Start, Pause, Resume, Stop, and Discard are native buttons in tab order and never require pointer-only interaction.
- The support check remains server-safe and hydration-safe: the initial SSR output contains no unsupported browser-only recording control.
- Control availability and capture state are exposed by rendered text and button labels, not color alone.
- Paused and resumed transitions use a polite status region. Microphone denial keeps the current assertive alert and focus transfer because the user cannot proceed with Record audio.
- Pause, Resume, and Stop do not steal focus, reload the page, or move focus away from the activated button. Discard retains the current replace recording focus-neutral behavior.
- Button activation is idempotent while pending recorder events complete; repeated Enter or Space on a disabled control cannot create duplicate stop or start events.

### 7.2 Responsive and phone-safe behavior

- Pause and Resume appear within the same `button-row ingest-capture__actions` group, so they participate in existing ingest wrapping and narrow layouts without a new layout system.
- Phone safety mode permits supported browser audio recording today; pause/resume is a local capture convenience and therefore remains available on supported phone ingest, while governed mutations remain guarded by the existing rules.
- At 320 px and 390 px widths, buttons wrap without horizontal scrolling and keep at least 44 px interactive targets.
- No waveform or meter is introduced. State is expressed by text and button availability.

### 7.3 Browser support

- Existing gross support detection (`getUserMedia` plus `MediaRecorder`) remains the gate for presenting Record audio.
- Pause and Resume use native `MediaRecorder.pause()` and `.resume()` methods. Browser support detection does not change for this feature; a runtime call failure follows the safe behavior in Section 6.2.
- The existing unsupported branch remains: browsers without the required recording APIs show only the unsupported note and retain Upload file as the safe path.
- Tests use an explicit mock `MediaRecorder` implementing pause/resume state transitions, so product code does not invent a pause on browsers without these methods.

### 7.4 Privacy and local storage

- Paused audio remains only in the existing in-memory chunk refs until Stop or abandonment.
- No localStorage key is added or changed. The existing `superscriber.pendingIngest` metadata contains only stopped-file identity/session metadata and is still written only after the user chooses Upload recording and an upload session is created.
- No title or language is autopersisted while a recording is in progress.
- An abandoned capture produces no durable server state, audit event, security event, inbox row, and no lingering temporary upload file.

## 8. Error and edge-case handling

| Case | Required behavior |
|---|---|
| User pauses immediately after Start | Allowed once recorder state is `recording`; no partial upload session is created. |
| User resumes immediately after Pause | Allowed once recorder state is `paused`; same stream and chunk refs continue. |
| User stops directly from paused | Allowed; browser emits final data and stop, then preview is ready. |
| Browser permission denied after Start request | Existing assertive denial path replaces controls and stops tracks. |
| Microphone track ends while recording or paused | Treat as accidental interruption; release recorder resources, keep UI honest that the take cannot be resumed, and avoid writing bytes. |
| Recorder pause or resume throws | Keep the current in-memory chunks; prefer honest disabled or stopped capture controls over recreating a stream silently. |
| Source switched while active or ready capture exists | Old capture is abandoned on unmount; no upload session is implied. |
| Upload starts | Capture controls receive existing `disabled` input and cannot alter the file being uploaded. |
| Page hotspot during upload interruption repair | Upload recovery remains owned by `IngestFlow`; CaptureAudio does not attempt to pause a network transfer. |
| Duplicate Stop activation | Guard by local state and recorder inactive check; only one stop event may produce `onRecordingReady`. |
| Discard while upload pending | Disabled via parent state; no silent cancellation of an already-submitted upload. |

All user-facing failure copy is procedural and avoids API, MediaRecorder, stream, blob, stack, or path language.

## 9. Audit, status, and workflow impact

Pause and Resume have no governance meaning and therefore no `audit_events` entry. There is no workspace event for a microphone pause; no identity or authorization fact changes; no media reaches the appliance; and no assignment, review, approval, export, or casefile capability is affected.

Before upload, the local capture does not appear in:

- `recordings` or `ingestion_sessions` rows;
- work inbox counts or tabs;
- casefile `Needs ingest attention` or `Transcribing` stages;
- status-only casefile polling;
- transcript job queue behavior;
- administration assignment or oversight surfaces.

After Stop and Upload recording, all existing status ownership rules apply unchanged. The new controls therefore do not create any new cross-surface consistency problem.

## 10. Alternatives and decision

### 10.1 In-tab one-recorder pause/resume (recommended)

Extend `CaptureAudio` with a `paused` state and native one-instance `MediaRecorder.pause()`/`.resume()`. Stop and Discard retain the existing in-memory boundary. Upload services, storage, workflow, and transcription do not change.

**Trade-offs:** No paused-take recovery if the tab is interrupted; this is explicit and approved. The user can Stop, then upload the current take, but cannot recover a paused capture after reload.

**Why recommended:** It directly implements the captain-approved lifecycle, preserves safe-interruption policy, avoids an unexplained `capturing` server state, and keeps every durability boundary unchanged.

### 10.2 Capture-time server chunking and durable paused sessions

Append audio to a creator-bound server session during capture, reserve durable IDs up front, and recover the paused capture after interruption.

**Rejected:** This violates the first approved decision, adds server partial-content ownership, requires durable cleanup and authorization semantics before a completed recording exists, and reopens ingest schema, API, ledger, and retention design for no captain-authorized requirement.

### 10.3 Segmented recorder outputs

Stop and restart a recorder at each pause, then concatenate chunks or keep multiple files before upload.

**Rejected:** It risks composition errors and truncation, changes the one-take semantics, complicates preview and discard, and buys no persistence because all segments remain in memory. It is more failure-prone than pausing one recorder.

### 10.4 Pause as durable `integrityState = capturing`

Persist a recording row as soon as Start recording succeeds and use existing workflow bucketing to show capture status.

**Rejected:** Existing `capturing` and work-inbox stages govern ingest health after a recording exists; this design does not create a casefile for a capture that may never be uploaded. It would also require server API and database lifecycle changes outside the approved scope.

## 11. Test and validation matrix

The implementation phase must begin with failing tests at the closest user-aligned level, then proceed outward. This matrix is acceptance coverage, not optional examples.

| Approved behavior | Unit/component coverage | End-user-aligned browser coverage |
|---|---|---|
| Pause active recording | Mock MediaRecorder transitions to paused; Pause is disabled while idle and enabled while recording | Keyboard user starts recording and pauses without upload calls |
| Resume same take | Mock resume continues same recorder and chunk refs; no start call; Resume only in paused state | Pause then resume preserves the same in-tab recording lifecycle |
| Stop from paused | Stop calls preview creation once and emits `onRecordingReady` once | Paused take can stop immediately and show preview |
| Stop from recording remains unchanged | Existing stop behavior retained and duplicate stop guarded | Existing stop/preview/upload flow still reaches Upload recording |
| Discard rename and behavior | `ready` renders Discard; Discard clears preview/file, calls `onRecordingCleared`, returns to Start | User stops, previews, discards, and re-records without page reload |
| In-tab-only abandonment | Unmount clears refs/tracks, no browser-storage writes, no recovery copy | Source switch destroys active capture and does not add a pending upload; reload begins as no recoverable capture |
| No upload before explicit Upload recording | Fetch mock asserts no `/api/ingest/sessions` POST on Pause/Resume/Stop alone | Pause, Resume, Stop, and preview cause no ingest session creation |
| Upload unchanged after completed take | `IngestFlow` creates the same session and pending metadata after ready Record audio selection | Upload recording posts existing non-zero file and enters existing resumable upload |
| Microphone denial | Existing assertive notice and focus unchanged | Fake denied permission path still offers Upload file |
| Unsupported environment | No Record source without required APIs; SSR hydration stays clean | E2E support-detection behavior remains stable |
| Accessibility | Labels, disabled states, status announcements, 44 px class hooks, focus-neutral transitions | Keyboard-only Pause/Resume/Stop and focus remains sensible; axe surface stays clean |
| Responsive layout | Actions wrap inside existing ingest row; no row-specific width regression | 320 px and 390 px capture controls are visible and have no horizontal scroll |
| Phone-safe ingest | Supported local pause/resume remains available; no governed mutation appears | Phone ingest regression remains green, now asserting allowed local capture controls where supported |
| Backend lifecycle isolation | No schema/API/service changes are required; existing ingest service tests remain authoritative on sessions | Container E2E upload and transcription still proceed through durable handoff |
| Ownership isolation | No account-role import, branch, service, or schema dependency | No account-role behavior appears in recording-lifecycle tests |

Validation for the later implementation still includes the repository gate named by AGENTS.md: `npm run typecheck`, `npm test`, `npm run build`, `npm run worker:check`, `npm run e2e`, and `npm run e2e:container`.

## 12. Acceptance boundary

The design is complete when the implementation demonstrates all of the following in one shipped product change:

- an active browser capture can pause and resume without creating a second recorder or server state;
- Stop from either live or paused capture creates exactly one previewed in-memory file;
- the completed-take control is labeled Discard and clears only the in-memory take;
- Upload recording remains an explicit separate action and remains the first durable ingest boundary;
- no audio bytes reach browser persistence or the server before Upload recording, and Pausing/Resuming/Stopping create no pending-upload metadata before the completed take is submitted;
- reload, source switch, navigation, sign-out, or tab replacement abandons rather than pretends to recover local audio;
- phone and responsive behavior follow the existing ingest contract;
- keyboard operation, focus behavior, state text, announcements, and interactions meet the current accessibility contract;
- existing resumable upload, ingest service, work-inbox, casefile, verification, transcription, and audit behavior remain unchanged;
- no implementation or planning begins from this document before captain review approves the committed written spec.
