# Recording Lifecycle Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) if a delegate is explicitly authorized, or superpowers:executing-plans to implement this plan task-by-task in the authorized session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add captain-approved in-tab Pause, Resume, and Discard controls to browser audio recording while preserving the existing Stop > preview > Upload recording boundary and every backend lifecycle invariant.

**Architecture:** Extend `CaptureAudio` with one local `paused` state and one active `MediaRecorder` instance. `IngestFlow` remains the owner of title, language, the completed in-memory file, upload sessions, chunk transfer, reconciliation, and finalization; the server first sees the recording only after the user selects Upload recording.

**Tech Stack:** Next.js 16, React 19, TypeScript, MediaRecorder, Vitest, Testing Library, Playwright, SQLite/Drizzle-backed existing ingest service.

## Global Constraints

- Approved flow: Start > Pause > Resume > Stop > preview > Upload recording.
- Pause and Resume are local to the current browser tab and use the same `MediaRecorder` instance.
- Stop remains the only boundary that creates the completed in-memory `File` and preview.
- Replace recording is renamed Discard; Discard is available only after Stop and clears only the completed in-memory take.
- No durable capture-time persistence, server-side partial upload state, schema field, capture API, pause audit event, workflow stage, or recovery across reload, navigation, source switch, browser crash, tab replacement, device sleep, or sign-out.
- Existing upload sessions, creator authorization, non-content pending metadata, resumable chunk transfer, verification, orchestration, transcription, inbox, casefile, and audit behavior remain unchanged.
- No audio bytes or content-bearing capture metadata are written to browser storage or the server before Stop; the existing pending-upload metadata is still written only after Upload recording creates an ingest session.
- Controls remain native keyboard-operable buttons with existing `interactive-target` treatment, at least 44 px targets, truthful labels, and polite transition announcements; denied microphone requests retain the existing assertive error path.
- Pause and Resume stay available for supported phone ingest; no governed mutation is introduced.
- No dependency on the in-flight account-role feature or its worktree changes.
- Product implementation remains unauthorized until the captain approves this committed plan.

---

### Task 1: Add and test the one-recorder local capture state machine

**Files:**
- Modify: `src/components/ingest/capture-audio.tsx`
- Test: `src/components/ingest/capture-audio.test.tsx`

**Interfaces:**
- Consumes: existing `disabled`, `onRecordingReady: (file: File) => void`, and `onRecordingCleared: () => void` props.
- Produces: local states `"idle" | "recording" | "paused" | "ready" | "unsupported" | "denied"`; user controls named Start recording, Pause recording, Resume recording, Stop recording, and Discard.

- [ ] **Step 1: Extend the failing component test mock**

  Update the mock `MediaRecorder` with stable `pause()` and `resume()` methods, state transitions through `"recording"` and `"paused"`, counters proving one recorder continues, and a toggle for recorder method failure. Keep existing Stop behavior emitting one data event and one stop event.

- [ ] **Step 2: Run focused tests and verify the missing UI fails**

Run: `npx vitest run src/components/ingest/capture-audio.test.tsx`
Expected: FAIL because Pause recording, Resume recording, and Discard are not rendered and no paused state exists.

- [ ] **Step 3: Implement the minimal local state machine**

  Add `"paused"` to the existing capture-state union. Implement guarded `pauseRecording()` and `resumeRecording()` methods that no-op unless the visible state and `recorder.state` agree. Pause calls the active recorder's `pause()` and preserves its stream and chunk refs. Resume calls the same recorder's `resume()`. Never stop, replace, or recreate the recorder for a pause boundary. Allow Stop directly from both live and paused states, emit `onRecordingReady` once on the recorder stop event, and rename the completed-take control to Discard.

- [ ] **Step 4: Render the approved capture states**

  Keep the existing `interactive-target` button classes. While recording, show Pause recording and Stop recording; while paused, show Resume recording and Stop recording; while ready, show the preview and Discard. Add a polite status region with the approved paused copy, including that this recording stays in the current tab and that there is no recovery after reload, navigation, or source switch. Make recorder-method errors procedural and keep current audio in memory so the user can Stop it safely.

- [ ] **Step 5: Run focused tests until they pass**

Run: `npx vitest run src/components/ingest/capture-audio.test.tsx`
Expected: PASS. Tests prove Pause/Resume are available only in legal states, the recorder instance is reused, duplicate Stop emits `onRecordingReady` once, Stop from paused works, and Discard calls `onRecordingCleared`, revokes preview state, and restores Start recording.

- [ ] **Step 6: Commit**

```bash
git add src/components/ingest/capture-audio.tsx src/components/ingest/capture-audio.test.tsx
git commit -m "feat(ingest): pause and resume browser audio capture"
```

---

### Task 2: Prove capture actions never create durable ingest state

