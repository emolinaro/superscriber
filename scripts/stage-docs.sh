#!/usr/bin/env bash
# Stage the MkDocs docs directory for the GitHub Pages site.
#
# The project docs intentionally stay where they are (README.md, DESIGN.md,
# docs/operators/, ...). MkDocs needs one docs_dir, so this script mirrors the
# tracked documentation into .docs-site/ with the exact same relative paths,
# which keeps every relative link (./CHANGELOG.md, ./docs/operators/, the
# logo at ./app/icon.svg) resolving identically on the built site.
#
# The staging directory is generated - never edit files inside it.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

staging="$repo_root/.docs-site"
rm -rf "$staging"
mkdir -p "$staging/docs" "$staging/app"

# Top-level documents.
cp README.md DESIGN.md CHANGELOG.md TODOS.md LICENSE "$staging/"

# Operator runbooks (docs/superpowers/ is gitignored working state and is
# deliberately not published).
cp -R docs/operators "$staging/docs/operators"

# Logo referenced by README.md. <img src="./app/icon.svg"> (HTML, so MkDocs
# cannot rewrite it; mirroring the path keeps it working).
cp app/icon.svg "$staging/app/icon.svg"

# Future user guide: once the demo lane lands docs/USER-GUIDE.md it is staged
# automatically; enable its nav entry in mkdocs.yml at the same time.
if [ -f docs/USER-GUIDE.md ]; then
  cp docs/USER-GUIDE.md "$staging/docs/USER-GUIDE.md"
fi

echo "Staged docs site sources into $staging"
