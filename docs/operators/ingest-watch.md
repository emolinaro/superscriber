# Governed folder-watch ingest lane

`scripts/ingest-watch-entry.ts` (`npm run ingest:watch`) is an ops sidecar for
watched-volume ingest. On startup and while running, each stable, supported
direct child of a drop folder enters the same governed path as a manual upload
(session -> chunks -> finalize), with no UI involvement. Use it for recorders,
renderers, and NAS mounts that hand Superscriber finished audio/video.

## Operation

```bash
SUPERSCRIBER_INGEST_WATCH_DIR=/mnt/drop \
SUPERSCRIBER_APP_BASE_URL=http://localhost:3000 \
SUPERSCRIBER_INGEST_WATCH_EMAIL=<watch-identity-email> \
SUPERSCRIBER_INGEST_WATCH_PASSWORD=<uploader-account-password> \
  npm run ingest:watch
```

Environment:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SUPERSCRIBER_INGEST_WATCH_DIR` | yes | - | Watched folder; created if missing. |
| `SUPERSCRIBER_APP_BASE_URL` | no | `http://localhost:3000` | App base URL. |
| `SUPERSCRIBER_INGEST_WATCH_EMAIL` | no | `ingest-service` at the `demo.local` placeholder domain | Service-identity email. |
| `SUPERSCRIBER_INGEST_WATCH_PASSWORD` | yes | - | That identity's password. |
| `SUPERSCRIBER_INGEST_WATCH_LANGUAGE` | no | `english` | Language hint for every ingest. |
| `SUPERSCRIBER_TRANSCRIBE_MODEL` | no | engine default | Must name a tier provisioned under the [runtime model-catalog contract](../../README.md#orchestration-modes); unprovisioned tiers are refused per file. |

Provision the ingest-service identity as a dedicated **uploader** local
account (Administration > Accounts) so watched ingest is attributable in the
audit trail. The default email is only a placeholder; the sidecar does not
create the account. The lane supports password credentials only, so run it in
`local` or `dual` auth mode. It cannot operate against an
`authentik-primary` deployment, where plain-password sign-in admits nobody;
an OIDC-only identity cannot authenticate this sidecar.

## Behavior contract

- The lane sweeps existing entries at startup and every 750 ms. Native watch
  events request extra sweeps; if native watch setup fails, polling continues.
  The sweep is non-recursive.
- A file is eligible only after its filesystem fingerprint (identity, size,
  modification time, and change time) remains unchanged for at least 1.2 s.
  Partially written files are retried until they settle; zero-byte files are
  logged and skipped.
- Supported extensions are `.wav`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`,
  `.flac`, `.opus`, `.webm`, `.mp4`, `.mov`, `.mkv`, `.mpg`, and `.mpeg`.
  Unsupported extensions are refused loudly once while that file name remains
  in the folder. One bad file never stops the batch.
- `.webm` is treated as `audio/webm` only. Video WebM is unsupported and must
  be converted to a supported video container before entering the drop folder.
- A sha256 of the full bytes is kept in memory for the run. Identical content
  under any name is logged once and skipped. The sidecar does not move or
  delete source files, and its dedupe state does not survive restart. Remove
  or move successfully queued files before restarting if duplicate recordings
  are unacceptable.
- Files are hashed and uploaded through a bounded 1 MiB buffer. A path or file
  that changes during ingest is never finalized from mixed bytes. A changed
  version becomes eligible after its new fingerprint settles, but a digest
  already observed changing in flight remains blocked until process restart.
- Lost session-creation, chunk, and finalize responses are reconciled within
  the current run. The watcher reuses the upload session and resumes from the
  server's committed byte offset instead of sending committed bytes twice.
- A `WARNING` after durable finalization means the upload is stored but backend
  dispatch failed. The watcher reports the warning and does not upload the same
  bytes again; resolve the dispatch failure from the governed record.
- An expired app session is renewed once at the request boundary before the
  current session, chunk, or finalize operation is failed and retried later.
- HTTP requests time out after 30 seconds, and active requests are cancelled
  during process shutdown so one stalled connection cannot block the lane.
- The watcher **follows symlinks** (`statSync` on directory entries), so
  anyone with write access to the drop folder can land any file the watch
  process can read as an ingest - keep the drop folder's permissions as
  locked down as the accounts table.
- Upload-session creation and durable-finalize audit events are attributed to
  the watch identity. Later automated transcription events remain
  system-attributed.
