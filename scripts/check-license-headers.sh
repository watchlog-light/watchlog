#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Checks that every tracked source file declares its license in the first
# three lines (ADR-015): AGPL-3.0-only everywhere, LicenseRef-WatchLog-Enterprise in ee/.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

status=0
while IFS= read -r file; do
  case "$file" in
    ee/*) expected='SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise' ;;
    *) expected='SPDX-License-Identifier: AGPL-3.0-only' ;;
  esac
  if ! head -n 3 "$file" | grep -qF "$expected"; then
    echo "missing '$expected': $file"
    status=1
  fi
done < <(git ls-files -- '*.go' '*.ts' '*.vue' '*.js' '*.mjs' '*.css' '*.sh' ':!:**/*.gen.go' ':!:backend/src/db/types.ts' ':!:packages/api-types/src/generated/**' ':!:**/*_bpfel.go' ':!:**/*_bpfeb.go')

if [ "$status" -eq 0 ]; then
  echo "license headers: ok"
fi
exit "$status"
