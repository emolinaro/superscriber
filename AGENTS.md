## Project At A Glance

- Current release on main: v0.3.0.0 (governed casefile). Version source: `VERSION`; release notes: `CHANGELOG.md`.
- Product overview, commands, and runtime: `README.md`. Design record and behavioral contract: `DESIGN.md`.
- Domain workflow rules: `src/domain/workflow.ts`. Governed commands, capabilities, action mode, and access grants: `src/server/casefile/`. Authenticated routes: `app/(authenticated)/`.
- Full validation gate: `npm run typecheck`, `npm test`, `npm run build`, `npm run worker:check`, `npm run e2e`, `npm run e2e:container`.

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

- A foreign server answering on the e2e app port (default 3105) silently vacates the container suite; `scripts/run-e2e-appliance.sh` preflights `/api/health` and refuses to start in that case — stop the squatter or set `SUPERSCRIBER_E2E_PORT`. See the README "container-backed E2E runner" section.
- Parallel e2e lanes on one host are supported: set `SUPERSCRIBER_E2E_PORT`, `SUPERSCRIBER_E2E_OIDC_PORT`, `SUPERSCRIBER_E2E_CONTAINER_NAME`, and `SUPERSCRIBER_E2E_IMAGE` to unique values per lane.
- Fresh worktrees may lack the compiled better-sqlite3 native binding (symptom: ~190 server test failures with "Could not locate the bindings file"); fix with `npm rebuild better-sqlite3`.
- A full `e2e:container` run that fails in a mid-run cascade of unrelated specs (counted off-by-one, `ERR_CONNECTION_REFUSED` after N minutes) usually means the app container died under multi-lane host contention, not that the change broke the suite: compare against a clean main worktree baseline before attributing it.
- For host-local e2e iteration, `npm run start` silently 404s static chunks (build uses `output: standalone`); serve with `node .next/standalone/server.js` after copying `.next/static` and `public` into `.next/standalone/`, then point `PLAYWRIGHT_BASE_URL` at it. Re-copy `.next/static` after EVERY rebuild (chunk hashes rotate; stale copies 404 half the chunks and the app silently stops hydrating), and set `AUTH_URL`/`NEXTAUTH_URL` to the served origin or sign-out flows die with a `chrome-error://` page. The suite's DB helpers (`queryRuntimeRows` etc.) require the app's `SUPERSCRIBER_DB_PATH` to live under `.tmp/e2e-data.*` or a tmpdir `superscriber-governed.*` root. Upload-dependent specs also need the Python worker running beside it: share `SUPERSCRIBER_ENGINE_SHARED_SECRET`, point `SUPERSCRIBER_DB_PATH`/`SUPERSCRIBER_UPLOAD_TMP_DIR` at a `.tmp/e2e-data.*` dir (the e2e helpers discover runtime roots there), and set `SUPERSCRIBER_TRANSCRIBE_MODEL=missing-e2e-model SUPERSCRIBER_TRANSCRIBE_OFFLINE=1 SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK=1` on both processes.
- Known pre-existing e2e failures on main (verified 2026-08-10 by baseline reruns on origin/main in container lanes): the first `e2e/oidc.spec.ts` dual-login test fails with `error=OAuthSignin` (tracked separately in the superscriber-e2e-ci-fix lane); additionally `governed-casefile.spec.ts` "withdrawal/changes/approval/export/reopen", `account-role-management` "one pending request", `password-reset` second reset test, `session-revocation` convergence, and the long `appliance.spec.ts` ingest umbrella fail or time out under multi-lane machine contention. Treat these as baseline flakes: baseline any suspicious e2e failure on origin/main before owning it.
