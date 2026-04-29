# DESIGN

## Purpose

Superscriber should feel like a calm, governed institutional workspace, not a generic AI dashboard and not a developer console. The core product promise is simple: sensitive recordings enter one controlled system, reviewers do careful work in the browser, and approvals happen against an explicit, traceable record.

This file is the visual and interaction source of truth for implementation on `self-contained-backend`.

## Product Posture

- Calm, explicit, non-alarmist
- Transcript-first, not metadata-first
- Utility language over marketing language inside the app
- Trust comes from clarity: what happened, what is safe, what happens next
- Admin and bootstrap flows are part of the same product, not a separate back office

## Visual Grammar

### Typography

- Display/headings: serif display family, matching the current product direction
- Body/UI text: humanist sans family, matching the current product direction
- Monospace: reserved for revision ids, timestamps, and technical identifiers

### Color

- Primary dark surface: deep teal/green
- Base background: warm parchment/light paper
- Accent: restrained burnt orange
- Status tones: explicit green, amber, red, muted blue-gray
- Avoid bright SaaS gradients, purple-blue palettes, and decorative color noise

### Surfaces

- Primary work surfaces should feel quiet and readable
- Secondary context should be visually lighter than the main task
- Cards only when the card is the interaction
- Borders, shadows, and gradients stay restrained; typography and spacing carry hierarchy

## Core Layout Rules

- Every screen has one dominant job and one dominant CTA
- Primary workspace first, secondary context second, system chrome third
- Secondary context must never outrank the transcript, worklist, or active task
- If three things cannot fit comfortably on first view, cut to the three that matter most now

## Information Architecture Decisions

### First-Run And Login

- First-run setup is a dedicated one-time gate before normal login
- First-run flow has exactly three jobs:
  1. confirm appliance/environment readiness
  2. create the first admin
  3. hand off to normal login
- Daily login is a separate steady-state screen

### Role Homes

- Reviewer home defaults to an assigned-work desk, not the full system taxonomy
- Reviewer first view prioritizes:
  1. next assigned item
  2. needs review now
  3. blocked or returned items
- Full queue/state taxonomy can exist as a filter, lower section, or alternate view

### Review Workspace

- Review stays transcript-first
- Desktop/tablet review layout uses two zones:
  - primary zone: playback + transcript editor
  - secondary zone: collapsible drawer/tab set for policy, audit, integrity, assignment, and approval context
- Approval happens inside the same review workspace as a mode/panel, not on a separate destination

## Interaction And Copy Rules

- Prefer procedural language: "Session expired. Sign in again to continue."
- Avoid vague status theater: no fake autosave, no decorative warning copy
- Warnings appear only when risk or blocked action is real
- Success messages confirm the durable thing that happened: saved revision, queued upload, approved record
- Partial states must explain whether the user can continue safely

## State Specifications

### Authentication

| State | User Sees | Primary Action |
|---|---|---|
| First run | Setup gate with environment/trust framing and first-admin form | Create admin |
| Normal login | Simple sign-in surface with local account fields and policy context | Sign in |
| Wrong password | Inline error on the form, no ambiguous failure language | Retry sign-in |
| Session expired | Clear interruption message with return-to-login handoff | Sign in again |
| Logged out | Quiet confirmation that the session ended safely | Return to login |

### Ingest Interruption

| State | User Sees | Primary Action |
|---|---|---|
| Resumable | Upload/recording was interrupted but server still has a resumable session | Resume |
| Needs restart | Verification failed or bytes mismatch prevents safe resume | Restart upload/recording |
| Expired/cleaned up | Server removed abandoned temporary material under retention policy | Start a new session |

### Review Conflict

| State | User Sees | Primary Action |
|---|---|---|
| Stale revision conflict | "This recording changed since you opened it", current revision id, and what changed | Reload and reconcile |
| Save blocked by lock/approval | Explicit lock reason and current approval state | View latest approved/reopened state |

## Responsive Behavior

- Desktop and tablet support the full review workflow
- Phones support:
  - login
  - first-run setup if necessary
  - worklist visibility
  - assignment/status checks
  - upload/record when supported
  - constrained read-only or emergency access to review context
- Phones do not get the full long-form transcript correction experience in v1
- On narrower widths, secondary context collapses before the primary transcript/editor area does

## Accessibility Acceptance Spec

These requirements apply to the new auth, worklist, ingest, review, and approval surfaces. A feature is not design-complete until these pass.

### Global

- Body text must meet readable contrast targets; do not rely on pale status text for important meaning
- Interactive targets must be at least 44px in both dimensions where practical
- Visible labels must remain present even when fields contain content; placeholders are supplementary only
- Keyboard focus must always be visible and high contrast
- Visited and unvisited links must remain distinguishable
- Headings and landmarks must reflect the real page structure

### Auth And First-Run

- Login and bootstrap screens must be fully keyboard-operable without pointer input
- Focus lands on the page heading or first invalid field after navigation/submit
- Wrong-password and expired-session errors are announced and tied to the relevant form
- Successful logout returns focus to the login heading or first actionable control

### Worklists

- Queue/worklist regions expose meaningful headings and list semantics
- Filter changes and empty states are announced clearly
- "Next assigned item" must be reachable without tabbing through unrelated chrome first

### Ingest

- Recording/upload mode switches must be keyboard-operable and expose selected state
- Progress and interruption states must be exposed through live regions without spamming announcements
- Resume, restart, and cleanup outcomes must be distinguishable by text alone, not color alone

### Review Workspace

- The transcript timeline, segment list, and editor must be operable without mouse-only gestures
- Active segment state must be communicated visually and programmatically
- Save/submit/approve actions must preserve sensible focus after success or error
- Conflict states must announce what changed and where the next recovery action is
- Drawer/tab secondary context must preserve focus order and restore focus when closed

### Media

- Audio/video controls must remain reachable and understandable when native controls are used
- If playback is denied, the denial message replaces the control region with a clear explanation

## Reuse From Current App

- Deep teal + parchment + restrained accent palette
- Serif display + humanist sans pairing
- Quieted session chrome
- Dense reviewer queue direction rather than oversized dashboard cards
- Transcript-first review workspace, with secondary context visually subordinate

## Anti-Slop Rules

- No generic admin/settings visual fork for bootstrap or account screens
- No three-column SaaS feature-grid thinking inside task screens
- No centered-everything app layouts
- No decorative status cards where a list, table, or drawer is the clearer pattern
- No ornamental warning banners on routine flows

## Deliberately Out Of Scope For V1

- Full phone editing parity for long transcript correction
- Patch-based segment editing protocol
- Institutional SSO as the primary auth mode
- Timing-edit tools for transcript alignment

## Implementation Check

Before shipping a new screen, confirm:

1. What is the one dominant job on this screen?
2. Is the primary work visually stronger than the secondary context?
3. Does the copy say what happened, what is safe, and what happens next?
4. Does the screen still work by keyboard and screen reader?
5. Does this surface still feel like Superscriber, not a generic admin panel?
