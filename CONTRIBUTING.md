# Contributing to Superscriber

Thanks for contributing. This file covers the workflow that gets a change from your branch to a merged PR. Read [README.md](./README.md) for setup and runtime instructions, [DESIGN.md](./DESIGN.md) for the behavioral contract, [AGENTS.md](./AGENTS.md) for project orientation, and [docs/operators/](./docs/operators/) for operator runbooks - those are the authoritative sources; this document does not repeat them.

## The contribution workflow

1. **Branch off `main`.** All work happens on a feature branch; never push to the default branch.
2. **Get the local gates green.** Run each of these in your worktree, exactly as defined in `package.json`:

   ```bash
   npm run typecheck     # TypeScript checker (tsc --noEmit)
   npm test              # unit/integration suite (vitest run)
   npm run build         # production build (next build)
   npm run worker:check  # syntax-check the Python worker
   ```

   `worker:check` uses `$SUPERSCRIBER_WORKER_PYTHON` when it is non-empty, then `.venv/bin/python3` when it is executable, and finally `python3`; the README's local worker setup (`uv venv`, `uv pip install -r worker/requirements.txt`) gives you that environment. For browser-level verification of the change, see the full testing gate in the README (`npm run e2e`, `npm run e2e:container`).
3. **Create the PR through no-mistakes.** From your machine, with the change committed on your feature branch:

   ```bash
   no-mistakes axi run --intent "<what this change sets out to accomplish>"
   ```

   This drives the no-mistakes pipeline: rebase, code review, tests, lint, docs sync, push, and the PR creation itself. If the pipeline parks at an approval gate, read its findings and respond with `no-mistakes axi respond` (for example `--action approve`, or `--action fix --findings <ids>` to hand findings to the pipeline). Loop until it reports an outcome; `checks-passed` means your PR is up and validated.
4. **Merge only on the captain's word.** A green, reviewed PR still waits for the captain's explicit go-ahead before merge. Do not merge your own or anyone else's PR without it.

### no-mistakes is the validation gate

no-mistakes is the **strong** validation gate for this repo: it is the review, test, docs, push, and PR path, run end to end on the contributor's machine before anything reaches the remote. GitHub Actions are intentionally frozen fleet-wide - workflows are disabled at the GitHub level - so **do not expect CI to run on your PR**. Local gates plus the no-mistakes pipeline are the quality bar. If a step of the pipeline fails, fix the root cause, commit on the same branch, and run the pipeline again; do not bypass it with a manual push.

## Working agent-assisted is the norm

This repo is built agent-assisted. Contributing with a coding agent (running the local gates, driving `no-mistakes axi run`, iterating on pipeline findings) is the expected, ordinary way to work here - not a special mode. Work with your agent of choice, and let the no-mistakes gate, not the agent's say-so, decide when a change is ready.

## Commit style

We use [conventional commits](https://www.conventionalcommits.org/). Match the existing history (`git log --oneline -20` shows the pattern):

- `<type>(<scope>): <summary>` - types seen in history include `feat`, `fix`, `docs`, `test`, and `style`
- Scopes follow the module you touched, e.g. `feat(auth): ...`, `fix(casefile): ...`, `feat(ingest): ...`
- A bare type without a scope (`feat: add live transcription progress`) is fine when no single module fits
- Release commits prefix the version: `v0.3.0.0 feat: finalize governed casefile redesign (#2)`

Squash-merged PRs keep the commit subject plus the PR number, e.g. `fix(auth): stabilize OIDC flows under contention (#28)`.

## Sign-off

Sign-off is **not required**. The repo history has no `Signed-off-by` trailers; please don't add them.

## Security posture

Superscriber is a governed transcription appliance for sensitive media. Everything you write in issues, PRs, commits, review comments, logs, logged evidence, or other attached evidence is a permanent, public-ish record. Accordingly:

- **No PHI or customer-identifying detail** - no names, identifiers, institution details, or anything traceable to a real person or deployment.
- **No secrets** - no tokens, keys, passwords, session data, or configuration containing credentials.
- **No recording or transcript contents** - never paste or reference real media, transcripts, or excerpts, even "sanitized" ones. When you need a repro case, invent throwaway media.
- **No content leakage into tooling** - the same rules bind anything a coding agent or reviewer sees: keep sensitive content out of prompts, tickets, and screenshots you capture while testing.

When filing an issue or PR, describe behavior and system state, not people and content. When in doubt, leave it out.
