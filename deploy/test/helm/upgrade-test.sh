#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Upgrades from a release installed before Phase 4 must turn eBPF on without manual
# steps (SPEC §6.4 opt-out, ADR-107). `helm upgrade --reuse-values` replaces the new
# chart's defaults with the old release's computed values; this renders the new
# templates exactly that way (values.yaml swapped for pre-phase4/*.values.yaml) and
# checks the node agent DaemonSet, plus a fresh install, --reset-then-reuse-values and an
# explicit opt-out; and the same from 0.2.0's values (v0.2.0/), 0.4.0's (v0.4.0/, where
# logs on demand and its pods/log grant come on), 0.5.0's (v0.5.0/) and 0.6.0's (v0.6.0/,
# where alerting.egressLearningDays is new and read nil-safe). Needs helm; run
# from anywhere.
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

# The integrations collector (ADR-131) comes on with an upgrade from values that predate it,
# and stays off when turned off.
# collector <name> <want present|absent> <helm template output of the chart>
collector() {
  local name="$1" want="$2" out="$3" got=absent
  if grep -q 'app.kubernetes.io/component: integrations' <<<"$out" &&
    grep -q 'image: .*/integrations:' <<<"$out"; then got=present; fi
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $name: integrations collector $got"
  else
    echo "FAIL  $name: integrations collector $got, want $want"
    fails=$((fails + 1))
  fi
}
collector "agent chart, fresh install" present "$(helm template rel "$AGENT" -n ns "${USER_VALUES[@]}")"
collector "agent chart, --reuse-values from before Phase 4" present \
  "$(helm template rel "$(reused "$AGENT" "$FIX/watchlog-agent.values.yaml")" -n ns)"
collector "agent chart, turned off" absent \
  "$(helm template rel "$AGENT" -n ns "${USER_VALUES[@]}" --set integrations.enabled=false)"
collector "watchlog chart, --reuse-values from before Phase 4" present \
  "$(helm template rel "$(reused "$UMBRELLA" "$FIX/watchlog.values.yaml")" -n ns)"
collector "watchlog chart, turned off through the subchart" absent \
  "$(helm template rel "$UMBRELLA" -n ns --set watchlog-agent.integrations.enabled=false)"

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

# From 0.2.0 (v0.2.0/, the released charts' values): eBPF with its HTTP stats (ADR-139)
# and the integrations collector (ADR-131) come on, and every template renders.
V020="$ROOT/deploy/test/helm/v0.2.0"
# httpstats <name> <want true|false> <rendered DaemonSet>
httpstats() {
  local got
  got="$(grep -A1 'name: WATCHLOG_EBPF_HTTP$' <<<"$3" | sed -n 's/.*value: "\(.*\)"/\1/p')"
  if [[ "$got" == "$2" ]]; then
    echo "PASS  $1: HTTP stats $got"
  else
    echo "FAIL  $1: HTTP stats ${got:-unset}, want $2"
    fails=$((fails + 1))
  fi
}
expect "agent chart, --reuse-values from 0.2.0" on "$(ds "$(reused "$AGENT" "$V020/watchlog-agent.values.yaml")" "$AGENT_DS")"
httpstats "agent chart, --reuse-values from 0.2.0" true "$(ds "$(reused "$AGENT" "$V020/watchlog-agent.values.yaml")" "$AGENT_DS")"
httpstats "agent chart, turned off" false "$(ds "$AGENT" "$AGENT_DS" "${USER_VALUES[@]}" --set agent.networkFlows.http=false)"
expect "watchlog chart, --reuse-values from 0.2.0" on "$(ds "$(reused "$UMBRELLA" "$V020/watchlog.values.yaml")" "$SUB_DS")"
httpstats "watchlog chart, --reuse-values from 0.2.0" true "$(ds "$(reused "$UMBRELLA" "$V020/watchlog.values.yaml")" "$SUB_DS")"
collector "agent chart, --reuse-values from 0.2.0" present \
  "$(helm template rel "$(reused "$AGENT" "$V020/watchlog-agent.values.yaml")" -n ns)"
collector "watchlog chart, --reuse-values from 0.2.0" present \
  "$(helm template rel "$(reused "$UMBRELLA" "$V020/watchlog.values.yaml")" -n ns)"
