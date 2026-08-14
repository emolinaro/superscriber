#!/usr/bin/env bash
# Stage the Docusaurus docs content for the GitHub Pages site.
#
# The project docs intentionally stay where they are (README.md, DESIGN.md,
# docs/operators/, ...). Docusaurus needs one docs root, so this script
# derives website/content/ from the tracked sources: files are copied
# verbatim except for link retargeting in the DERIVED copies only, so repo
# browsing (directory links to ./app/, ./src/, ...) keeps working while the
# published site points those links at GitHub. Never edit website/content/
# directly - it is regenerated.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

github_tree="https://github.com/emolinaro/superscriber/tree/main"
github_blob="https://github.com/emolinaro/superscriber/blob/main"

content="$repo_root/website/content"
rm -rf "$content"
mkdir -p "$content/operators"

# Landing page: the README becomes the site index. TODOS.md is deliberately
# not staged: it is internal follow-on tracking, not product documentation
cp README.md "$content/index.md"
cp DESIGN.md CHANGELOG.md CONTRIBUTING.md "$content/"
# Operator runbooks, minus the internal OIDC acceptance report (an evidence
# record from the OIDC lane, not an operator procedure)
for runbook in docs/operators/*.md; do
  [ "$(basename "$runbook")" = "oidc-acceptance-2026-08.md" ] && continue
  cp "$runbook" "$content/operators/"
done

# User guide: docs/USER-GUIDE.md is staged automatically when present; it is
# listed in website/sidebars.ts.
if [ -f docs/USER-GUIDE.md ]; then
  cp docs/USER-GUIDE.md "$content/USER-GUIDE.md"
fi

cd "$content"

# Retarget links in the staged copies (sources are never touched):
#  - internal-only docs stripped from the site (TODOS.md, the OIDC acceptance
#    report) point at the repo blob instead
perl -pi -e "s{\]\(\./TODOS\.md\)}{]($github_blob/TODOS.md)}g" *.md
perl -pi -e "s{\]\(\./docs/operators/oidc-acceptance-2026-08\.md\)}{]($github_blob/docs/operators/oidc-acceptance-2026-08.md)}g" *.md
#  - operator runbook links: ./docs/operators/x.md -> operators/x.md
perl -pi -e 's{\]\(\./docs/operators/([A-Za-z0-9_.-]+\.md)\)}{](operators/$1)}g' *.md
#  - the ./docs/operators/ directory link points at the repo tree
perl -pi -e "s{\\]\\(\\./docs/operators/\\)}{]($github_tree/docs/operators)}g" *.md
#  - repository-layout directory links (README) point at the repo tree
perl -pi -e "s{\\]\\(\\./(app|src/components|src/domain|src/server|data|worker|scripts)/\\)}{]($github_tree/\$1)}g" index.md
#  - the LICENSE file link points at the repo blob
perl -pi -e "s{\\]\\(\\./LICENSE\\)}{]($github_blob/LICENSE)}g" *.md
#  - AGENTS.md is agent-orientation, not a docs page; point it at the repo blob
perl -pi -e "s{\\]\\(\\./AGENTS\\.md\\)}{]($github_blob/AGENTS.md)}g" *.md
#  - the README is staged as index.md (the docs root), so links back into
#    README.md must follow it there
perl -pi -e 's{\]\(\./README\.md(#[A-Za-z0-9_-]+)?\)}{](index.md$1)}g' *.md operators/*.md
#    and from runbooks, ../../README.md -> ../index.md (same target)
perl -pi -e 's{\]\(\.\./\.\./README\.md(#[A-Za-z0-9_-]+)?\)}{](../index.md$1)}g' operators/*.md
#  - the user guide is staged at the docs root, so links into docs/USER-GUIDE.md
#    must follow it there
perl -pi -e 's{\]\(\./docs/USER-GUIDE\.md(#[A-Za-z0-9_-]+)?\)}{](USER-GUIDE.md$1)}g' *.md operators/*.md
#  - internal working-tree links (.fm-internal/docs-superpowers/, gitignored
#    and absent from fresh clones) can resolve nowhere public; keep the
#    anchor text, drop the dead link
perl -pi -e 's{\[([^\]]+)\]\(\./\.fm-internal/[^)]*\)}{$1}g' *.md operators/*.md
#  - the README logo (raw HTML, cannot be rewritten by the renderer) uses the
#    static asset staged into website/static/img/
perl -pi -e 's{src="\./app/icon\.svg"}{src="/superscriber/img/icon.svg"}g' index.md

echo "Staged Docusaurus docs content into $content"
