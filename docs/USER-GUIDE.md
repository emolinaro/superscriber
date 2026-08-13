# User guide

This guide walks the appliance end to end: from signing in, through ingest,
transcription, review, and approval, to export and administration. It
describes what you can do from each role and where every surface lives.

Superscriber models a regulated workflow:

`record or upload -> verify -> transcribe -> review in browser -> approve server-side`

Everything you do lands in a governed casefile: a transcript-first record
whose state, assignments, decisions, and audit history always stay in
agreement.

## Signing in and your account

Open the appliance URL you were given. What you see depends on how your
instance is configured:

- **First run (no accounts yet).** The sign-up door is the bootstrap door:
  the first account created becomes the administrator. The door closes
  afterwards; from then on, accounts are provisioned from **Administration >
  Accounts**.
- **Local sign-in.** Enter your email and password on the sign-in door.
- **Institutional sign-in.** If your deployment offers Authentik OIDC, a
  sign-in button for it appears alongside (or instead of) the local form.

Sessions are server-side and revocable: when an administrator changes your
roles, resets your password, or disables your account, active sessions end.

### Appearance themes

The account menu (top right) offers **Light**, **Dark**, and **System**
appearance themes. The choice applies instantly, boots flash-free on your
next visit, and is stored against your account server-side - sign in from
any device and the theme follows you.

### If you forget your password

The sign-in door links to a password reset request. The confirmation is
honest about what this instance can do:

- If reset mail is configured, the reset link arrives by email and is
  valid for 60 minutes.
- If the instance does not send email (the default posture), the
  confirmation says so plainly and your administrator resets the password
  for you from **Administration > Accounts**. An administrator reset
  invalidates any in-flight reset link and ends every session on the
  account immediately.

Only completing a reset changes anything; asking for a link alone leaves
your sessions and password untouched.

## The work inbox

The **Work** page is your role-aware inbox. Tabs and counts adapt to your
roles - uploaders see **My uploads**, **Processing**, and friends; reviewers
see **To review**; approvers see **To decide**; admins see everything with the
full ledger. Clicking any row opens that recording's casefile.

- **Live transcription progress.** While a recording transcribes, its
  ledger row pulses with live, engine-derived progress (and an uploader's
  own status casefile shows it at source). No refresh needed.
- **Next action.** Where the inbox can name one, it leads with the single
  most useful next step for your role.

## Ingest: upload or record

The **Ingest** page (uploaders and admins) handles every way audio enters
the appliance. Every transfer is resumable in 1 MiB chunks: an interrupted
upload picks up where it left off and never re-sends a committed byte.

- **Batch upload.** Drop or pick several files at once. A persistent
  transfer card tracks the whole batch with per-file byte progress and a
  per-file result, and it stays on the page while uploads run. One bad file
  never stops the batch - the failure is reported and the rest continue.
- **Browser audio recording.** Record straight from the page; the recording
  rides the same resumable session protocol as an upload.
- **Model selection (Advanced settings).** Transcription runs on a
  faster-whisper model tier verified on the host. Provisioned tiers can be
  selected per recording; speed and quality notes are listed next to each
  tier.
- **Model downloads (admins).** If a tier in the catalog is not provisioned
  on this host, an administrator sees a **Download** action on that tier:
  one click installs it in place, with the exact size and live byte
  progress, and no appliance restart.

Operators can also run a governed folder-watch lane, where recordings are
intaken unattended from a watched directory; see
[`docs/operators/ingest-watch.md`](./docs/operators/ingest-watch.md).

## The casefile

The casefile is where a recording becomes a transcript. What you can do on
it depends on your role, your assignments, and the workspace policy - the
server computes your capabilities and the page only ever shows what you may
use.

### The player

The media transport shows the decoded audio waveform, and the wave itself
is the seek surface: click or drag anywhere to jump, or use the keyboard.
Per-segment markers line the transcript up with the audio, the currently
playing segment is highlighted by an active band, and a timecode readout
tracks the position.

- **Click-to-play segments.** Clicking a transcript segment that is not
  playing seeks to it and plays from there.
- **Click-to-pause.** Clicking the currently playing segment pauses in
  place; clicking it again resumes from the unchanged paused position. The
  transport toggle (and the Space key) does exactly the same.
- **Pinned chrome, centered follow.** The transport, wave, and timecode
  stay pinned above the transcript while the transcript scrolls underneath,
  so playback controls never scroll away. As playback advances, follow
  scroll keeps the active segment centered in view; it yields the moment
  you scroll manually and re-engages on any explicit seek.

