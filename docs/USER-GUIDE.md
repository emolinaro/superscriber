# User guide

Superscriber is a self-contained governed transcription appliance for
sensitive audio and video. Every recording moves along one regulated
workflow:

`record or upload -> verify -> transcribe -> review in browser -> approve server-side`

This guide walks that workflow as four user arcs - uploader, reviewer,
approver, administrator - preceded by sign-in and followed by the phone
rules. Which arc is yours depends on the roles an administrator gave you;
accounts can hold more than one.

A word on what "governed" means before the arcs: every recording lives in a
**casefile**, a transcript-first record whose state, assignments, actions,
provenance, and audit history always stay in agreement. The server computes
what you may do on each casefile from your roles, your assignments, and the
workspace policy; the page only ever shows controls you are allowed to use.
Nothing important is silent: saves mint revisions, decisions carry their
reasons, and everything lands in the casefile's audit history.

This guide tracks the current development line (`main`), ahead of the
published release, **v0.4.0** - the Authentik OIDC identity wave. Anything
that landed after that tag (for example, governed account role management)
is covered here as it will ship in the next release; for the frozen record
of the tagged release, switch to the **v0.4.0** version in the site
header's version menu.

## Signing in

Open the appliance URL your institution gave you. What the doors look like
depends on how the instance is configured:

- **First run ever (no accounts yet).** The sign-up door is the bootstrap
  door: the first account created becomes the administrator. The door
  closes afterwards; from then on, accounts are provisioned from
  **Administration > Accounts**.
- **Local sign-in.** Enter your email and password on the sign-in door.
- **Institutional sign-in.** Deployments can offer Authentik OIDC - either
  alongside the local form (dual mode) or instead of it
  (institution-primary mode, where the local credential form is not shown
  at all).

Sessions are server-side and revocable. If an administrator changes your
roles, resets your password, or disables your account, your active sessions
end.

### Choosing a theme

The account menu offers **Light**, **Dark**, and **System** appearance
themes. The choice applies immediately, boots flash-free on your next
visit, and is stored against your account server-side - sign in from any
device and the theme follows you.

### If you forget your password

Whenever the local credential form is offered, the sign-in door links to a
password reset request. The confirmation is honest about what this instance
can do:

- If reset mail is configured, the reset link arrives by email and is valid
  for 60 minutes. Only the newest link is live, and each link works once.
- If the instance does not send email (the default posture), the
  confirmation says so plainly, and your administrator resets the password
  for you from **Administration > Accounts**. An administrator reset wins
  over any in-flight self-service reset and ends every session on the
  account immediately.

Asking for a reset alone changes nothing - no session is revoked and no
password is touched until a reset is completed.

## The uploader's arc: getting audio in

Uploaders work from two pages: **Work**, an inbox of their recordings, and
**Ingest**, where audio enters the appliance.

### Uploading and recording

The Ingest page accepts media two ways, and both ride the same resumable
transfer protocol in 1 MiB chunks: if a transfer is interrupted, resuming
picks up where it left off and never re-sends a committed byte.

- **Batch upload.** Drop or pick several files at once. A persistent
  transfer card tracks the whole batch with per-file byte progress and a
  per-file result, and stays on the page while uploads run. One bad file
  never stops the batch: the failure is reported against that file and the
  rest continue.
- **Browser audio recording.** Record directly from the page; the recording
  uses the same resumable session as an upload.

### Choosing the transcription model

Transcription runs on a faster-whisper model tier verified on the host.
Under **Advanced settings** you can pick among the tiers provisioned on
this appliance, with speed and quality notes listed beside each. If a tier
shows a **Download** action, it is in the catalog but not yet installed -
that button is an administrator self-service, covered in the admin arc.

### After the transfer finishes

Your work inbox tabs - **My uploads**, **Needs attention**, **Processing**,
**Ready** - follow each recording through verification and transcription.
While a recording transcribes, its ledger row pulses with live,
engine-derived progress, and your own status casefile shows it at source;
no refresh needed. When the transcript is ready it enters the governed
review workflow, and the appointed reviewers and approvers take it from
there.

## The reviewer's arc: transcript-first review

Reviewers work from the **Work** inbox: the **To review**, **Waiting**, and
**Completed** tabs lead to assigned casefiles. Clicking any ledger row
opens that recording's casefile.

### The player

The casefile media transport shows the decoded audio waveform, and the wave
itself is the seek surface: click or drag anywhere to jump, or use the
keyboard (left and right arrows nudge, Home and End jump to the edges).
Per-segment markers line the transcript up with the audio, the segment
currently playing is highlighted by an active band, and a timecode readout
tracks the position.

- **Click-to-play segments.** Clicking a transcript segment that is not
  playing seeks to it and plays from there.
- **Click-to-pause.** Clicking the currently playing segment pauses in
  place; clicking it again resumes from the unchanged paused position. The
  transport toggle and the Space key do exactly the same.
- **Pinned chrome, centered follow.** Transport, wave, and timecode stay
  pinned above the transcript while it scrolls, so the controls never
  scroll away. Follow scroll keeps the active segment centered as playback
  advances, yields the moment you scroll manually, and re-engages on any
  explicit seek.
- **Segment rail.** On wider layouts a numbered rail under the wave seeks
  the same segments. The rail follows playback on its own horizontal axis,
  keeping the active chip centered as the transcript centers the same
  segment. Scrolling the rail by hand pauses only the rail's follow - the
  transcript's follow is unaffected - and any explicit seek re-engages it
  immediately.

Where the browser cannot decode the audio, native media controls remain the
fallback (and always are for video).

