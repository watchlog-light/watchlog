#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Upgrades from a release installed before Phase 4 must turn eBPF on without manual
# steps (SPEC §6.4 opt-out, ADR-107). `helm upgrade --reuse-values` replaces the new
# chart's defaults with the old release's computed values; this renders the new
# templates exactly that way (values.yaml swapped for pre-phase4/*.values.yaml) and
# checks the node agent DaemonSet, plus a fresh install, --reset-then-reuse-values and an
# explicit opt-out. Needs helm; run from anywhere.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIX="$ROOT/deploy/test/helm/pre-phase4"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

helm dependency build "$ROOT/deploy/helm/watchlog" >/dev/null

# ds <chart dir> <daemonset template> [helm args...]: the rendered node agent DaemonSet.
ds() {
  local chart="$1" tpl="$2"
  shift 2
  helm template rel "$chart" -n ns --show-only "$tpl" "$@"
}

# expect <name> <on|off> <rendered DaemonSet>
expect() {
  local name="$1" want="$2" out="$3" got=off
  if grep -A1 'name: WATCHLOG_EBPF$' <<<"$out" | grep -q 'value: "true"' &&
    grep -q 'add: \[BPF, PERFMON\]' <<<"$out" && grep -q 'runAsUser: 0' <<<"$out"; then
    got=on
  elif ! grep -A1 'name: WATCHLOG_EBPF$' <<<"$out" | grep -q 'value: "false"' ||
    grep -q 'add:' <<<"$out" || grep -q 'runAsUser: 0' <<<"$out"; then
    got=inconsistent
  fi
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $name: eBPF $got"
  else
    echo "FAIL  $name: eBPF $got, want $want"
    fails=$((fails + 1))
  fi
}

# reused <chart> <fixture>: a copy of the chart whose defaults are the old computed values.
reused() {
  local dir
  dir="$TMP/$(basename "$1")-$RANDOM"
  cp -R "$1" "$dir"
  cp "$2" "$dir/values.yaml"
  echo "$dir"
}

AGENT="$ROOT/deploy/helm/watchlog-agent"
UMBRELLA="$ROOT/deploy/helm/watchlog"
AGENT_DS=templates/daemonset.yaml
SUB_DS=charts/watchlog-agent/templates/daemonset.yaml
USER_VALUES=(--set fullnameOverride=wl-dev --set watchlog.endpoint=http://watchlog.example.internal:4080
  --set watchlog.clusterToken=wl_ct_example)

expect "agent chart, fresh install" on "$(ds "$AGENT" "$AGENT_DS" "${USER_VALUES[@]}")"
expect "agent chart, --reuse-values from before Phase 4" on \
  "$(ds "$(reused "$AGENT" "$FIX/watchlog-agent.values.yaml")" "$AGENT_DS")"
expect "agent chart, --reset-then-reuse-values from before Phase 4" on \
  "$(ds "$AGENT" "$AGENT_DS" "${USER_VALUES[@]}")"
expect "agent chart, explicit opt-out" off \
  "$(ds "$AGENT" "$AGENT_DS" "${USER_VALUES[@]}" --set agent.networkFlows.enabled=false)"
expect "agent chart, opt-out given as a string" off \
  "$(ds "$AGENT" "$AGENT_DS" "${USER_VALUES[@]}" --set-string agent.networkFlows.enabled=false)"
expect "agent chart, reused values plus explicit opt-out" off \
  "$(ds "$(reused "$AGENT" "$FIX/watchlog-agent.values.yaml")" "$AGENT_DS" \
    --set agent.networkFlows.enabled=false)"

expect "watchlog chart, fresh install" on "$(ds "$UMBRELLA" "$SUB_DS")"
expect "watchlog chart, --reuse-values from before Phase 4" on \
  "$(ds "$(reused "$UMBRELLA" "$FIX/watchlog.values.yaml")" "$SUB_DS")"
expect "watchlog chart, explicit opt-out" off \
  "$(ds "$UMBRELLA" "$SUB_DS" --set watchlog-agent.agent.networkFlows.enabled=false)"

# Values added later (ADR-121) read nil-safe: values without them get the defaults.
# isolation <name> <want pod filter> <want scope> <rendered DaemonSet>
isolation() {
  local name="$1" filter="$2" scope="$3" out="$4" got
  got="$(grep -A1 'name: WATCHLOG_EBPF_POD_FILTER$' <<<"$out" | sed -n 's/.*value: "\(.*\)"/\1/p')/$(
    grep -A1 'name: WATCHLOG_NODE_METRICS_SCOPE$' <<<"$out" | sed -n 's/.*value: "\(.*\)"/\1/p')"
  if [[ "$got" == "$filter/$scope" ]]; then
    echo "PASS  $name: pod filter and scope $got"
  else
    echo "FAIL  $name: pod filter and scope $got, want $filter/$scope"
    fails=$((fails + 1))
  fi
}
isolation "agent chart, defaults" true auto "$(ds "$AGENT" "$AGENT_DS" "${USER_VALUES[@]}")"
isolation "agent chart, --reuse-values from before Phase 4" true auto \
  "$(ds "$(reused "$AGENT" "$FIX/watchlog-agent.values.yaml")" "$AGENT_DS")"
isolation "agent chart, set" false cgroup "$(ds "$AGENT" "$AGENT_DS" "${USER_VALUES[@]}" \
  --set agent.networkFlows.podFilter=false --set agent.nodeMetricsScope=cgroup)"
isolation "watchlog chart, --reuse-values from before Phase 4" true auto \
  "$(ds "$(reused "$UMBRELLA" "$FIX/watchlog.values.yaml")" "$SUB_DS")"
isolation "watchlog chart, set through the subchart" true cgroup \
  "$(ds "$UMBRELLA" "$SUB_DS" --set watchlog-agent.agent.nodeMetricsScope=cgroup)"

# Every template of both charts renders from the old values (no nil-map errors).
for pair in "$AGENT:watchlog-agent" "$UMBRELLA:watchlog"; do
  chart="${pair%%:*}" fixture="${pair##*:}"
  if helm template rel "$(reused "$chart" "$FIX/$fixture.values.yaml")" -n ns >/dev/null 2>"$TMP/err"; then
    echo "PASS  $fixture chart renders from values before Phase 4"
  else
    echo "FAIL  $fixture chart renders from values before Phase 4: $(cat "$TMP/err")"
    fails=$((fails + 1))
  fi
done

[[ $fails -eq 0 ]] || { echo "$fails upgrade check(s) failed"; exit 1; }