for pair in "$AGENT:watchlog-agent" "$UMBRELLA:watchlog"; do
  chart="${pair%%:*}" fixture="${pair##*:}"
  if helm template rel "$(reused "$chart" "$V020/$fixture.values.yaml")" -n ns >/dev/null 2>"$TMP/err"; then
    echo "PASS  $fixture chart renders from 0.2.0's values"
  else
    echo "FAIL  $fixture chart renders from 0.2.0's values: $(cat "$TMP/err")"
    fails=$((fails + 1))
  fi
done

# From 0.4.0 (v0.4.0/, the released charts' values): logs on demand (ADR-167) come on,
# with the cluster-agent's pods/log grant, read nil-safe; logs.enabled=false takes both away.
V040="$ROOT/deploy/test/helm/v0.4.0"
# logs <name> <want on|off> <chart dir> [helm args...]
logs() {
  local name="$1" want="$2" chart="$3" out env grant got=inconsistent
  shift 3
  out="$(helm template rel "$chart" -n ns "$@")"
  env="$(grep -A1 'name: WATCHLOG_LOGS$' <<<"$out" | sed -n 's/.*value: "\(.*\)"/\1/p')"
  grant=no
  grep -q 'resources: \[pods/log\]' <<<"$out" && grant=yes
  if [[ "$env" == true && "$grant" == yes ]]; then
    got=on
  elif [[ "$env" == false && "$grant" == no ]]; then
    got=off
  fi
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $name: logs $got"
  else
    echo "FAIL  $name: logs $got (WATCHLOG_LOGS ${env:-unset}, pods/log grant $grant), want $want"
    fails=$((fails + 1))
  fi
}
expect "agent chart, --reuse-values from 0.4.0" on "$(ds "$(reused "$AGENT" "$V040/watchlog-agent.values.yaml")" "$AGENT_DS")"
logs "agent chart, fresh install" on "$AGENT" "${USER_VALUES[@]}"
logs "agent chart, --reuse-values from 0.4.0" on "$(reused "$AGENT" "$V040/watchlog-agent.values.yaml")"
logs "agent chart, --reuse-values from 0.4.0 plus logs.enabled=false" off \
  "$(reused "$AGENT" "$V040/watchlog-agent.values.yaml")" --set logs.enabled=false
logs "agent chart, logs.enabled=false as a string" off "$AGENT" "${USER_VALUES[@]}" --set-string logs.enabled=false
logs "watchlog chart, --reuse-values from 0.4.0" on "$(reused "$UMBRELLA" "$V040/watchlog.values.yaml")"
logs "watchlog chart, watchlog-agent.logs.enabled=false" off "$UMBRELLA" --set watchlog-agent.logs.enabled=false
collector "agent chart, --reuse-values from 0.4.0" present \
  "$(helm template rel "$(reused "$AGENT" "$V040/watchlog-agent.values.yaml")" -n ns)"
for pair in "$AGENT:watchlog-agent" "$UMBRELLA:watchlog"; do
  chart="${pair%%:*}" fixture="${pair##*:}"
  if helm template rel "$(reused "$chart" "$V040/$fixture.values.yaml")" -n ns >/dev/null 2>"$TMP/err"; then
    echo "PASS  $fixture chart renders from 0.4.0's values"
  else
    echo "FAIL  $fixture chart renders from 0.4.0's values: $(cat "$TMP/err")"
    fails=$((fails + 1))
  fi
done

# From 0.5.0 (v0.5.0/, the released charts' values): 0.6.0 adds no chart value, so a
# --reuse-values upgrade keeps eBPF, logs on demand and the collector as they were, and
# renders exactly what 0.5.0's own charts render from the same values (when the v0.5.0 tag
# is in this checkout).
V050="$ROOT/deploy/test/helm/v0.5.0"
expect "agent chart, --reuse-values from 0.5.0" on "$(ds "$(reused "$AGENT" "$V050/watchlog-agent.values.yaml")" "$AGENT_DS")"
logs "agent chart, --reuse-values from 0.5.0" on "$(reused "$AGENT" "$V050/watchlog-agent.values.yaml")"
logs "watchlog chart, --reuse-values from 0.5.0" on "$(reused "$UMBRELLA" "$V050/watchlog.values.yaml")"
collector "agent chart, --reuse-values from 0.5.0" present \
  "$(helm template rel "$(reused "$AGENT" "$V050/watchlog-agent.values.yaml")" -n ns)"
