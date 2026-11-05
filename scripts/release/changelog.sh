#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Release notes for a tag: the hand-written highlights in docs/releases/<tag>.md, then the
# conventional commits since the previous tag (features, fixes, performance), then how
# to install and verify. Prints Markdown.
# Usage: scripts/release/changelog.sh v0.1.0 [<ref>]   (ref defaults to the tag, or HEAD
# when the tag does not exist yet, for a dry run)
set -euo pipefail
tag="$1"
version="${tag#v}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
ref="${2:-$(git rev-parse -q --verify "refs/tags/$tag" >/dev/null && echo "$tag" || echo HEAD)}"
prev="$(git describe --tags --abbrev=0 --match 'v*.*.*' "$ref^" 2>/dev/null || true)"
range="${prev:+$prev..}$ref"
repo="https://github.com/watchlog-light/watchlog"

if [ -f "docs/releases/$tag.md" ]; then
  sed '/^<!--/,/-->$/d' "docs/releases/$tag.md"
  echo
fi

section() {
  local title="$1" pattern="$2" lines
  lines=$(git log --no-merges --format='%s' "$range" | grep -E "^($pattern)(\([^)]*\))?!?: " |
    sed -E 's/^[a-z]+(\(([^)]*)\))?!?: (.*)$/- \3 (\2)/; s/ \(\)$//' || true)
  if [ -n "$lines" ]; then
    printf '### %s\n\n%s\n\n' "$title" "$lines"
  fi
}
echo "## Changes${prev:+ since $prev}"
echo
section "Features" "feat"
section "Fixes" "fix"
section "Performance" "perf"

cat <<EOF
## Install

Kubernetes (backend, web, agents in one chart):

\`\`\`bash
helm install watchlog oci://ghcr.io/watchlog-light/charts/watchlog --version $version \\
  --namespace watchlog --create-namespace
\`\`\`

Docker hosts: see the [install guide]($repo/blob/$tag/docs/site/install.md).

## Verify

Images and charts are signed with cosign (keyless, GitHub Actions OIDC):

\`\`\`bash
cosign verify ghcr.io/watchlog-light/agent:$version \\
  --certificate-identity-regexp '^$repo/\.github/workflows/release\.yml@refs/tags/v' \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
\`\`\`
EOF
