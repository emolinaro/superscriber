<p align="center">
  <img src="./app/icon.svg" alt="Superscriber logo" width="96" height="96" />
</p>

# Superscriber

Superscriber is a self-contained governed transcription appliance for sensitive audio and video.

The current app models a regulated workflow:

`record or upload -> verify -> transcribe -> review in browser -> approve server-side`

It now runs as a single-institution deployment with local accounts, SQLite persistence, mounted media storage, and an internal Python worker by default.

## What It Includes

- Bootstrap admin setup plus local accounts for `uploader`, `reviewer`, `approver`, and `admin`
- Unified resumable ingest flow for upload and recording
- Assignment-aware worklists and governed review/approval surfaces, with reviewer and approver desks unlocked only by explicit admin assignment
- Policy-gated approved transcript export in `DOCX`, `TXT`, `SRT`, `VTT`, `CSV`, `TSV`, and `JSON`
- SQLite-backed workflow persistence with mounted media storage
- Internal Python worker with GPU-preferred transcription when compatible hardware is available
- Alternate orchestration modes for `mock` and `webhook`

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- SQLite via `better-sqlite3` and Drizzle
- Auth.js credentials auth
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
- `npm run worker:check` — syntax-check the Python worker
- `npm run worker:prefetch` — download the configured speech model into the local worker cache
- `npm run worker:python` — run the Python worker against a live app

## Project Structure

- [`app/`](./app/) — Next.js app routes and APIs
- [`src/components/`](./src/components/) — UI components
- [`src/domain/`](./src/domain/) — domain models and workflow rules
- [`src/server/`](./src/server/) — auth, persistence, orchestration, ingest, and repository logic
- [`data/`](./data/) — local SQLite data, secrets, temp uploads, and media files
- [`worker/`](./worker/) — internal Python transcription worker
- [`scripts/`](./scripts/) — container/runtime helpers

## Project Docs

- [`CHANGELOG.md`](./CHANGELOG.md) — release history and shipped behavior notes
- [`DESIGN.md`](./DESIGN.md) — visual and interaction source of truth for the governed workspace
- [`TODOS.md`](./TODOS.md) — deferred follow-on work after the current appliance release
- [`AGENTS.md`](./AGENTS.md) — local automation metadata for deploy and workspace tooling

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

Current tests cover workflow rules, auth/access services, resumable ingest, the internal queue lifecycle, and orchestration behavior.
They also cover reviewer assignment gating plus approved transcript export formatting, routing, and browser download behavior.

For the browser path against the real single-image appliance:

```bash
npm run e2e:install
npm run e2e:container
```

The container-backed E2E runner deliberately builds a lightweight test image with model prefetch disabled, then starts the worker in explicit stub-fallback mode. That keeps the browser suite deterministic while still exercising the real Docker entrypoint, Next.js server, SQLite volume, upload pipeline, internal queue, and Python worker contract in one image.

Before starting, the runner probes `/api/health` on the app port (`SUPERSCRIBER_E2E_PORT`, default 3105) and refuses to proceed if anything already answers: a foreign server on that port - for example a leftover `npm run dev` - silently vacates the whole suite, because the health probe, browser, and DB helpers would all talk to it instead of the container. Stop the other server or set `SUPERSCRIBER_E2E_PORT` to a free port. Each run gets a fresh data dir under `.tmp/e2e-data.XXXXXX` that the runner removes on exit (a caller-supplied `SUPERSCRIBER_E2E_DATA_DIR` is preserved). Suite helpers that touch the database (`assignmentRows`, `auditRows`, `expireUploadSession`, `expireActionMode`) execute inside the running container via `docker exec`, because host-side access to the bind-mounted database is blocked by file ownership on Linux runners and cannot see the app's WAL commits through macOS VM file sharing.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