if git -C "$ROOT" rev-parse -q --verify 'v0.5.0^{commit}' >/dev/null; then
  mkdir -p "$TMP/v0.5.0"
  git -C "$ROOT" archive v0.5.0 deploy/helm | tar -x -C "$TMP/v0.5.0"
  helm dependency build "$TMP/v0.5.0/deploy/helm/watchlog" >/dev/null
  # Generated anew on every render: the pod map's certificates (and their checksum), and the
  # Secrets' database password, secret key and first cluster token.
  certless() { grep -vE '^ *(ca\.crt|tls\.crt|tls\.key|checksum/[a-z-]+|password|key|token):'; }
  for pair in "$AGENT:watchlog-agent" "$UMBRELLA:watchlog"; do
    chart="${pair%%:*}" fixture="${pair##*:}"
    old="$(helm template rel "$TMP/v0.5.0/deploy/helm/$fixture" -n ns -f "$V050/$fixture.values.yaml" | certless)"
    new="$(helm template rel "$chart" -n ns -f "$V050/$fixture.values.yaml" | certless)"
    if [[ "$old" == "$new" ]]; then
      echo "PASS  $fixture chart from 0.5.0's values renders as 0.5.0's chart"
    else
      echo "FAIL  $fixture chart from 0.5.0's values differs from 0.5.0's chart:"
      diff <(echo "$old") <(echo "$new") | cut -c1-160 | head -20
      fails=$((fails + 1))
    fi
  done
else
  echo "SKIP  0.5.0's own charts: no v0.5.0 tag in this checkout"
fi

# From 0.6.0 (v0.6.0/, the released charts' values): 0.7.0 adds one value,
# alerting.egressLearningDays (ADR-187), read nil-safe. Values without it render no
# WATCHLOG_EGRESS_LEARNING_DAYS (the backend's default of 7 days), so a --reuse-values
# upgrade renders exactly what 0.6.0's own charts render; set, even to 0, it reaches the
# backend and the alert worker.
V060="$ROOT/deploy/test/helm/v0.6.0"
# learning <name> <want value|unset> <chart dir> [helm args...]
learning() {
  local name="$1" want="$2" chart="$3" be wk
  shift 3
  be="$(helm template rel "$chart" -n ns --show-only templates/backend.yaml "$@" |
    sed -n 's/.*name: WATCHLOG_EGRESS_LEARNING_DAYS, value: "\(.*\)" }.*/\1/p' | sort -u | tr '\n' ' ')"
  wk="$(helm template rel "$chart" -n ns --show-only templates/alert-worker.yaml "$@" |
    sed -n 's/.*name: WATCHLOG_EGRESS_LEARNING_DAYS, value: "\(.*\)" }.*/\1/p' | sort -u | tr '\n' ' ')"
  be="${be% }" wk="${wk% }"
  if [[ "${be:-unset}" == "$want" && "${wk:-unset}" == "$want" ]]; then
    echo "PASS  $name: egress learning days $want"
  else
    echo "FAIL  $name: egress learning days backend ${be:-unset}, worker ${wk:-unset}, want $want"
    fails=$((fails + 1))
  fi
}
expect "agent chart, --reuse-values from 0.6.0" on "$(ds "$(reused "$AGENT" "$V060/watchlog-agent.values.yaml")" "$AGENT_DS")"
logs "agent chart, --reuse-values from 0.6.0" on "$(reused "$AGENT" "$V060/watchlog-agent.values.yaml")"
logs "watchlog chart, --reuse-values from 0.6.0" on "$(reused "$UMBRELLA" "$V060/watchlog.values.yaml")"
collector "agent chart, --reuse-values from 0.6.0" present \
  "$(helm template rel "$(reused "$AGENT" "$V060/watchlog-agent.values.yaml")" -n ns)"
