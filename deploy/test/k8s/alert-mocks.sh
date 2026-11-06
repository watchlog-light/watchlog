#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Phase 3 e2e (ADR-082, ADR-086): in-cluster stand-ins for the alert channels —
# mock-channels (Slack, Telegram Bot API, webhook) and Mailpit (SMTP) — in namespace
# wl-alert-mocks. No test reaches a real provider.
#   alert-mocks.sh <kube-context>
set -euo pipefail
ctx=$1
here=$(dirname "$0")
k() { kubectl --context "$ctx" "$@"; }
k create namespace wl-alert-mocks --dry-run=client -o yaml | k apply -f - >/dev/null
k -n wl-alert-mocks create configmap mock-channels --from-file=mock.py="$here/mock-channels.py" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f - >/dev/null <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: { name: mock-channels, namespace: wl-alert-mocks }
spec:
  selector: { matchLabels: { app: mock-channels } }
  template:
    metadata: { labels: { app: mock-channels } }
    spec:
      containers:
        - name: mock
          image: python:3.13-alpine
          command: [python, /app/mock.py]
          ports: [{ containerPort: 8080 }]
          readinessProbe: { httpGet: { path: /health, port: 8080 }, periodSeconds: 2 }
          volumeMounts: [{ name: app, mountPath: /app }]
      volumes: [{ name: app, configMap: { name: mock-channels } }]
---
apiVersion: v1
kind: Service
metadata: { name: mock-channels, namespace: wl-alert-mocks }
spec:
  selector: { app: mock-channels }
  ports: [{ port: 8080, targetPort: 8080 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: mailpit, namespace: wl-alert-mocks }
spec:
  selector: { matchLabels: { app: mailpit } }
  template:
    metadata: { labels: { app: mailpit } }
    spec:
      containers:
        - name: mailpit
          image: axllent/mailpit:v1.27
          ports: [{ containerPort: 1025 }, { containerPort: 8025 }]
          readinessProbe: { httpGet: { path: /readyz, port: 8025 }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata: { name: mailpit, namespace: wl-alert-mocks }
spec:
  selector: { app: mailpit }
  ports: [{ name: smtp, port: 1025 }, { name: http, port: 8025 }]
YAML
# Both keep messages in memory: on a reused cluster, start each run empty, or the
# earlier run's firing and resolve messages count again.
k -n wl-alert-mocks rollout restart deploy/mock-channels deploy/mailpit >/dev/null
for d in mock-channels mailpit; do k -n wl-alert-mocks rollout status deploy/$d --timeout 180s >/dev/null; done
