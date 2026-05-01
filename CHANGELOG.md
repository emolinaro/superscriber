# Changelog

All notable changes to this project will be documented in this file.

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