learning "watchlog chart, fresh install" unset "$UMBRELLA"
learning "watchlog chart, --reuse-values from 0.6.0" unset "$(reused "$UMBRELLA" "$V060/watchlog.values.yaml")"
learning "watchlog chart, --reuse-values from 0.6.0 plus egressLearningDays=0.25" 0.25 \
  "$(reused "$UMBRELLA" "$V060/watchlog.values.yaml")" --set alerting.egressLearningDays=0.25
learning "watchlog chart, egressLearningDays=0 (kept, not the default)" 0 "$UMBRELLA" \
  --set alerting.egressLearningDays=0
learning "watchlog chart, egressLearningDays as a string" 3 "$UMBRELLA" \
  --set-string alerting.egressLearningDays=3
for pair in "$AGENT:watchlog-agent" "$UMBRELLA:watchlog"; do
  chart="${pair%%:*}" fixture="${pair##*:}"
  if helm template rel "$(reused "$chart" "$V060/$fixture.values.yaml")" -n ns >/dev/null 2>"$TMP/err"; then
    echo "PASS  $fixture chart renders from 0.6.0's values"
  else
    echo "FAIL  $fixture chart renders from 0.6.0's values: $(cat "$TMP/err")"
    fails=$((fails + 1))
  fi
done
if git -C "$ROOT" rev-parse -q --verify 'v0.6.0^{commit}' >/dev/null; then
  mkdir -p "$TMP/v0.6.0"
  git -C "$ROOT" archive v0.6.0 deploy/helm | tar -x -C "$TMP/v0.6.0"
  helm dependency build "$TMP/v0.6.0/deploy/helm/watchlog" >/dev/null
  certless() { grep -vE '^ *(ca\.crt|tls\.crt|tls\.key|checksum/[a-z-]+|password|key|token):'; }
  for pair in "$AGENT:watchlog-agent" "$UMBRELLA:watchlog"; do
    chart="${pair%%:*}" fixture="${pair##*:}"
    old="$(helm template rel "$TMP/v0.6.0/deploy/helm/$fixture" -n ns -f "$V060/$fixture.values.yaml" | certless)"
    new="$(helm template rel "$(reused "$chart" "$V060/$fixture.values.yaml")" -n ns | certless)"
    if [[ "$old" == "$new" ]]; then
      echo "PASS  $fixture chart, --reuse-values from 0.6.0, renders as 0.6.0's chart"
    else
      echo "FAIL  $fixture chart, --reuse-values from 0.6.0, differs from 0.6.0's chart:"
      diff <(echo "$old") <(echo "$new") | cut -c1-160 | head -20
      fails=$((fails + 1))
    fi
  done
else
  echo "SKIP  0.6.0's own charts: no v0.6.0 tag in this checkout"
fi

# 0.8.0 adds anomalyWorker (ADR-197), off by default and read nil-safe: a fresh install
# and a --reuse-values upgrade from 0.6.0's values render no anomaly-worker, so Community
# runs exactly the processes it ran before; the live demo turns it on with demoMode.
# anomaly <name> <want present|absent> <chart dir> [helm args...]
anomaly() {
  local name="$1" want="$2" chart="$3" out got=absent
  shift 3
  out="$(helm template rel "$chart" -n ns "$@")"
  if grep -q 'name: rel-anomaly-worker$' <<<"$out"; then
    got=present
    grep -q 'args: \[dist/anomaly-worker.js\]' <<<"$out" || got=inconsistent
  fi
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $name: anomaly-worker $got"
  else
    echo "FAIL  $name: anomaly-worker $got, want $want"
    fails=$((fails + 1))
  fi
}
anomaly "watchlog chart, fresh install" absent "$UMBRELLA"
anomaly "watchlog chart, --reuse-values from 0.6.0" absent "$(reused "$UMBRELLA" "$V060/watchlog.values.yaml")"
anomaly "watchlog chart, --reuse-values from 0.6.0 plus anomalyWorker.enabled" present \
  "$(reused "$UMBRELLA" "$V060/watchlog.values.yaml")" --set anomalyWorker.enabled=true --set demoMode=true
anomaly "watchlog chart, demoMode alone" absent "$UMBRELLA" --set demoMode=true

[[ $fails -eq 0 ]] || { echo "$fails upgrade check(s) failed"; exit 1; }
