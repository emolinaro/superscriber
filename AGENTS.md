## Project At A Glance

- Current release on main: v0.4.0 (Authentik OIDC identity wave with break-glass access and governed account roles). Version source: `VERSION`; release notes: `CHANGELOG.md`.
- Product overview, commands, and runtime: `README.md`. Design record and behavioral contract: `DESIGN.md`.
- Domain workflow rules: `src/domain/workflow.ts`. Governed commands, capabilities, action mode, and access grants: `src/server/casefile/`. Authenticated routes: `app/(authenticated)/`.
- Unmanageable-instance recovery (accounts exist, no active admin): operator-claim ceremony on the sign-up door gated by an on-host single-use token (`src/server/auth/recovery-claim.ts`, runbook `docs/operators/admin-recovery.md`).
- One-shot local deployment: `scripts/bootstrap-local.sh` (idempotent; supervisor `scripts/instance-run.sh`, model provisioning CLI `scripts/provision-model-tier.ts` over `src/server/models/provisioning.ts`). Docs: README "Local deployment".
- Full validation gate: `npm run typecheck`, `npm test`, `npm run build`, `npm run worker:check`, `npm run e2e`, `npm run e2e:container`.
- Internal spec/plan tree (formerly `docs/superpowers/`) is gitignored at `.fm-internal/docs-superpowers/`, local-only; DESIGN.md and other refs intentionally point there. Do not recreate `docs/superpowers/`. See `docs/superpowers-relocated.md`.

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
- The host lane runs the stub transcription engine: specs that assert engine-dependent output (e.g. `review-mobile` confidence text) need `SUPERSCRIBER_E2E_ENGINE=stub` exported when run via `scripts/e2e-host-lane.sh` (the container runner sets it itself).
- For cheap browser evidence on the casefile player, run `next dev` with `SUPERSCRIBER_ENGINE_MODE=mock` and a scratch `SUPERSCRIBER_DB_PATH`, upload a long silent WAV (see `buildSilentWavBuffer` in `e2e/support/appliance.ts`), let the mock engine finish, then lengthen the transcript by rewriting `revisions.segments_json` in SQLite (the schema accepts any segment list).
- Known pre-existing e2e failures on main (verified 2026-08-10 by baseline reruns on origin/main in container lanes): `governed-casefile.spec.ts` "withdrawal/changes/approval/export/reopen", `account-role-management` "one pending request", and the long `appliance.spec.ts` ingest umbrella fail or time out under multi-lane machine contention. Treat these as baseline flakes: baseline any suspicious e2e failure on origin/main before owning it.
