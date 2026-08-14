# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.5.0] - 2026-08-14

### Added
- Added governed account role management: inline role edits with a required change reason, atomic role-change audit, authorization version bump, and revocation of the account's active sessions, completing the identity wave in-tree (PR #8).
- Adopted an editorial single-voice wordmark and branded the sign-in and first-run surfaces, replayed as a two-door landing that also works without JavaScript (PRs #9, #10, #15, #29).
- Added a landing footer source repository link with an opt-in hosted user-guide link behind `SUPERSCRIBER_DOCS_URL` (PR #31).
- Added a per-user appearance system (Light / Dark / System) with a WCAG-AA dark theme (PR #12).
- Added recording pause and resume controls to governed ingest (PR #11).
- Added self-service and administrator password reset, with an opt-in SMTP mail seam and an operator-assisted default, a confirmation copy that no longer implies reset mail when none is configured, and a preserved self-reset link handoff (PRs #13, #23, #33).
- Added batch multi-file upload with a persistent transfer card and per-file results (PR #16).
- Restored the waveform player with segment-aware scrubbing, added playback toggle from active transcript segments, and pinned the playback chrome with a centered transcript follow-scroll (PRs #17, #32, #36).
- Added live, engine-derived transcription progress in work ledgers and uploader status casefiles (PR #21).
- Added a host-verified ingest model tier picker plus self-service admin model provisioning with free-space preflight, staged installs, and single-download serialization (PRs #19, #27, #37).
- Restored the governed folder-watch ingest lane with its operator runbook (PR #22).
- Expanded governed admin ledger access and restored case links across ledger rows (PRs #24, #25).
- Added operator-gated admin recovery: an on-host single-use claim-token ceremony that re-admins an instance whose accounts survived but which has no active administrator (PR #26).
- Added governed bulk speaker rename with a confirmed count summary and merge-onto-existing behavior (PR #35).
- Added a one-shot local deployment bootstrap with idempotent setup, model-tier provisioning, and crash-supervised app and worker processes (PR #40).
- Restored demo governance controls (PR #18).
- Added the Docusaurus documentation site with native versioning for GitHub Pages, including a full user guide from sign-in and bootstrap through review, approval, administration, and phone-safety operation (PR #6).
- Pinned the governed Delete recording control into the sticky casefile chrome and synced the horizontal segment rail with the transcript's active-segment follow-scroll (PR #46).

### Changed
- Recovered the 0.4.0 CHANGELOG section from the v0.4.0 release notes and aligned release metadata with the published tag (PRs #7, #41).
- Applied a casefile UX batch: bounded shell, header governance trigger, Edited-vs badges, and phone-safety copy (PR #14).
- Added CONTRIBUTING.md with the contribution workflow, validation gate, and security disclosure rules (PR #30).
- Documented the shipped repository link placement in the auth landing footer and the `SUPERSCRIBER_DOCS_URL` go-live switch in README and CONTRIBUTING (PR #48).
- Audited TODOS.md against the shipped wave so the remaining open item names current code truth (PR #47).

### Removed
- Relocated the internal superpowers specification and planning tree out of the public repository into a gitignored `.fm-internal` area (PR #43).
- Removed the root CLAUDE.md symlink and the relocation tombstone it left behind, routing public references to AGENTS.md as the canonical identity (PR #44).

### Fixed
- Stabilized OIDC sign-in, callback, and revocation flows under contention (PR #28).
- Made revision snapshot picks hard-navigate without an app-router dependency (PR #20).
- Restored governed export recovery for completed casefile snapshots (PR #34).
- Required password confirmation in the account dialog and compacted its layout (PR #39).
- Vertically centered the ingest file input chooser row (PR #38).
- Restored dark-mode segment-card contrast to the WCAG bar and constrained the reset pages width budget (PR #42).
- Corrected the v0.4.0 release record: the [0.4.0] section now equals tag v0.4.0 exactly, with post-tag work moved under the next-release section (PR #45).

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
- This section covers exactly the contents of the `v0.4.0` tag (published 2026-08-06): documentation governance (PR #3), the Authentik OIDC identity wave with break-glass access (PR #4), and container E2E hardening (PR #5).
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
