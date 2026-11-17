#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The server install's release assets (ADR-209): for each architecture a tarball with the
# agent, the integrations collector and their systemd units, a deb and an rpm (nfpm), and
# SHA256SUMS over all of them. The release workflow signs SHA256SUMS with cosign.
#   deploy/linux/build.sh <version> <out dir> [arch …]   (default: amd64 arm64)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
version=${1:?version, e.g. 0.9.0}
out=$(mkdir -p "${2:?out dir}" && cd "$2" && pwd)
shift 2
arches=("${@:-amd64 arm64}")
[ $# -eq 0 ] && arches=(amd64 arm64)
NFPM=${NFPM:-github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.43.0}
commit=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)
pkg=github.com/watchlog-light/watchlog/agent/internal/version
ldflags="-s -w -X $pkg.Version=$version -X $pkg.Commit=$commit"

for arch in "${arches[@]}"; do
  bin=$(mktemp -d)
  for cmd in watchlog-agent watchlog-integrations; do
    (cd "$root/agent" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags "$ldflags" -o "$bin/$cmd" "./cmd/$cmd")
  done
  stage=$(mktemp -d)
  cp "$bin"/watchlog-agent "$bin"/watchlog-integrations "$here"/watchlog-agent.service \
    "$here"/watchlog-integrations.service "$here"/agent.env.example "$stage/"
  tar -C "$stage" -czf "$out/watchlog-agent_${version}_linux_${arch}.tar.gz" .
  # nfpm expands variables in version and arch, not in paths: render the binaries' path.
  sed "s|\${BIN}|$bin|g" "$here/nfpm.yaml" >"$bin/nfpm.yaml"
  for packager in deb rpm; do
    (cd "$here" && ARCH=$arch VERSION=$version go run "$NFPM" package \
      --config "$bin/nfpm.yaml" --packager "$packager" --target "$out/" >/dev/null)
  done
  rm -rf "$bin" "$stage"
done
(cd "$out" && sha256sum watchlog-agent_* watchlog-agent-* 2>/dev/null | sort -k2 >SHA256SUMS)
cp "$here/install.sh" "$out/install.sh"
ls -1 "$out"
