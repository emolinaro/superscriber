# TODOS

> Last audit: 2026-08-14. Basis: everything shipped in `v0.4.0..origin/main` (PRs #7 through #43; PR #44 did not exist at audit time, and #42/#43 were the day's landings). Every remaining item below was re-verified against main on that date.

## Review

### Replace full-segment-array saves with patch-based transcript edits

**What:** Change the review save protocol so the browser submits only changed text/speaker fields and the server merges them into the canonical transcript skeleton.

**Why:** This reduces payload size for long interviews, keeps worker-owned metadata server-controlled, and sets up cleaner autosave and conflict handling later.

**Context (re-verified 2026-08-14):** Still open; no PR in #8-#43 changed the save protocol. The shipped casefile page wires saves to `saveDraftAction` and submissions to `submitRevisionAction` (`src/server/actions/casefile-actions.ts`). Both paths receive the complete current segment array built at action time, but the submission path performs the draft-save step only when there are unsaved changes. Whenever draft content is saved, the full-array contract is enforced server-side by `assertCompleteSegments` in `src/server/casefile/commands.ts`, which rejects drafts whose segment count or any segment identity/timing differs from the prior revision. A patch protocol remains the more complete design for large transcripts and fine-grained auditability, and the governed-casefile spec deliberately left it out of v1. Note: the governed bulk speaker rename (#35) is a separate audited command path, not a browser save path, and does not relax the full-array draft requirement.

**Effort:** M
**Priority:** P2
**Depends on:** Nothing structural; the casefile revision service and command surface (`src/server/casefile/commands.ts`) are in place on main

## Completed

- 2026-08-04: Added institutional SSO alongside local accounts: Authentik OIDC in dual and authentik-primary modes, exact identity linking, revocable server-side sessions, break-glass emergency access, and operator runbooks under docs/operators/.

- 2026-08-02: Shipped the governed casefile redesign (v0.3.0.0): role-aware work inbox, transcript-first casefile, withdrawal/request-changes/approve/reopen commands, append-only assignment history, audited admin action mode, and audited approved export.
- 2026-08-02: Added automated accessibility regression coverage (axe) across auth, work inbox, casefile, export, and administration surfaces, plus responsive and phone-safety suites.
- 2026-04-30: Shipped the self-contained backend appliance (v0.2.0) with local accounts, assignment-gated review and approval, resumable ingest, and internal transcript-job orchestration.
- 2026-04-30: Added Playwright coverage for first-run auth, governed upload resume, assignment enforcement, phone-sized read-only review, and the single-image container path.
