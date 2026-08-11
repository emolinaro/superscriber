# Governed folder-watch ingest lane

`scripts/ingest-watch-entry.ts` (`npm run ingest:watch`) is an ops sidecar for
watched-volume ingest: every stable file that appears in a drop folder enters
the SAME governed path as a manual upload (session -> chunks -> finalize),
with no UI involvement. Use it for recorders, renderers, and NAS mounts that
hand superscriber finished audio/video.

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
| `SUPERSCRIBER_TRANSCRIBE_MODEL` | no | engine default | Must name a tier provisioned on the host (see Administration > ingest tiers); unprovisioned tiers are refused per file. |

Provision the ingest-service identity as a dedicated **uploader** local
account (Administration > Accounts) so watched ingest is attributable in the
audit trail. The lane signs in with email/password, so it requires an auth
profile that still admits local credentials - in `authentik-primary` mode
password sign-in admits nobody (run the sidecar against a local/dual
profile, or provision the identity under OIDC and upload manually).

## Behavior contract

- A new file is ingested only after its size has been stable for ~1.2 s
  (partially-written renders are retried until they settle).
- Dupes by content: a sha256 of the full bytes is kept in-memory for the
  run; identical content arriving under any name is logged once and skipped.
- Unsupported extensions are refused loudly once per file name; the lane
  never dies on a bad file - per-file failures are logged and isolated.
- `.webm` is treated as `audio/webm` only. Video WebM is unsupported and must
  be converted to a supported video container before entering the drop folder.
- Files are hashed and uploaded through a bounded 1 MiB buffer. A file that
  changes during either pass is left unfinalized and retried after it settles.
- An expired app session is renewed once at the request boundary before the
  current session, chunk, or finalize operation is failed and retried later.
- HTTP requests time out after 30 seconds, and active requests are cancelled
  during process shutdown so one stalled connection cannot block the lane.
- The watcher **follows symlinks** (`statSync` on directory entries), so
  anyone with write access to the drop folder can land any file the watch
  process can read as an ingest - keep the drop folder's permissions as
  locked down as the accounts table.
- All ingest actions appear in the casefile audit trail attributed to the
  watch identity.