**Files:**
- Modify only if tests reveal a boundary defect: `src/components/ingest/ingest-flow.tsx`
- Test: `src/components/ingest/ingest-flow.test.tsx`

**Interfaces:**
- Consumes: the Task 1 `CaptureAudio` controls and existing callbacks.
- Produces: unchanged parent behavior where `recordedFile` becomes non-null only after Stop and `POST /api/ingest/sessions` occurs only after the visible Upload recording action.

- [ ] **Step 1: Write failing integration tests**

  Add tests that choose Record audio, pass title and language validation, Start, Pause, Resume, and Stop, then assert zero `POST /api/ingest/sessions` calls. Assert the existing pending-upload metadata is still not written until the explicit Upload recording submit. Add a Discard/re-record test that proves a discarded take cannot be uploaded accidentally.

- [ ] **Step 2: Run focused tests and classify any failure**

Run: `npx vitest run src/components/ingest/ingest-flow.test.tsx`
Expected: The new boundary tests fail only if Task 1 has not yet provided the controls, or if a real privacy defect leaks durable state early. Classification output must distinguish missing controls from an actual premature upload.

- [ ] **Step 3: Apply the smallest boundary fix only if required**

  Keep `CaptureAudio` callbacks and `IngestFlow` ownership unchanged. Do not add server calls, local-storage keys, timers, prefetching, background upload, or capture state to `IngestFlow`. If a test proves a parent bug, fix that exact parent contract without changing validation rules, pending-upload shape, upload destinations, or resumable recovery.

- [ ] **Step 4: Run focused integration tests**

Run: `npx vitest run src/components/ingest/ingest-flow.test.tsx`
Expected: PASS, including every existing session creation, chunking, finalize reconciliation, ownership, interruption, and destination-navigation test.

- [ ] **Step 5: Commit**

```bash
git add src/components/ingest/ingest-flow.test.tsx
# add src/components/ingest/ingest-flow.tsx only when Step 3 changed it
git commit -m "test(ingest): prove local capture waits for explicit upload"
```

---

### Task 3: Cover abandonment, cleanup, and interaction edge cases

**Files:**
- Modify: `src/components/ingest/capture-audio.tsx`
- Modify: `src/components/ingest/ingest-flow.tsx`
- Test: `src/components/ingest/capture-audio.test.tsx`
- Test: `src/components/ingest/ingest-flow.test.tsx`

**Interfaces:**
- Consumes: Task 1 state machine and Task 2 parent boundary.
- Produces: a cleanup contract where active tracks/listeners are released on unmount, switch away from Record audio removes the completed in-memory file from parent upload consideration, and no abandoned take is recoverable or represented as resumable.

- [ ] **Step 1: Write failing abandonment and cleanup tests**

  Component tests must cover unmount while recording and paused, duplicate control activation, a microphone track ending, a pause or resume recorder-method failure, and unavailable controls in unsupported/denied states. Parent tests must cover switching from Record audio to Upload file after Stop, switching back, and proving the old abandoned take cannot be submitted without starting another recording.

- [ ] **Step 2: Run focused tests and verify intentional failures**

Run: `npx vitest run src/components/ingest/capture-audio.test.tsx src/components/ingest/ingest-flow.test.tsx`
Expected: FAIL for any missing cleanup or abandoned-take behavior. Existing microphone denial and unsupported-environment tests must remain unchanged and red only for behavior this task intentionally adds.

