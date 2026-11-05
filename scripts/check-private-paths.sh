#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Fails when this public repository would contain something private: the maintainers'
# internal notes, the marketing site, Cloud-only code and the old history live in separate
# private repositories next to it, never in it. Reads the git index, so CI checks what is
# committed and the opt-in pre-commit hook (.githooks/pre-commit) what is about to be.
#   - tracked paths: the workspace layout or a private repository's folder, local
#     settings (.env) and databases;
#   - marketing site code (ADR-114): site/, deploy/site/, a Nuxt config or a package that
#     depends on Nuxt. The docs it renders stay here, in docs/site/;
#   - tracked text, docs included: the private repositories' names, the workspace's
#     folder names, personal email addresses and absolute home paths.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

status=0
report() {
  echo "$1"
  echo "$2" | sed 's/^/  /'
  status=1
}

paths=$(git ls-files | grep -E '^(notes|cloud|private-repos|public-repos)/|(^|/)\.env$|\.db$' || true)
[ -z "$paths" ] || report "private or local files are tracked:" "$paths"

site=$(git ls-files | grep -E '^(deploy/)?site/|(^|/)(nuxt|site)\.config\.[cm]?[jt]s$' || true)
nuxt=$(git grep --cached -lE '"nuxt"[[:space:]]*:' -- '*package.json' || true)
[ -z "$site$nuxt" ] || report "marketing site code (it lives in a private repository, ADR-114):" \
  "$(printf '%s\n%s' "$site" "$nuxt" | sed '/^$/d')"

# Spelled as patterns, so this script does not match itself.
names='watchlog-(notes|cloud|archive|site)([^a-z0-9-]|$)|(private|public)-repos/'
personal='[A-Za-z0-9._%+-]+@gmail\.com|/Users/[^/[:space:]]+/Documents/'
found=$(git grep --cached -nIE "$names|$personal" -- . ':!:scripts/check-private-paths.sh' || true)
[ -z "$found" ] || report "private repository names, workspace paths or personal data:" "$found"

if [ "$status" -eq 0 ]; then
  echo "private paths: ok"
fi
exit "$status"