Where a browser cannot decode the audio, native media controls remain the
fallback (and always are for video).

### Transcript-first review

Reviewers edit the transcript directly. Saving creates a draft revision, so
nothing is ever lost: every revision is kept and you can browse the full
revision history. If someone else saved since you loaded the draft, the
conflict panel preserves your text, names both revisions, lets you open the
latest in a new tab to compare, and asks for explicit confirmation before
anything is discarded.

**Speaker rename** relabels a speaker across the whole transcript in one
draft revision: the dialog shows the exact segment count before you commit,
and renaming onto an existing speaker name merges both onto it. The
pre-rename wording stays recoverable through revision history.

### The governed workflow

Transcripts move through explicit states:

`draft -> pending -> approved`, with withdrawals and change requests in
between.

- **Submit** sends your draft for decision with an optional note.
- **Withdraw submission** pulls a pending submission back; a reason
  (10-500 characters) is required, and the content returns as a new draft.
- **Request changes** (approver, with a required reason) sends the pending
  revision back to a draft. **Approve** (approver, optional note) locks the
  revision as the approved record and completes every active assignment
  atomically.
- **Reopen** returns an approved record to a working state when that is the
  right call.

You can never decide your own submission: submitters are barred from approving or requesting changes on their own revisions, and the server enforces that independently of what the page shows.

Every command, reason, and decision is recorded in the casefile's audit and
decision history, visible from the **Governance** drawer (tabs for Policy,
Provenance, Assignments, Revisions, Decisions, and Audit).

### Export

Export is audited and policy-gated. The default export is the approved
record; a revision picker lets authorized users export any revision under
the same authority. Formats: `DOCX`, `TXT`, `MD`, `SRT`, `VTT`, `CSV`,
`TSV`, and `JSON`.

## For administrators

Administration is organized into **Accounts**, **Assignments**, **Policy**,
and **Data discipline**.

- **Accounts.** Provision and manage local accounts and roles (uploader,
  reviewer, approver, admin), and issue password resets.
- **Assignments.** Assign reviewers and approvers to recordings; assignment
  history is append-only.
- **Policy.** Set the workspace policy that can remove media and export
  capabilities over and above roles.
- **Data discipline.** Destructive controls (purge, recovery, ledger reset)
  live here, each attributing the acting admin.

### Full ledger access, read-only by default

An administrator sees every inbox row and every current casefile -
transcript, policy, provenance, assignments, revisions, decisions, audit -
plus ingest, account creation, and assignment management as native admin
duties. By default that access is **read-only oversight**: clicking through
a casefile changes nothing.

### Admin action mode (30 minutes, per recording)

To do governed work on a casefile, an admin enters an explicit action mode:
**Enter reviewer action mode** or **Enter approver action mode** from the
casefile header (the Governance drawer mirrors the approver entry when an
export needs it). Entry requires a stated purpose (10-500 characters) and
creates a record-bound session with a fixed 30-minute expiry. A persistent
banner names you, the effective role, the purpose, and the expiry, with
**Exit action mode** always one click away.

- **Reviewer action mode**: edit, save, and submit transcripts; rename
  speakers; withdraw any pending revision with a known submitter.
- **Approver action mode**: decide (approve, request changes), reopen, and
  export - including decisions on a revision you submitted yourself in
  reviewer mode.

Everything done under action mode is fully attributed in decisions and
audit, naming the acting admin, the effective role, and the session. Action
mode never changes your navigation or identity and never impersonates an
assigned user.

### Instance recovery

If accounts survive but no active administrator remains, the sign-up door
offers an operator-gated claim ceremony for a fresh admin, protected by a
single-use on-host token so a network-only attacker cannot take the
instance over. That ceremony is an operator runbook, not a user flow: see
[`docs/operators/admin-recovery.md`](./docs/operators/admin-recovery.md).

## Phones and small screens

On phones the appliance runs in a safety mode: status, inbox, read-only
casefile content, playback, and supported ingest work; governed actions
(editing, renaming speakers, submitting, decisions, export, administration,
action-mode entry) require a tablet or desktop and say so.

## Further reading

- [Behavioral contract](./DESIGN.md) - the design record this guide
  summarizes
- [`docs/operators/`](./docs/operators/) - operator runbooks (OIDC, password
  reset, folder watch, recovery, rotation)
- [README](./README.md) - deployment and development setup
