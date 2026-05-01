# TODOS

## Infrastructure

### Add institutional SSO alongside local-account appliance mode

**What:** Add OIDC-based institutional SSO as an alternative auth provider, while keeping the local-account appliance mode as the self-contained default.

**Why:** Many regulated institutions will eventually require their own identity provider, MFA, and account lifecycle management even if the first shippable backend uses local accounts.

**Context:** The reviewed plan deliberately chose built-in local accounts for v1 because the product must be deliverable as a self-contained appliance. The next auth step after that is dual-mode identity, not replacing the whole access layer later.

**Effort:** M
**Priority:** P2
**Depends on:** Local `User`/`Session` model and the v1 auth/access layer

## Review

### Replace coarse full-revision saves with patch-based transcript edits

**What:** Change the review save protocol so the browser submits only changed text/speaker fields and the server merges them into the canonical transcript skeleton.

**Why:** This reduces payload size for long interviews, keeps worker-owned metadata server-controlled, and sets up cleaner autosave and conflict handling later.

**Context:** The engineering review accepted a v1 compromise: keep full revision saves, but only build the payload on save/submit instead of every render. The more complete design is still patch-based editing, especially for large transcripts and fine-grained auditability.

**Effort:** M
**Priority:** P2
**Depends on:** v1 revision service and the review-editor rewrite that removes constant hidden-input serialization

## Accessibility

### Add automated accessibility regression checks for critical governed flows

**What:** Add automated accessibility checks, likely Playwright plus an accessibility scanner, for first-run/login, reviewer desk, ingest interruption states, and the review workspace.

**Why:** The new `DESIGN.md` makes accessibility an acceptance contract, but today that contract is still prose. Automated checks would catch regressions in focus management, labels, landmarks, and critical state messaging before they silently ship.

**Context:** The design review pulled the accessibility acceptance spec into scope now, and the eng rerun kept it in scope architecturally. What is still deferred is CI-backed regression coverage for those behaviors, especially after the planned auth, ingest, and review rewrites land.

**Effort:** M
**Priority:** P2
**Depends on:** Playwright E2E harness and the new auth/review screens existing in code

## Completed

- 2026-04-30: Shipped the self-contained backend appliance with local accounts, assignment-gated review and approval, resumable ingest, and internal transcript-job orchestration.
- 2026-04-30: Added Playwright coverage for first-run auth, governed upload resume, assignment enforcement, phone-sized read-only review, and the single-image container path.
