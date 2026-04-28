# Superscriber

Superscriber is a Next.js prototype for a governed transcription workspace for sensitive audio and video.

The current app models a browser-bound workflow for regulated teams:

`record or upload -> verify -> transcribe with diarization -> review in browser -> approve server-side`

This repository is a product and architecture prototype, not a production deployment. It uses demo auth cookies, local JSON persistence, and mock orchestration by default, while keeping the core workflow and policy boundaries explicit.

## What It Includes

- Role-based entry for `uploader`, `reviewer`, `approver`, and `admin`
- Unified ingest flow for upload and recording
- Queue board organized by workflow state
- Review workspace with transcript editing, segment jumping, and governed playback
- Policy-aware approval and export controls
- Orchestration boundary with mock mode and external webhook mode
- Seeded demo data in `data/state.json`

## Tech Stack

- Next.js 16
- React 19
- TypeScript
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

## Available Scripts

- `npm run dev` — start the local development server
- `npm run build` — build the app for production
- `npm run start` — run the production build locally
- `npm test` — run the test suite once
- `npm run test:watch` — run tests in watch mode

## Project Structure

- [`app/`](./app/) — Next.js app routes and server actions
- [`src/components/`](./src/components/) — UI components
- [`src/domain/`](./src/domain/) — domain models and workflow rules
- [`src/server/`](./src/server/) — persistence, session handling, orchestration, repository layer
- [`data/`](./data/) — local demo state and uploaded media

## Orchestration Modes

By default, the app runs in mock orchestration mode.

To connect an external backend through the callback contract, configure:

- `SUPERSCRIBER_ENGINE_MODE=webhook`
- `SUPERSCRIBER_ENGINE_DISPATCH_URL`
- `SUPERSCRIBER_APP_BASE_URL`
- `SUPERSCRIBER_ENGINE_SHARED_SECRET`
- `SUPERSCRIBER_ENGINE_DISPATCH_TIMEOUT_MS` (optional)

## Current Limitations

- Authentication is demo-only and cookie-based
- Persistence is local and file-backed
- Verification and transcription are mocked unless webhook mode is configured
- The app is seeded for workflow demonstration, not multi-tenant production use

## Testing

Run:

```bash
npm test
```

Current tests cover domain policy, workflow transitions, and orchestration behavior.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
