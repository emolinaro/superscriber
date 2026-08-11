<p align="center">
  <img src="./app/icon.svg" alt="Superscriber logo" width="96" height="96" />
</p>

# Superscriber

Superscriber is a self-contained governed transcription appliance for sensitive audio and video. The current release is v0.3.0.0 (see [CHANGELOG.md](./CHANGELOG.md)).

The app models a regulated workflow:

`record or upload -> verify -> transcribe -> review in browser -> approve server-side`

It runs as a single-institution deployment with local accounts, SQLite persistence, mounted media storage, and an internal Python worker by default. The authenticated product is organized as a governed casefile: a role-aware work inbox leads into a transcript-first record whose state, assignment, actions, provenance, and audit history stay in agreement.

## What It Includes

- Bootstrap admin setup plus local accounts for `uploader`, `reviewer`, `approver`, and `admin`
- Optional institutional sign-in via Authentik OIDC (local, dual, or authentik-primary deployment modes) with live-revocable server-side sessions and a management-boundary break-glass account - operator runbooks in [`docs/operators/`](./docs/operators/)
- Password reset for lost local credentials: self-service reset links and an audited administrator reset - reset mail is opt-in (`SUPERSCRIBER_RESET_MAIL_MODE`), otherwise resets run operator-assisted ([`docs/operators/password-reset.md`](./docs/operators/password-reset.md))
- Role-aware work inbox ledgers (tabbed per role) and a transcript-first casefile for review
- Live, engine-derived transcription progress in work ledgers and uploader status casefiles
- Governed decision commands - save draft, submit, withdraw submission, request changes, approve, reopen - with the submitter barred from deciding their own revision
- Admin read-only oversight by default, plus an explicit, record-bound, audited reviewer/approver action mode for casefile work
- Append-only assignment history, with approval completing all active assignments atomically
- Unified resumable ingest (1 MiB chunks) for upload and browser audio recording, with host-verified faster-whisper model selection under Advanced settings
- Audited, policy-gated transcript export in `DOCX`, `TXT`, `MD`, `SRT`, `VTT`, `CSV`, `TSV`, and `JSON` - defaulting to the approved record, with revision-picker export of any revision under the same authority
- Phone safety mode: status, inbox, read-only casefile, and supported ingest on phones; governed actions require a tablet or desktop
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

**Administration > Policy** lets an administrator switch the workspace policy profile (strict vs reviewable-approved-export); every change is applied immediately and audited with actor and before/after. **Administration > Data discipline** counts the governed ledger rows and hosts the typed-phrase (`RESET REQUIRED`) ledger reset, and each casefile shows administrators a **Danger zone** with a typed-title permanent purge. Both destructive controls write a JSON snapshot of every row they are about to delete into `data/ledger-snapshots/` (row-level copies outside the database, mode `0600`) before the delete transaction runs, and each leaves exactly one surviving security record (`ledger.reset` / `recording.deleted`) that names the snapshot path.

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
SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=1 npm run worker:prefetch
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
- Runtime model downloads are disabled by default. If you skip the prefetch step, set `SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=1` before starting the worker.
- If you only want the browser workflow without the real speech stack, use `SUPERSCRIBER_ENGINE_MODE=mock` for the app instead of running the Python worker.

## Container Runtime

Build the appliance image:

```bash
docker build -t superscriber .
```

Run it with a mounted data volume:

```bash
docker run --rm -p 3000:3000 -v "$(pwd)/data:/app/data" superscriber
```

The container starts the Next.js server and the internal Python worker together. By default it uses:

- `SUPERSCRIBER_ENGINE_MODE=internal`
- SQLite at `/app/data/superscriber.db`
- media files in `/app/data/media`
- upload temp files in `/app/data/uploads`
- a baked offline transcription model at `/app/models`
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
- `npm run auth:revoke` - revoke all sessions for a user (incident response)
- `npm run break-glass:designate` - designate the single break-glass admin
- `npm run break-glass:transfer` - atomically transfer the break-glass designation
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
- [`scripts/`](./scripts/) — container/runtime helpers and operator auth commands (identity import, session revoke, break-glass)