### Editing the transcript

Edit the transcript directly in the casefile. Saving creates a draft
revision, so nothing is ever lost: every revision is kept, and **Governance
> Revisions** shows the full history. If someone else saved after you
loaded the draft, the conflict panel preserves your text, names both
revisions, offers to open the latest in a new tab for comparison, and asks
for explicit confirmation before anything is discarded.

**Speaker rename** relabels a speaker across the whole transcript in one
draft revision: the dialog shows the exact segment count before you commit,
and renaming onto an existing speaker name merges both onto it. The
pre-rename wording stays recoverable through revision history.

### Handing off for decision

When the transcript is right, **Submit for approval** sends the draft into
the governed workflow. While it is pending you can **Withdraw submission**
with a required reason (10-500 characters); the content returns to you as
a new editable draft. Your own pending work finishes in the approver's
arc - you can never approve or request changes on a revision you submitted.

## The approver's arc: decisions and export

Approvers work from the **Work** inbox, **To decide** tab. Opening a
pending casefile shows the submitted revision, its submitter, and its
timestamp, alongside the full player and transcript.

### Deciding

- **Approve** locks the revision as the approved record and completes every
  active reviewer and approver assignment atomically. An approval note is
  optional.
- **Request changes** sends the pending revision back as an editable draft
  for the original submitter, with a required reason; assignments stay
  active.
- **Reopen as draft** (on an approved record) starts a new editable draft
  cycle from the active approved revision, with a required reason.

Submitters are barred from approving or requesting changes on their own
revisions; the page hides those decision controls with an explanation, and
the server independently rejects the command. Every decision is recorded
with its reason in the casefile's **Decisions** and **Audit** history,
under the **Governance** drawer.

### Exporting

Export is audited and policy-gated. The default export is the approved
record; where you are authorized, a revision picker exports any revision
under the same authority. Formats: `DOCX`, `TXT`, `MD`, `SRT`, `VTT`,
`CSV`, `TSV`, and `JSON`. Raw media download is never available - only
governed transcript exports.

## The administrator's arc: oversight and action mode

Administrators hold a full view of the appliance - every inbox row and
every current casefile, transcript, policy, provenance, assignments,
revisions, decisions, and audit - plus ingest, account creation, and
assignment management as native duties. By default that view is **read-only
oversight**: clicking through a casefile changes nothing.

### Entering action mode

To do governed work on a casefile, enter an explicit action mode from the
casefile header: **Enter reviewer action mode** or **Enter approver action
mode**. (The **Governance** drawer mirrors the approver entry when an
export specifically needs it.)

Entry requires a stated purpose (10-500 characters) and creates a session
bound to that recording with a fixed 30-minute expiry. A persistent banner
names you, the effective role, the purpose, and the expiry, and **Exit
action mode** is always one click away.

- **Reviewer action mode**: edit, save, and submit transcripts; rename
  speakers; withdraw any pending revision with a known submitter.
- **Approver action mode**: approve, request changes, reopen, and export -
  including deciding a revision you submitted yourself in reviewer mode.

Everything done under action mode is fully attributed in decisions and
audit, naming the acting admin, the effective role, and the session. Action
mode never changes your navigation or account identity and never
impersonates an assigned user.

### Administration surfaces

The **Administration** page is organized into four sections:

- **Accounts.** Provision local accounts, set roles (uploader, reviewer,
  approver, admin), and issue password resets.
- **Assignments.** Assign reviewers and approvers to recordings; assignment
  history is append-only.
- **Policy.** Set the workspace policy, which can remove media and export
  capabilities over and above roles.
- **Data discipline.** Counts the governed ledger rows and hosts the
  typed-phrase ledger reset, attributing the acting admin.

Permanently deleting a recording lives on the recording itself: in admin
oversight the casefile's pinned action bar ends with **Delete recording**,
so it never scrolls away while you read, behind a typed-title
confirmation. The purge removes the whole casefile - revisions, decisions,
assignments, jobs, audit rows, and the media - writing a snapshot of every
removed row to disk first and leaving a single deletion record behind. Phone safety mode withholds it like every
other governed control.

### Provisioning model tiers

Tiers listed in the Ingest page's Advanced settings are host-verified.
Where a tier is in the catalog but unprovisioned, an administrator sees a
quiet inline **Download** action on that tier: one click installs it in
place, with the exact size in the label and live byte progress while it
runs. A free-space preflight refuses to start when there is not enough
disk, only one tier downloads at a time, and a failed download can be
retried; the tier becomes selectable as soon as the install completes, with
no worker restart.

### Instance recovery

If accounts survive but no active administrator remains, the sign-up door
offers an operator-gated claim ceremony for a fresh admin, protected by a
single-use on-host token so a network-only attacker cannot take the
instance over. That ceremony is an operator runbook, not a user flow: see
[`docs/operators/admin-recovery.md`](./docs/operators/admin-recovery.md).

## Phones and small screens

On phones the appliance runs in a safety mode: setup, login, session
recovery, worklists, status, authorized read-only casefile content,
playback, and supported ingest all work. Every governed mutation -
transcript editing, speaker rename, withdrawal, approval, request changes,
reopen, export, recording purge, administration changes, and action-mode
entry - is removed and guarded, with copy stating that review and decisions
require a tablet or desktop.

## Further reading

- [Behavioral contract](./DESIGN.md) - the design record this guide
  summarizes, including the precise command and capability semantics
- [`docs/operators/`](./docs/operators/) - operator runbooks (OIDC,
  password reset, folder watch, recovery, rotation)
- [README](./README.md) - deployment, local bootstrap, and development
  setup