- [ ] **Step 3: Implement cleanup and abandonment behavior**

  Add explicit `ended`/listener cleanup without persisting chunks. On unmount or track ending, stop/release local stream, recorder, chunk, and preview references and do not call `onRecordingReady`. Announce that the active take cannot continue and leave Start recording available instead of offering recovery. When the user changes from Record audio to Upload file, `IngestFlow` directly clears only its local `recordedFile`; it must not call `onRecordingCleared` from a component unmount, and it must not clear title, language, or an explicit upload-file selection.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run src/components/ingest/capture-audio.test.tsx src/components/ingest/ingest-flow.test.tsx`
Run: `npm run typecheck`
Expected: PASS with no false-positive React listener or unmount-setState warnings relevant to this task.

- [ ] **Step 5: Commit**

```bash
git add src/components/ingest/capture-audio.tsx src/components/ingest/capture-audio.test.tsx src/components/ingest/ingest-flow.tsx src/components/ingest/ingest-flow.test.tsx
git commit -m "fix(ingest): abandon local captures without persisting them"
```

---

### Task 4: Prove accessibility, responsive behavior, and the unchanged durable handoff in a browser

**Files:**
- Modify: `e2e/appliance.spec.ts`
- Modify: `e2e/accessibility.spec.ts`
- Modify: `e2e/responsive.spec.ts` only if ingest coverage cannot fit the appliance browser context cleanly

**Interfaces:**
- Consumes: prior production controls and existing browser/session helpers.
- Produces: end-user-aligned evidence that the full approved sequence works and backend state remains untouched before explicit Upload recording.

- [ ] **Step 1: Write failing browser coverage**

  Extend the existing appliance ingest test's fake `MediaRecorder` with deterministic pause, resume, and stop state or add a dedicated focused context beside it. Drive keyboard-visible Pause, Resume, and Stop controls through an authenticated `/ingest` page. Until Upload recording is selected, assert zero session-creation requests and zero new local-storage pending-ingest metadata. Then submit, assert the existing destination, and use `queryRuntimeRows` to prove the first durable row has the existing `record` source and expected ingest ownership.

- [ ] **Step 2: Add accessibility and responsive assertions**

  Assert button names, focus order, role/status announcements, and unchanged denial recovery. At 320 and 390 px widths, assert no page-level horizontal scrolling and Pause, Resume, Stop, and Discard retain at least 44 px rendered targets. Add or place the ingest surface in the existing axe assertions without weakening rules.

- [ ] **Step 3: Run the focused browser lane**

Run: `npm run e2e -- e2e/appliance.spec.ts e2e/accessibility.spec.ts e2e/responsive.spec.ts` against the repository-configured local app, or `npm run e2e:container -- e2e/appliance.spec.ts e2e/accessibility.spec.ts e2e/responsive.spec.ts` through the documented container runner.
Expected: The focused lane starts PASSing only after the product change and proves the required control geometry, announcements, and durable boundary.

- [ ] **Step 4: Commit**

```bash
git add e2e/appliance.spec.ts e2e/accessibility.spec.ts e2e/responsive.spec.ts
git commit -m "test(e2e): cover in-tab recording lifecycle controls"
```

---

### Task 5: Update the behavioral contract and run the repository validation gate

**Files:**
- Modify: `DESIGN.md`
- Modify: `README.md` only to describe the shipped user control if the feature list requires precision
- Do not modify: `CHANGELOG.md`, generated release metadata, server ingest routes, database schema or migrations, orchestration files, worker files, or account-role files

**Interfaces:**
- Consumes: shipped Task 1-4 behavior and the approved 2026-08-09 design spec.
- Produces: user-facing design documentation matching Pause/Resume/Discard and in-tab abandonment, plus fresh repository-wide validation evidence.

- [ ] **Step 1: Update the governed ingest contract**

  In `DESIGN.md`, update the focused ingest contract to say browser capture supports Start, Pause, Resume, Stop, preview, and Discard; Upload recording remains the first durable boundary; paused or completed capture remains in memory and is not recoverable after reload, navigation, source switch, or tab replacement. Keep all upload chunk, 24-hour cleanup, creator ownership, and dispatch/copy language unchanged. Update `README.md` only if its browser-recording bullet would otherwise be misleading.

- [ ] **Step 2: Self-review the product diff**

Run: `git diff --check`
Run: `git diff -- src/components/ingest e2e DESIGN.md README.md`
Expected: No account-role path, schema, migration, API route, audit type, worker, or orchestration change appears. Controls, copy, and documentation match the approved spec exactly.

- [ ] **Step 3: Run the full repository validation gate**

Run in order:
1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run worker:check`
5. `npm run e2e`
6. `npm run e2e:container`

  Follow the README's e2e port preflight and do not leave a foreign server on the configured app port. Preserve authentic failure output; do not weaken assertions to mask flakes.

- [ ] **Step 4: Commit documentation after product evidence passes**

```bash
git add DESIGN.md README.md
git commit -m "docs: document in-tab recording pause and resume"
```

  Add only the files actually changed. Do not create an empty commit if all documentation already matches the shipped behavior.

---

## Acceptance contract

The plan is successfully implemented when all of the following are demonstrated:

- Pause and Resume operate the same active `MediaRecorder` only in the current tab.
- Stop works from live and paused capture and produces exactly one completed in-memory preview file.
- Discard replaces the prior completed-take control and cannot delete an upload already in progress.
- Pause, Resume, Stop, preview rendering, or Discard alone never create `POST /api/ingest/sessions`, server rows, audit events, browser persistence, inbox/status entries, or transcript jobs.
- Upload recording remains the explicit first durable handoff and uses the current creator-bound resumable upload flow unchanged.
- Reload, navigation, source switch, sign-out, tab replacement, browser crash, and device interruption abandon rather than recover local audio.
- Keyboard operation, transition announcements, focus behavior, touch targets, and 320/390 px wrapping meet the product accessibility contract.
- Existing microphone denial, unsupported-browser, upload resume/finalize/reconciliation, and transcription behavior all remain green.
- No account-role file, branch behavior, schema change, API change, server-side partial capture, or durable paused session is introduced.
- The full repository validation gate passes before the product change is delivered through no-mistakes.
