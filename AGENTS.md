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
- Deploy workflow: .github/workflows/container-e2e.yml
- Deploy status command: gh run list --workflow "Container E2E" --branch main --limit 1
- Merge method: squash
- Project type: web app
- Post-deploy health check: none yet

### Custom deploy hooks
- Pre-merge: none
- Deploy trigger: automatic on push to main
- Deploy status: GitHub Actions workflow status for Container E2E on main
- Health check: none yet

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Testing

- A foreign server answering on the e2e app port (default 3105) silently vacates the container suite; `scripts/run-e2e-appliance.sh` preflights `/api/health` and refuses to start in that case — stop the squatter or set `SUPERSCRIBER_E2E_PORT`. See the README "container-backed E2E runner" section.
