# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-08-06

### Added
- Added Authentik OIDC integration as a central identity provider with a revocable session registry, strength-scaled authorization, and external identity links with strict role mapping (PR #4).
- Added an identity mode contract (local / dual-run / authentik-primary) enforced by startup invariants, with operator tooling, runbooks, and documentation (PR #4).
- Added break-glass access: a designated emergency local admin protected by a WebAuthn ceremony and one-time codes (PR #4).
- Added container E2E failure-artifact uploads for CI debugging (PR #5).

### Changed
- Aligned README, AGENTS, DESIGN, and TODOS with the v0.3.0.0 reality and untracked the superpowers specs (PR #3).
- Hardened container E2E with navigation anchors and a pinned base image digest (PR #5).

### Notes
- No live-target changes: all integration delivery qualified locally (unit and container E2E lanes).

## [0.3.0.0] - 2026-08-02

### Added
- Shipped a governed casefile redesign that adds a dedicated casefile workspace, role-aware workflow actions, and explicit admin action mode safeguards.
- Added resumable upload support with creator-bound sessions, improved ingest progress handling, and guarded chunk finalization flows.
- Added transcript-first review controls, including draft submission, request-changes, approval, and admin reopen handoffs.
- Added role-aware work inbox and recording ledger views for uploaders, reviewers, approvers, and admins.
- Added audited decision exports and approved export capabilities for completed casefile snapshots.

### Changed
- Reworked workspace and review surfaces to align with governed flow ownership, clearer action labels, and safer escalation states.
- Updated orchestration, access, and store-level synchronization so governing actions remain consistent between mock and production modes.
- Refined responsive app shell and UI behavior to keep navigation, empty-state, and auth pathways stable under constrained viewports.
- Expanded automated coverage around auth recovery, governed ingestion, decision lifecycle, workspace inbox states, and admin controls.

### Fixed
- Fixed multiple governed workflow regressions across action session boundaries, transcript visibility, and status-poll timing.
- Fixed assignment and reopen edge cases by preserving assignment history and routing completed-state actions to the correct next step.
- Fixed role and status mismatches in workspace ledgers by normalizing action labels and empty states.
- Fixed export and approved-revision handling to avoid stale snapshot access and to keep safe boundaries around protected actions.

## [0.2.0] - 2026-04-30

### Added
- Shipped a self-contained governed transcription appliance with local accounts, role-specific workspace surfaces, server-side media handling, and browser-based review and approval flows.
- Added resumable ingest APIs, internal transcript job endpoints, a local Python worker with degraded fallback transcripts, and container helpers for single-image deployment.
- Added approved transcript export from the review workspace in `DOCX`, `TXT`, `SRT`, `VTT`, `CSV`, `TSV`, and `JSON` once a revision is approved.
- Added automated coverage for first-run auth, upload resume, assignment enforcement, mobile read-only review, approved export downloads, and the end-to-end appliance container flow.

### Changed
- Reworked the landing, workspace, and review interfaces around the Superscriber brand system, including the new app icon, role-aware hierarchy, and the in-place approved export sheet.
- Moved orchestration, auth, access control, persistence, and transcript export into the self-contained backend stack and documented the appliance runtime model in the repo docs.
- Serialized the Playwright suite to one worker because the E2E harness shares a single first-run appliance instance.

### Fixed
- Prevented phone-sized review screens from exposing live editing or approval controls.
- Corrected the logo orientation and tightened the workspace and review action hierarchy discovered during design review.
- Prevented stale SQLite state snapshots from overwriting newer reviewer or worker updates during governed transcript operations.
