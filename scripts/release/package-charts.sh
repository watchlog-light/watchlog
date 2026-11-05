#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Packages both Helm charts for a release: chart version and appVersion (the image tag)
# set to <version>, the watchlog chart's agent dependency pinned to it. Writes
# watchlog-agent-<version>.tgz and watchlog-<version>.tgz to <out>; never pushes.
# Usage: scripts/release/package-charts.sh 0.1.0 dist/charts
set -euo pipefail
version="$1"
out="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z, got $version"; exit 2; }
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$root/deploy/helm/watchlog-agent" "$root/deploy/helm/watchlog" "$work/"
rm -rf "$work/watchlog/charts" "$work/watchlog/Chart.lock"

for chart in watchlog-agent watchlog; do
  sed -i.bak -E \
    -e "s/^version: .*/version: $version/" \
    -e "s/^appVersion: .*/appVersion: '$version'/" \
    "$work/$chart/Chart.yaml"
done
# The dependency entry is the only indented `version:` in the watchlog chart.
sed -i.bak -E "s/^(    version: ).*/\1$version/" "$work/watchlog/Chart.yaml"
rm -f "$work"/*/Chart.yaml.bak

mkdir -p "$out"
helm lint --strict "$work/watchlog-agent" --set watchlog.endpoint=http://x --set watchlog.clusterToken=t >/dev/null
helm package "$work/watchlog-agent" -d "$out" >/dev/null
helm dependency build "$work/watchlog" >/dev/null
helm lint --strict "$work/watchlog" >/dev/null
helm package "$work/watchlog" -d "$out" >/dev/null
ls "$out"/watchlog-agent-"$version".tgz "$out"/watchlog-"$version".tgz
