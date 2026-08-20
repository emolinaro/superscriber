## Project At A Glance

- `main` carries work toward the next release - see the `[Unreleased]` CHANGELOG section. Version source: `VERSION`; release notes: `CHANGELOG.md`.
- Doc prose never pins a current release version (captain durable rule): point to `CHANGELOG.md` for history and `VERSION` for the current number. Dated evidence ("Tested against vX" headers) keeps its versions. The docs site publishes one unversioned tree tracking latest main (flattened 2026-08-14); retired `/superscriber/next/` and `/superscriber/v0.4.0/` URLs redirect to current paths.
- Product overview, commands, and runtime: `README.md`. Design record and behavioral contract: `DESIGN.md`.
- Domain workflow rules: `src/domain/workflow.ts`. Governed commands, capabilities, action mode, and access grants: `src/server/casefile/`. Authenticated routes: `app/(authenticated)/`.
- Unmanageable-instance recovery (accounts exist, no active admin): operator-claim ceremony on the sign-up door gated by an on-host single-use token (`src/server/auth/recovery-claim.ts`, runbook `docs/operators/admin-recovery.md`).
- One-shot local deployment: `scripts/bootstrap-local.sh` (idempotent; supervisor `scripts/instance-run.sh`, model provisioning CLI `scripts/provision-model-tier.ts` over `src/server/models/provisioning.ts`). Docs: README "Local deployment".
- Speaker diarization: vendored pyannote speaker-diarization-3.1 bundle pinned in `worker/diarization-bundle.json` (single pins source read by BOTH the TS installer `src/server/models/diarization.ts` and the image-build prefetcher `worker/prefetch_diarization.py`); gated HF download happens once per home via `scripts/provision-model-tier.ts --diarization` with a run-scoped `SUPERSCRIBER_HUGGINGFACE_TOKEN`, then runs fully offline; worker attribution lives in `worker/diarization_support.py` (majority-overlap vote onto whisper segments, first-appearance Speaker N naming, always degrades to single-speaker instead of failing a job). Runbook: `docs/operators/diarization.md`.
- Full validation gate: `npm run typecheck`, `npm test`, `npm run build`, `npm run worker:check`, `npm run worker:test`, `npm run e2e`, `npm run e2e:container`.
- Internal spec/plan tree (formerly `docs/superpowers/`) is gitignored at `.fm-internal/docs-superpowers/`, local-only; DESIGN.md and other refs intentionally point there. Do not recreate `docs/superpowers/`.

## GBrain Configuration (configured by /setup-gbrain)
- Engine: pglite
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-05-01
- MCP registered: yes (Codex user config)
- Memory sync: full
- Current repo policy: read-write
- Autopilot: unloaded locally after setup because `com.gbrain.autopilot` held the PGLite lock during import/smoke verification

## Deploy Configuration (configured by /setup-deploy)
- Platform: github-actions
- Production URL: none yet
- Deploy workflow: .github/workflows/container-e2e.yml (hosted runs disabled by captain decision)
- Deploy status command: none - local/container gates are the quality bar
- Merge method: squash
- Project type: web app
- Post-deploy health check: none yet

### Custom deploy hooks
- Pre-merge: none
- Deploy trigger: none - hosted Container E2E workflow disabled by captain decision
- Deploy status: none (hosted workflow disabled; local container E2E is the gate)
- Health check: none yet

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Testing

- A foreign server answering on the e2e app port (default 3105) silently vacates the container suite; `scripts/run-e2e-appliance.sh` preflights `/api/health` and refuses to start in that case. Stop the squatter or set `SUPERSCRIBER_E2E_PORT`. See the README Testing section.
- Parallel e2e lane setup, including shared-worktree OIDC config isolation, is documented in the README Testing section.
- Fresh worktrees may lack the compiled better-sqlite3 native binding (symptom: ~190 server test failures with "Could not locate the bindings file"); fix with `npm rebuild better-sqlite3`.
- A full `e2e:container` run that fails in a mid-run cascade of unrelated specs (counted off-by-one, `ERR_CONNECTION_REFUSED` after N minutes) usually means the app container died under multi-lane host contention, not that the change broke the suite: compare against a clean main worktree baseline before attributing it.
- For host-local e2e iteration, use `bash scripts/e2e-host-lane.sh e2e/<spec>`; it packages the standalone app, worker, isolated runtime, model fixture seam, and port preflight. Fixture setup and real-transport fallback are documented in the README Testing section.
- The host lane reuses `.tmp/e2e-data.hostlane` across runs (`SUPERSCRIBER_E2E_HOST_RUN_ID` defaults to `hostlane`), so a failed run can leave recordings behind that break later same-title assertions; pass a unique `SUPERSCRIBER_E2E_HOST_RUN_ID` per run when iterating.
- The host lane runs the stub transcription engine: specs that assert engine-dependent output (e.g. `review-mobile` confidence text) need `SUPERSCRIBER_E2E_ENGINE=stub` exported when run via `scripts/e2e-host-lane.sh` (the container runner sets it itself).
- For cheap browser evidence on the casefile player, run `next dev` with `SUPERSCRIBER_ENGINE_MODE=mock` and a scratch `SUPERSCRIBER_DB_PATH`, upload a long silent WAV (see `buildSilentWavBuffer` in `e2e/support/appliance.ts`), let the mock engine finish, then lengthen the transcript by rewriting `revisions.segments_json` in SQLite (the schema accepts any segment list).
- Known pre-existing e2e failures on main (verified 2026-08-10 by baseline reruns on origin/main in container lanes): `governed-casefile.spec.ts` "withdrawal/changes/approval/export/reopen", `account-role-management` "one pending request", and the long `appliance.spec.ts` ingest umbrella fail or time out under multi-lane machine contention. Treat these as baseline flakes: baseline any suspicious e2e failure on origin/main before owning it.
- Known pre-existing unit flakes on main (verified 2026-08-15 by reruns on clean main): `scripts/bootstrap-local.test.ts` timing tests ("recovers a persisted interrupted activation", "restarts a verified live instance...", and siblings - the failing subset varies per run) and the docs runbook secret scan (`authentik-demo.md` "password:" prose pattern). Baseline before owning; the bootstrap tests may also leave untracked `.bootstrap-test-*` dirs behind.
- The desktop casefile is a bounded pinned-zone shell: everything above "Revision summary" never scrolls and the transcript segments list is the only vertical scrollport, follow-scrolled with edge anchoring (sole exception: the changes-requested banner's compact internal note scrollport inside the pinned zone). Contract: DESIGN.md casefile sections; geometry + dormant/accepted-seek follow proofs: `e2e/media-casefile-rest-state.spec.ts`; decision matrix: `src/components/casefile/follow-scroll.ts`. Never put `overscroll-behavior` containment on the transcript viewport - wheel/touch must chain outward at its edges.
- CSS `:has()` cannot nest another `:has()` (e.g. `:has(> .a:has(> .b))` silently drops the whole rule); use a flat descendant chain inside a single `:has()` instead.
- The chrome-devtools-axi bridge writes screenshots only under `/tmp` (sandboxed); it reports success even when a target path elsewhere silently does not land. Capture to a `/tmp` staging dir and copy into `.fm-internal/evidence/<task>/` yourself.
