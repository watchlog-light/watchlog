{{/* SPDX-License-Identifier: AGPL-3.0-only */}}
{{- define "watchlog.labels" -}}
app.kubernetes.io/name: watchlog
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "watchlog.selector" -}}
app.kubernetes.io/instance: {{ index . 0 }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- define "watchlog.image" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}
{{- printf "%s/%s:%s" $root.Values.image.registry $name (default $root.Chart.AppVersion $root.Values.image.tag) -}}
{{- end -}}

{{/* A generated value kept across upgrades: the existing Secret's key, else random. */}}
{{- define "watchlog.keep" -}}
{{- $root := index . 0 -}}{{- $secret := index . 1 -}}{{- $key := index . 2 -}}{{- $fresh := index . 3 -}}
{{- $existing := lookup "v1" "Secret" $root.Release.Namespace $secret -}}
{{- if and $existing (index $existing.data $key) -}}
{{- index $existing.data $key | b64dec -}}
{{- else -}}
{{- $fresh -}}
{{- end -}}
{{- end -}}

{{- define "watchlog.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ . }}
runAsGroup: {{ . }}
fsGroup: {{ . }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}
{{- define "watchlog.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "watchlog.databaseEnv" -}}
- name: WATCHLOG_DB_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ .Release.Name }}-postgresql, key: password } }
- name: DATABASE_URL
  value: postgres://watchlog:$(WATCHLOG_DB_PASSWORD)@{{ .Release.Name }}-postgresql:5432/watchlog
{{- end -}}

{{/*
What the backend and the alert-worker share for alerting (ADR-079, ADR-080): the
secret key, the public URL for links, SMTP, the Telegram API and the outbound proxy.
*/}}
{{- define "watchlog.alertingEnv" -}}
{{- $alerting := include "watchlog.alerting" . | fromYaml -}}
- name: WATCHLOG_SECRET_KEY
  valueFrom: { secretKeyRef: { name: {{ .Release.Name }}-secret-key, key: key } }
{{- with .Values.secretKeyPrevious }}
- { name: WATCHLOG_SECRET_KEY_PREVIOUS, value: {{ . | quote }} }
{{- end }}
{{- with .Values.publicUrl }}
- { name: WATCHLOG_PUBLIC_URL, value: {{ . | quote }} }
{{- end }}
{{- if $alerting.smtpUrl }}
- name: WATCHLOG_SMTP_URL
  valueFrom: { secretKeyRef: { name: {{ .Release.Name }}-smtp, key: url } }
- { name: WATCHLOG_SMTP_FROM, value: {{ $alerting.smtpFrom | quote }} }
{{- end }}
{{- with $alerting.telegramApiUrl }}
- { name: WATCHLOG_TELEGRAM_API_URL, value: {{ . | quote }} }
{{- end }}
{{- with $alerting.httpsProxy }}
- { name: HTTPS_PROXY, value: {{ . | quote }} }
{{- end }}
{{- with $alerting.noProxy }}
- { name: NO_PROXY, value: {{ . | quote }} }
{{- end }}
{{- end -}}

{{/*
Values added after the first chart release, with their defaults: `helm upgrade
--reuse-values` from an older release hands the templates that release's values, where
these maps are missing (ADR-107; deploy/test/helm/upgrade-test.sh). A key that is set,
even to 0 or false, is kept.
*/}}
{{- define "watchlog.withDefaults" -}}
{{- $set := index . 0 | default dict -}}
{{- $out := dict -}}
{{- range $k, $v := index . 1 -}}
{{- $_ := set $out $k (ternary (index $set $k) $v (hasKey $set $k)) -}}
{{- end -}}
{{- toYaml $out -}}
{{- end -}}
{{- define "watchlog.alerting" -}}
{{- include "watchlog.withDefaults" (list .Values.alerting (dict "smtpUrl" "" "smtpFrom" "WatchLog <alerts@example.com>" "telegramApiUrl" "" "httpsProxy" "" "noProxy" "")) -}}
{{- end -}}
{{- define "watchlog.alertWorker" -}}
{{- include "watchlog.withDefaults" (list .Values.alertWorker (dict "replicas" 1 "resources" (dict "requests" (dict "cpu" "50m" "memory" "128Mi") "limits" (dict "memory" "256Mi")))) -}}
{{- end -}}
