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

# Landing page: the README becomes the site index.
cp README.md "$content/index.md"
cp DESIGN.md CHANGELOG.md TODOS.md "$content/"
cp docs/operators/*.md "$content/operators/"

# Future user guide: once the demo lane lands docs/USER-GUIDE.md it is staged
# automatically; add it to website/sidebars.ts at the same time.
if [ -f docs/USER-GUIDE.md ]; then
  cp docs/USER-GUIDE.md "$content/USER-GUIDE.md"
fi

cd "$content"

# Retarget links in the staged copies (sources are never touched):
#  - operator runbook links: ./docs/operators/x.md -> operators/x.md
perl -pi -e 's{\]\(\./docs/operators/([A-Za-z0-9_.-]+\.md)\)}{](operators/$1)}g' *.md
#  - the ./docs/operators/ directory link points at the repo tree
perl -pi -e "s{\\]\\(\\./docs/operators/\\)}{]($github_tree/docs/operators)}g" *.md
#  - repository-layout directory links (README) point at the repo tree
perl -pi -e "s{\\]\\(\\./(app|src/components|src/domain|src/server|data|worker|scripts)/\\)}{]($github_tree/\$1)}g" index.md
#  - the LICENSE file link points at the repo blob
perl -pi -e "s{\\]\\(\\./LICENSE\\)}{]($github_blob/LICENSE)}g" *.md
#  - dev-process specs/plans (docs/superpowers/) are not staged into the
#    site, so links into them point at the repo blob
perl -pi -e "s{\\]\\(\\./docs/superpowers/([A-Za-z0-9_./-]+\\.md)\\)}{]($github_blob/docs/superpowers/\$1)}g" *.md operators/*.md
#  - the README logo (raw HTML, cannot be rewritten by the renderer) uses the
#    static asset staged into website/static/img/
perl -pi -e 's{src="\./app/icon\.svg"}{src="/superscriber/img/icon.svg"}g' index.md

echo "Staged Docusaurus docs content into $content"
