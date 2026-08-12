<p align="center">
  <img src="./app/icon.svg" alt="Superscriber logo" width="96" height="96" />
</p>

# Superscriber

Superscriber is a self-contained governed transcription appliance for sensitive audio and video. The current release is v0.4.0 (see [CHANGELOG.md](./CHANGELOG.md)).

The app models a regulated workflow:

`record or upload -> verify -> transcribe -> review in browser -> approve server-side`

It runs as a single-institution deployment with local accounts, SQLite persistence, mounted media storage, and an internal Python worker by default. The authenticated product is organized as a governed casefile: a role-aware work inbox leads into a transcript-first record whose state, assignment, actions, provenance, and audit history stay in agreement.

The public authentication landing page footer always links back to this repository as the source and governance home (`Source & governance: github.com/emolinaro/superscriber`); an optional hosted user-guide link appears there only when the operator configures `SUPERSCRIBER_DOCS_URL` (see [Container Runtime](#container-runtime)).

## What It Includes

- Bootstrap admin setup plus local accounts for `uploader`, `reviewer`, `approver`, and `admin`
- Optional institutional sign-in via Authentik OIDC (local, dual, or authentik-primary deployment modes) with live-revocable server-side sessions and a management-boundary break-glass account - operator runbooks in [`docs/operators/`](./docs/operators/)
- Password reset for lost local credentials: self-service reset links and an audited administrator reset - reset mail is opt-in (`SUPERSCRIBER_RESET_MAIL_MODE`), otherwise resets run operator-assisted ([`docs/operators/password-reset.md`](./docs/operators/password-reset.md))
- Unmanageable-instance recovery: if accounts survive but no active administrator remains, the sign-up door offers an operator-gated claim ceremony for a fresh admin, protected by a single-use on-host claim token so a network-only attacker without the host proof cannot take the instance over ([`docs/operators/admin-recovery.md`](./docs/operators/admin-recovery.md))
- Role-aware work inbox ledgers (tabbed per role) and a transcript-first casefile for review
- Live, engine-derived transcription progress in work ledgers and uploader status casefiles
- Decoded-waveform media transport on the casefile: the drawn wave is the real seek surface (click, drag, and keyboard seeking) with per-segment markers, an active-segment band, and a timecode readout. Transcript segments are click-to-play: clicking a non-active segment seeks and plays it, clicking the currently playing segment pauses in place, and clicking it again resumes from the unchanged paused position - with Space parity on the transport toggle. Native controls remain the fallback for video and undecodable audio
- Governed casefile commands - save draft, batch speaker rename with a confirmed count summary (renaming onto an existing name merges both), submit, withdraw submission, request changes, approve, reopen - with non-admin submitters barred from approving or requesting changes on their own revisions; see the [behavioral contract](./DESIGN.md#revision-and-decision-commands)
- Admin read-only oversight by default, plus an explicit, record-bound, audited reviewer/approver action mode across every casefile; see [admin oversight and action mode](./DESIGN.md#admin-oversight-and-action-mode)
- Append-only assignment history, with approval completing all active assignments atomically
- Unified resumable ingest (1 MiB chunks) for upload and browser audio recording, with host-verified faster-whisper model selection under Advanced settings; admins can install unprovisioned model tiers in place with a one-click Download per tier (exact size, live byte progress, no appliance restart)
- Batch multi-file upload: drop several files into one submission and track them on a persistent transfer card with per-file byte progress and per-file results; each file rides the same resumable 1 MiB session protocol, and one bad file never stops the batch
- Governed folder-watch ingest lane for unattended operator-managed intake from a watched directory ([`docs/operators/ingest-watch.md`](./docs/operators/ingest-watch.md))
- Audited, policy-gated transcript export in `DOCX`, `TXT`, `MD`, `SRT`, `VTT`, `CSV`, `TSV`, and `JSON` - defaulting to the approved record, with revision-picker export of any revision under the same authority
- Phone safety mode: status, inbox, read-only casefile, and supported ingest on phones; governed actions require a tablet or desktop
- Light, Dark, and System appearance themes with a flash-free boot and a per-user preference persisted server-side so the choice follows the account across devices
- SQLite-backed workflow persistence with mounted media storage
- Internal Python worker with GPU-preferred transcription when compatible hardware is available
- Alternate orchestration modes for `mock` and `webhook`

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- SQLite via `better-sqlite3` and Drizzle
- Auth.js credentials auth, with optional Authentik OIDC for institutional sign-in
- Python worker runtime
- Vitest

## Local deployment

One command takes a fresh machine from a clean clone to a running,
crash-supervised local instance:

```bash
scripts/bootstrap-local.sh
```

The bootstrap is idempotent and safe to re-run. It:

1. Requires exactly Node 24.18.1, the `NODE_BASE_IMAGE` version pinned at
   `Dockerfile:4`, plus npm and Python >= 3.10 with venv/ensurepip support,
   failing loudly with an install hint when anything is missing
2. Runs `npm ci` and creates the transcription worker's Python virtual
   environment from `worker/requirements.txt` inside the immutable deployment
   generation, so rollback restores the matching worker dependencies
3. Initializes the database through the repo migration chain
   (`scripts/ensure-db.ts`) into the instance's durable data directory -
   never `/tmp`
4. Provisions a faster-whisper model tier through the same pinned-artifact
   install flow the in-app picker uses
   (`src/server/models/provisioning.ts` via
   `scripts/provision-model-tier.ts`). Interactive runs offer the full tier
   menu (default: the catalog default `small`); `--skip-model-download`
   preserves an explicit or previously configured tier and verifies its cache,
   so re-runs work offline without silently changing models
5. Builds and atomically publishes an immutable standalone production bundle
   under the instance root, then launches app + worker from that bundle under
   a SIGTERM-stoppable crash-restart supervisor with per-role logs and bounded
   backoff (`scripts/instance-run.sh`). Bootstrap waits for both app health and
   the worker's offline-model readiness signal before reporting success

Options: `--instance-root DIR` (default `~/.local/share/superscriber`),
`--port N` (default `3000`; valid range `1024-65535`),
`--model-tier TIER`, `--skip-model-download`, `--skip-worker-deps`, and
`--check-deps-only` for a preflight without changing the instance.

Instance layout (all under the instance root): `.superscriber-instance`
(bootstrap ownership marker), `app.env` (the atomic active deployment record),
`rollback.env` (the prior deployment record), `secrets/`
(auth + engine secrets, mode `0600`, never printed), `data/`
(SQLite database, media, uploads), `model-cache/` (model tiers), `logs/`
(`app.log`, `worker.log`, `supervisor.log`), `pids/`, and immutable `build/`
bundles selected by the active deployment record. A successful re-run retains
the active bundle and one rollback bundle, each with its own worker venv.
Interrupted staging generations are swept under the lifecycle locks before a
new build starts. Existing managed directories and
leaf files, including database/WAL files, secrets, logs, PID/readiness files,
and model-tier directories, must not be symlinks; bootstrap refuses them
before writing. Standard interpreter symlinks created inside a generation's
`venv/bin/` and the standard `venv/lib64 -> lib` link are allowed, but each
`venv` root and every nonstandard venv path must be real.

Operate the instance:

```bash
scripts/instance-stop.sh [INSTANCE_ROOT]   # SIGTERM the supervisor
scripts/instance-run.sh [INSTANCE_ROOT]    # start again (idempotent)
```

First-run admin: open the printed URL - with no accounts yet, the sign-up
door is the bootstrap door, so the first account created becomes the
administrator. The door closes afterwards; admins then provision further
accounts from **Administration > Accounts**.

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Start the development server:

```bash
npm run dev
```

3. Open the app:

```text
http://localhost:3000
```

For UI-only development, that is enough. For the default internal transcription path on a local non-Docker deployment, you also need the Python worker setup below.

### Account role administration

On a tablet or desktop, an administrator can open **Administration > Accounts** and choose a role from any account row, including their own. A changed selection requires a 10-500 character reason and an explicit **Save role** or **Cancel** action. The server rejects a final-active-admin demotion, a break-glass custodian demotion, or a change that conflicts with active assignments and explains the required recovery step.

A successful save atomically records the role-change audit, increments the account's authorization version, and revokes all of that account's active sessions. The affected person must sign in again. Phone safety mode keeps the same account facts visible but does not render role or other administration mutation controls.

### Data discipline and destructive controls

**Administration > Policy** lets an administrator switch the workspace policy profile (strict vs reviewable-approved-export); every change is applied immediately and audited with actor and before/after. **Administration > Data discipline** counts the governed ledger rows and hosts the typed-phrase (`RESET REQUIRED`) ledger reset, and each casefile pins a **Delete recording** control in its state action bar for administrators, with a typed-title permanent purge. Both destructive controls write a JSON snapshot of every row they are about to delete into `data/ledger-snapshots/` (row-level copies outside the database, mode `0600`) before the delete transaction runs, and each leaves exactly one surviving security record (`ledger.reset` / `recording.deleted`) that names the snapshot path.

## Local Non-Docker Runtime

The default appliance mode uses a separate Python worker process. On a local host, install its dependencies into a `uv`-managed virtual environment and run it alongside the Next.js app.

1. Install the Node.js dependencies:

```bash
npm install
```

2. Create and activate a Python virtual environment with `uv`:

```bash
uv venv
source .venv/bin/activate
```

3. Install the worker dependencies:

```bash
uv pip install -r worker/requirements.txt
```

4. Optional but recommended: prefetch the local speech model while network access is available:

```bash
npm run worker:prefetch
```

5. In one terminal, start the app:

```bash
npm run dev
```

6. In a second terminal, activate the same virtual environment and start the worker:

```bash
source .venv/bin/activate
SUPERSCRIBER_APP_BASE_URL=http://127.0.0.1:3000 npm run worker:python
```

Local worker notes:

- The worker defaults to `SUPERSCRIBER_ENGINE_MODE=internal`, `SUPERSCRIBER_APP_BASE_URL=http://127.0.0.1:3000`, and model storage under `./models`.
- A local, non-container worker permits a missing configured model to download at runtime by default. For a strictly offline worker, prefetch first, then set `SUPERSCRIBER_TRANSCRIBE_OFFLINE=1` and `SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0`.
- If you only want the browser workflow without the real speech stack, use `SUPERSCRIBER_ENGINE_MODE=mock` for the app instead of running the Python worker.

## Container Runtime

Build the appliance image:

```bash
docker build -t superscriber .
```

Run it with a mounted data volume:

```bash
docker run --rm -p 3000:3000 \
  -v "$(pwd)/data:/app/data" \
  -v superscriber-models:/app/models \
  superscriber
```

The container starts the Next.js server and the internal Python worker together. By default it uses:

- `SUPERSCRIBER_ENGINE_MODE=internal`
- SQLite at `/app/data/superscriber.db`
- media files in `/app/data/media`
- upload temp files in `/app/data/uploads`
- a baked offline transcription model plus persistent in-app model installs in the `superscriber-models` volume at `/app/models`
- `SUPERSCRIBER_TRANSCRIBE_OFFLINE=1`
- `SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0`

If CUDA libraries and a compatible GPU are available to the container, the worker prefers GPU transcription automatically. Otherwise it falls back to CPU.

You can choose a different baked model at build time:

```bash
docker build \
  --build-arg SUPERSCRIBER_TRANSCRIBE_MODEL=tiny \
  -t superscriber .
```

The default build prefetches the configured model into the image. Runtime downloads are disabled by default so the appliance can transcribe without network access after the image is built.

Optional configuration:

- `SUPERSCRIBER_DOCS_URL` - opt-in switch for the hosted user-guide link in the authentication landing footer, the same footer that always carries `Source & governance: github.com/emolinaro/superscriber`. The guide link renders only when the variable is set to a valid http(s) URL; unset (the default) or an invalid value renders nothing and leaves no dead link. The guide is expected to go live after docs PR #6 (the GitHub Pages site) merges and Pages is enabled; once live, set it (for example `SUPERSCRIBER_DOCS_URL=https://emolinaro.github.io/superscriber/`) and the guide link renders next to the source repository link.

## Available Scripts

- `npm run dev` — start the local development server
- `npm run build` — build the app for production
- `npm run start` — run the production build locally
- `npm run typecheck` — run the TypeScript checker
- `npm test` — run the test suite once
- `npm run test:watch` — run tests in watch mode
- `npm run e2e` — run the Playwright suite against an already-running app
- `npm run e2e:install` — install the local Chromium browser for Playwright
- `npm run e2e:container` — build and test the single Docker image end to end
- `npm run identity:import` - dry-run or apply Authentik identity-link mappings
- `npm run ingest:watch` - run governed folder-watch ingest ([operator runbook](./docs/operators/ingest-watch.md))
- `npm run auth:revoke` - revoke all sessions for a user (incident response)
- `npm run break-glass:designate` - designate the single break-glass admin
- `npm run break-glass:transfer` - atomically transfer the break-glass designation
- `npm run bootstrap:local` - bootstrap or update a durable local instance
- `npm run worker:check` — syntax-check the Python worker
- `npm run worker:prefetch` — download the configured speech model into the local worker cache
- `npm run worker:python` — run the Python worker against a live app

## Project Structure

- [`app/`](./app/) — Next.js app routes and APIs
- [`src/components/`](./src/components/) — UI components grouped by surface (auth, work inbox, ingest, casefile, administration, shell)
- [`src/domain/`](./src/domain/) — domain models and workflow rules
- [`src/server/`](./src/server/) — auth, access, persistence, ingest, orchestration, casefile, and work-inbox logic
- [`data/`](./data/) — local SQLite data, secrets, temp uploads, and media files
- [`worker/`](./worker/) — internal Python transcription worker
- [`scripts/`](./scripts/) - container/runtime helpers, operator commands, and governed folder-watch ingest

## Project Docs

- [`CHANGELOG.md`](./CHANGELOG.md) — release history and shipped behavior notes
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) - contribution workflow, validation gate, commit style, and disclosure rules
- [`DESIGN.md`](./DESIGN.md) — design record and behavioral contract for the governed casefile workspace
- [`TODOS.md`](./TODOS.md) — deferred follow-on work after the current appliance release
- [`docs/operators/`](./docs/operators/) - operator runbooks for authentication and account recovery, including [governed folder-watch ingest](./docs/operators/ingest-watch.md)

## Orchestration Modes

By default, the app runs in internal orchestration mode.

- `SUPERSCRIBER_ENGINE_MODE=internal` starts the local Python worker contract
- `SUPERSCRIBER_ENGINE_MODE=mock` keeps the deterministic in-process mock engine
- `SUPERSCRIBER_ENGINE_MODE=webhook` dispatches to an external backend through the callback contract

For the internal worker, the main model/runtime controls are:

- `SUPERSCRIBER_TRANSCRIBE_MODEL`
- `SUPERSCRIBER_TRANSCRIBE_MODEL_DIR`
- `SUPERSCRIBER_TRANSCRIBE_DEVICE=auto|cpu|cuda`
- `SUPERSCRIBER_TRANSCRIBE_OFFLINE`
- `SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD`
- `SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK`

`SUPERSCRIBER_TRANSCRIBE_MODEL` names the configured worker default. The ingest model catalog checks `SUPERSCRIBER_TRANSCRIBE_MODEL_DIR` on every request and treats a tier as provisioned only when every regular file in the complete pinned artifact set has its exact pinned byte size from `TIER_DOWNLOADS.fileSizeBytes`: `<model-dir>/<tier>/model.bin`, `config.json`, `tokenizer.json`, and the tier's `vocabulary.txt` or `vocabulary.json`. The standard local commands default to `models/`, while the supplied container sets `/app/models`; when you override the directory, give the app and worker the same value. Advanced settings disables every unprovisioned tier and always preselects the highest-quality provisioned tier, even when the configured model is itself provisioned.

Unprovisioned tiers can be installed straight from the picker: admins outside phone-safety mode get a quiet inline, underlined Download action per tier with the exact size in its label and live byte progress. The server fetches the faster-whisper artifact set (`model.bin`, `config.json`, `tokenizer.json`, and the tier's vocabulary file) from pinned huggingface.co repository and commit URLs into the configured model directory. It stages the complete tier before revealing it, removes partial files after a failure, and needs no worker restart; the tier becomes selectable as soon as the install completes. A free-space preflight rejects the start with HTTP 507 before any download, and only one tier can download at a time, with concurrent starts rejected by HTTP 409. Failures keep the server error on screen next to a retry. `POST /api/models/provisioning` is admin-only; `GET /api/models/provisioning` reports per-tier state to any signed-in account. The only outbound network surface this adds is the pinned huggingface.co artifact URLs.

Prefetch another supported tier into the shared model directory by setting it for the prefetch command, for example:

```bash
SUPERSCRIBER_TRANSCRIBE_MODEL=tiny npm run worker:prefetch
```

The selected tier is stored with the recording, included as `transcriptModel` in internal-worker claims, and exposed as `recording.transcriptModel` in webhook dispatches. If a stored override can no longer be provisioned or cannot be loaded, the internal worker falls back to its configured default and says so in the revision summary; the configured default itself remains load-or-fail. Explicit stub mode also identifies its fallback in the summary.

For webhook mode, configure:

- `SUPERSCRIBER_ENGINE_DISPATCH_URL`
- `SUPERSCRIBER_APP_BASE_URL`
- `SUPERSCRIBER_ENGINE_SHARED_SECRET`
- `SUPERSCRIBER_ENGINE_DISPATCH_TIMEOUT_MS` (optional)

## Current Limitations

- GPU acceleration depends on compatible host/runtime support being available to the worker process
- Diarization is still degraded; the worker currently produces a transcript-first result without full speaker separation
- This is still a single-institution appliance, not a shared multi-tenant SaaS deployment

## Testing

Run:

```bash
npm test
```

Current tests cover the governed casefile command surface (save, batch speaker rename, submit, withdraw, request changes, approve, reopen, export), capabilities and access grants, assignment semantics and admin action mode, work-inbox read models, auth and bootstrap, resumable ingest, the internal queue lifecycle, and orchestration behavior.
The browser suites cover governed-casefile flows end to end, responsive and phone-safety behavior, mobile review regressions, password reset, and axe accessibility checks across auth, work inbox, casefile, export, and administration surfaces. Dual-auth OIDC sign-in, session revocation, and the break-glass ceremony run against a canonical fake OIDC provider that also runs as a network-namespace sidecar in the container suite. Setting `SUPERSCRIBER_E2E_RESET_MAIL=smtp` additionally starts a fake-SMTP sidecar on the same pattern and enables the password-reset mail suite; the default run keeps the reset-mail seam off and exercises the operator-assisted path.

For the browser path against the real single-image appliance:

```bash
npm run e2e:install
npm run e2e:container
```

The container-backed E2E runner deliberately builds a lightweight test image with model prefetch disabled, then starts the worker in explicit stub-fallback mode. That keeps the browser suite deterministic while still exercising the real Docker entrypoint, Next.js server, SQLite volume, upload pipeline, internal queue, and Python worker contract in one image.

The model-provisioning browser specs use the test-only `SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR` seam. When `<dir>/<tier>/` contains a tier's complete pinned file set, that request copies the fixture from disk; removing the fixture restores the real pinned huggingface.co transport on the next request. Set the variable on both the app and Playwright processes for a host-local lane. The container runner configures it automatically. Never set it in production.

Before starting, the runner probes `/api/health` on the app port (`SUPERSCRIBER_E2E_PORT`, default 3105) and refuses to proceed if anything already answers: a foreign server on that port - for example a leftover `npm run dev` - silently vacates the whole suite, because the health probe, browser, and DB helpers would all talk to it instead of the container. Stop the other server or set `SUPERSCRIBER_E2E_PORT` to a free port. The runner also refuses to start when the fake-OIDC sidecar port (`SUPERSCRIBER_E2E_OIDC_PORT`, default 4105) is already occupied; the container suite runs in `dual` auth mode against that sidecar. With `SUPERSCRIBER_E2E_RESET_MAIL=smtp`, the runner likewise refuses to start when the fake-SMTP control port (`SUPERSCRIBER_E2E_SMTP_CONTROL_PORT`, default 4206) is already occupied. Each run gets a fresh data dir under `.tmp/e2e-data.XXXXXX` that the runner removes on exit (a caller-supplied `SUPERSCRIBER_E2E_DATA_DIR` is preserved). Suite helpers that touch the database (`assignmentRows`, `auditRows`, `expireUploadSession`, `expireActionMode`) execute inside the running container via `docker exec`, because host-side access to the bind-mounted database is blocked by file ownership on Linux runners and cannot see the app's WAL commits through macOS VM file sharing.

Parallel container lanes on one host must use unique values for `SUPERSCRIBER_E2E_PORT`, `SUPERSCRIBER_E2E_OIDC_PORT`, `SUPERSCRIBER_E2E_CONTAINER_NAME`, and `SUPERSCRIBER_E2E_IMAGE`. Lanes that share one worktree must also set a unique `SUPERSCRIBER_E2E_OIDC_DIR`, such as `.tmp/e2e-oidc-config-lane-a`; the override must resolve below the worktree's `.tmp` directory and cannot be `.tmp` itself. The runner recreates that directory on every start, so sharing it would rewrite the OIDC configuration bind-mounted into another lane's app container.

Known slow-runner flake classes seen on loaded macOS/CI hosts in the container lane:

- runtime-root discovery ("No fresh Superscriber runtime root")
- readonly-db host writes to the bind-mounted SQLite database
- navigation-commit stalls (server answers 200 but the page segment never materializes after a client-side navigation)

These are contention flakes, not content bugs; re-run with artifacts attached (CI uploads Playwright `test-results/` on every failing run).

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