## Project Docs

- [`CHANGELOG.md`](./CHANGELOG.md) — release history and shipped behavior notes
- [`DESIGN.md`](./DESIGN.md) — design record and behavioral contract for the governed casefile workspace
- [`TODOS.md`](./TODOS.md) — deferred follow-on work after the current appliance release
- [`docs/operators/`](./docs/operators/) - operator runbooks for Authentik OIDC deployment, identity linking, break-glass, the no-mail profile, password reset, and auth outage and rollback

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

`SUPERSCRIBER_TRANSCRIBE_MODEL` names the configured worker default. The ingest model catalog checks `SUPERSCRIBER_TRANSCRIBE_MODEL_DIR` on every request and treats a tier as provisioned only when `<model-dir>/<tier>/model.bin` and `<model-dir>/<tier>/config.json` both exist. When you override the model directory, give the app and worker the same value. Advanced settings disables every unprovisioned tier; it initially selects the configured model when that tier is provisioned, or the best-quality provisioned tier otherwise.

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

Current tests cover the governed casefile command surface (save, submit, withdraw, request changes, approve, reopen, export), capabilities and access grants, assignment semantics and admin action mode, work-inbox read models, auth and bootstrap, resumable ingest, the internal queue lifecycle, and orchestration behavior.
The browser suites cover governed-casefile flows end to end, responsive and phone-safety behavior, mobile review regressions, password reset, and axe accessibility checks across auth, work inbox, casefile, export, and administration surfaces. Dual-auth OIDC sign-in, session revocation, and the break-glass ceremony run against a canonical fake OIDC provider that also runs as a network-namespace sidecar in the container suite. Setting `SUPERSCRIBER_E2E_RESET_MAIL=smtp` additionally starts a fake-SMTP sidecar on the same pattern and enables the password-reset mail suite; the default run keeps the reset-mail seam off and exercises the operator-assisted path.

For the browser path against the real single-image appliance:

```bash
npm run e2e:install
npm run e2e:container
```

The container-backed E2E runner deliberately builds a lightweight test image with model prefetch disabled, then starts the worker in explicit stub-fallback mode. That keeps the browser suite deterministic while still exercising the real Docker entrypoint, Next.js server, SQLite volume, upload pipeline, internal queue, and Python worker contract in one image.

Before starting, the runner probes `/api/health` on the app port (`SUPERSCRIBER_E2E_PORT`, default 3105) and refuses to proceed if anything already answers: a foreign server on that port - for example a leftover `npm run dev` - silently vacates the whole suite, because the health probe, browser, and DB helpers would all talk to it instead of the container. Stop the other server or set `SUPERSCRIBER_E2E_PORT` to a free port. The runner also refuses to start when the fake-OIDC sidecar port (`SUPERSCRIBER_E2E_OIDC_PORT`, default 4105) is already occupied; the container suite runs in `dual` auth mode against that sidecar. With `SUPERSCRIBER_E2E_RESET_MAIL=smtp`, the runner likewise refuses to start when the fake-SMTP control port (`SUPERSCRIBER_E2E_SMTP_CONTROL_PORT`, default 4206) is already occupied. Each run gets a fresh data dir under `.tmp/e2e-data.XXXXXX` that the runner removes on exit (a caller-supplied `SUPERSCRIBER_E2E_DATA_DIR` is preserved). Suite helpers that touch the database (`assignmentRows`, `auditRows`, `expireUploadSession`, `expireActionMode`) execute inside the running container via `docker exec`, because host-side access to the bind-mounted database is blocked by file ownership on Linux runners and cannot see the app's WAL commits through macOS VM file sharing.

Known slow-runner flake classes seen on loaded macOS/CI hosts in the container lane:

- runtime-root discovery ("No fresh Superscriber runtime root")
- readonly-db host writes to the bind-mounted SQLite database
- navigation-commit stalls (server answers 200 but the page segment never materializes after a client-side navigation)

These are contention flakes, not content bugs; re-run with artifacts attached (CI uploads Playwright `test-results/` on every failing run).

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
