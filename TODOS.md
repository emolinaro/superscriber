# TODOS

> Last audit: 2026-08-14. Basis: everything shipped in `v0.4.0..origin/main` (PRs #7 through #43; PR #44 did not exist at audit time, and #42/#43 were the day's landings). Every remaining item below was re-verified against main on that date.

## Review

## Completed

- 2026-08-15: Replaced full-segment-array draft saves with a patch-based transcript edit protocol: the browser submits only changed text/speaker fields per segment, the server merges them into the canonical transcript skeleton (count, identity, timing, and worker-owned metadata stay server-pinned), and the save/submit audit events record the patch.

- 2026-08-04: Added institutional SSO alongside local accounts: Authentik OIDC in dual and authentik-primary modes, exact identity linking, revocable server-side sessions, break-glass emergency access, and operator runbooks under docs/operators/.

- 2026-08-02: Shipped the governed casefile redesign (v0.3.0.0): role-aware work inbox, transcript-first casefile, withdrawal/request-changes/approve/reopen commands, append-only assignment history, audited admin action mode, and audited approved export.
- 2026-08-02: Added automated accessibility regression coverage (axe) across auth, work inbox, casefile, export, and administration surfaces, plus responsive and phone-safety suites.
- 2026-04-30: Shipped the self-contained backend appliance (v0.2.0) with local accounts, assignment-gated review and approval, resumable ingest, and internal transcript-job orchestration.
- 2026-04-30: Added Playwright coverage for first-run auth, governed upload resume, assignment enforcement, phone-sized read-only review, and the single-image container path.
