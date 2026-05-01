## GBrain Configuration (configured by /setup-gbrain)
- Engine: pglite
- Config file: ~/.gbrain/config.json (mode 0600)
- Setup date: 2026-04-29
- MCP registered: no
- Memory sync: full
- Current repo policy: read-write

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
