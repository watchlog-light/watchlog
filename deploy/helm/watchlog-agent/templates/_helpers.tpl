{{/* SPDX-License-Identifier: AGPL-3.0-only */}}
{{- define "watchlog-agent.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "watchlog-agent.labels" -}}
app.kubernetes.io/name: watchlog-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "watchlog-agent.image" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}
{{- printf "%s/%s:%s" $root.Values.image.registry $name (default $root.Chart.AppVersion $root.Values.image.tag) -}}
{{- end -}}

{{/* The Secret holding the cluster token: the user's, or the one this chart creates. */}}
{{- define "watchlog-agent.tokenSecret" -}}
{{- if .Values.watchlog.existingSecret -}}
{{- tpl .Values.watchlog.existingSecret . -}}
{{- else -}}
{{- printf "%s-token" (include "watchlog-agent.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "watchlog-agent.clusterAgentService" -}}
{{- printf "%s-cluster-agent" (include "watchlog-agent.fullname" .) -}}
{{- end -}}

{{/* Security settings shared by both agents (ADR-060). */}}
{{- define "watchlog-agent.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
{{/*
eBPF is on unless agent.networkFlows.enabled is false (SPEC §6.4, opt-out). A missing key
means on: `helm upgrade --reuse-values` from a release installed before Phase 4 reuses
that chart's values, which have agent.ebpf.enabled=false and no networkFlows (ADR-107).
*/}}
{{- define "watchlog-agent.ebpfEnabled" -}}
{{- ne (toString (dig "networkFlows" "enabled" true (.Values.agent | default dict))) "false" -}}
{{- end -}}

{{/* The eBPF pod filter (ADR-121): on unless agent.networkFlows.podFilter is false; a missing key means on. */}}
{{- define "watchlog-agent.podFilter" -}}
{{- ne (toString (dig "networkFlows" "podFilter" true (.Values.agent | default dict))) "false" -}}
{{- end -}}

{{/* HTTP stats on the service map (ADR-139): on unless agent.networkFlows.http is false; a missing key means on. */}}
{{- define "watchlog-agent.httpStats" -}}
{{- ne (toString (dig "networkFlows" "http" true (.Values.agent | default dict))) "false" -}}
{{- end -}}

{{/* Node metrics scope (ADR-121): host, cgroup or auto; a missing or empty key means auto. */}}
{{- define "watchlog-agent.nodeMetricsScope" -}}
{{- $s := toString (dig "nodeMetricsScope" "auto" (.Values.agent | default dict)) -}}
{{- if not (has $s (list "host" "cgroup" "auto")) -}}
{{- if $s -}}{{- fail (printf "agent.nodeMetricsScope must be host, cgroup or auto, not %q" $s) -}}{{- end -}}
auto
{{- else -}}
{{- $s -}}
{{- end -}}
{{- end -}}

{{/*
Node agent container with eBPF (ADR-105): uid 0 because Linux gives added capabilities
to non-root processes only as ambient capabilities, which Kubernetes cannot set; every
capability except BPF and PERFMON stays dropped, no privilege escalation.
*/}}
{{- define "watchlog-agent.nodeAgentSecurity" -}}
{{- if eq (include "watchlog-agent.ebpfEnabled" .) "true" -}}
runAsUser: 0
runAsNonRoot: false
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
  add: [BPF, PERFMON]
{{- else -}}
{{ include "watchlog-agent.containerSecurity" . }}
{{- end -}}
{{- end -}}
{{- define "watchlog-agent.podSecurity" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Endpoint and token for both agents. */}}
{{- define "watchlog-agent.env" -}}
- name: WATCHLOG_ENDPOINT
  value: {{ tpl (required "set watchlog.endpoint, the WatchLog URL the agents push to" .Values.watchlog.endpoint) . | quote }}
- name: WATCHLOG_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "watchlog-agent.tokenSecret" . }}
      key: {{ .Values.watchlog.existingSecretKey }}
{{- end -}}
