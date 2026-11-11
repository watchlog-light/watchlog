---
title: Alerts and notifications
description: Where WatchLog sends alerts, what a message says (including the likely cause), and the webhook's JSON payload.
---

# Alerts and notifications

WatchLog evaluates its alert rules every 30 seconds and sends a message when an alert fires,
escalates, keeps firing past the reminder interval, flaps, and when it resolves. Default rules
cover crash loops, OOM kills, pods stuck pending, image pull errors, unavailable deployments,
node pressure and NotReady nodes, unhealthy or restarting Docker containers, failing
connections between services and agents that stop reporting. Each rule sends to the channels
you pick for it.

## Channels

| Channel  | What you set                                           | Format                                |
| -------- | ------------------------------------------------------ | ------------------------------------- |
| Slack    | An incoming webhook URL                                | Block Kit, coloured by severity       |
| Telegram | A bot token; you connect the chat with a one-time link | HTML                                  |
| Email    | Recipients; the server's SMTP settings                 | Plain text                            |
| Webhook  | A URL, and a signing secret (made for you if empty)    | JSON, signed with HMAC-SHA256 (below) |

"Send test" on a channel sends one message at once and shows the provider's answer. Slack,
Telegram and webhooks go through `HTTPS_PROXY` when it is set.

## What a message says

What is wrong, why, where and since when, with a link to the object in WatchLog:

```text
🟠 WARNING · web cannot reach api

100% of connections failed · threshold 5%
causes-e2e/web (Deployment) · cluster kind · since 23:31 UTC (5 min)
Likely cause: web fails because api was scaled to 0: nothing answers its calls.
https://watchlog.example.com/workloads?cluster=…&ns=causes-e2e
```

### The likely cause

When an alert fires, WatchLog works out its probable cause (the same answer as the alert's
page and `GET /api/v1/causes`) and adds one line when one cause is **likely**:

- `Likely cause: …` on the firing message, the escalation and the reminders;
- `Was likely: …` on the resolve message, repeating what the firing message said.

A message gets no line when the causes are only possible, when no cause is clear, or when the
answer isn't ready within 2 seconds: the message is never held back longer for it. The cause
is worked out once, as the alert fires, and kept with the alert; the alert's page always shows
today's answer, and its timeline marks the messages that carried the line ("with the likely
cause"). It works the same for Kubernetes clusters and Docker hosts.

## Webhook payload

A `POST` with `content-type: application/json` and these headers:

- `x-watchlog-event`: `firing`, `escalated`, `renotify`, `flapping`, `resolved` or `test`;
- `x-watchlog-delivery`: the message's id, the same on every retry (use it to deduplicate);
- `x-watchlog-signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` with the
  channel's signing secret.

```json
{
  "version": 1,
  "event": "firing",
  "severity": "warning",
  "rule": {
    "id": "…",
    "key": "network.connections.failed",
    "name": "Service-to-service failed connections",
    "metric": null
  },
  "cluster": {
    "id": "…",
    "name": "kind"
  },
  "alerts": [
    {
      "id": "…",
      "severity": "warning",
      "labels": {
        "namespace": "causes-e2e",
        "workload": "web",
        "workload_kind": "Deployment",
        "dst_kind": "workload",
        "dst_namespace": "causes-e2e",
        "dst_workload": "api",
        "dst_workload_kind": "Deployment",
        "dst_service": "api"
      },
      "title": "web cannot reach api",
      "why": "100% of connections failed · threshold 5%",
      "summary": "100 % of connections failed",
      "started_at": "2026-11-10T23:31:48.906Z",
      "fired_at": "2026-11-10T23:36:48.917Z",
      "resolved_at": null,
      "link": "https://watchlog.example.com/workloads?cluster=…&ns=causes-e2e",
      "likelyCause": {
        "rule": "dependency_down",
        "code": "dependency_down",
        "facts": {
          "name": "web",
          "target": "api",
          "platform": "kubernetes",
          "ready": 0,
          "desired": 0
        },
        "since": "2026-11-10T23:30:50.628Z",
        "headline": {
          "code": "dependency_down_scaled",
          "facts": {
            "name": "web",
            "target": "api"
          }
        },
        "subject": "alert:…",
        "text": "web fails because api was scaled to 0: nothing answers its calls.",
        "chain": [
          {
            "subject": "edge:w:causes-e2e/Deployment/web>w:causes-e2e/Deployment/api:9898",
            "name": "causes-e2e/web → causes-e2e/api",
            "fact": "edge_failed",
            "facts": {
              "pct": 99.3,
              "port": 9898
            },
            "since": "2026-11-10T23:31:00.000Z"
          },
          {
            "subject": "workload:causes-e2e/Deployment/api",
            "name": "causes-e2e/api",
            "fact": "no_pods",
            "facts": {},
            "since": "2026-11-10T23:30:50.628Z"
          },
          {
            "subject": "change:Deployment/causes-e2e/api",
            "name": "api",
            "fact": "scaled",
            "facts": {
              "from": 1,
              "to": 0
            },
            "at": "2026-11-10T23:30:50.628Z"
          }
        ]
      }
    }
  ],
  "total": 1,
  "alerts_link": "https://watchlog.example.com/alerts?rule=…&cluster=…",
  "sent_at": "2026-11-10T23:36:50.576Z"
}
```

A message lists at most five alerts (`total` counts them all). `likelyCause` is optional and
appears only on an alert that had a likely cause when it fired, on its firing, escalation,
reminder and resolve messages:

| Field            | Meaning                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `rule`, `code`   | The rule that found it (one of twelve, such as `dependency_down`, `oom_limit`) and its finding                     |
| `facts`, `since` | The facts behind it, and when the cause began (or `null`)                                                          |
| `headline`       | The answer's first sentence as a code with facts                                                                   |
| `text`           | That sentence in English: the message's line                                                                       |
| `subject`        | Ask `GET /api/v1/causes?cluster=<cluster.id>&subject=<subject>` for the whole answer                               |
| `chain`          | The evidence, symptom first: each step's object (`subject`, `name`), `fact` (a code), `facts`, and `since` or `at` |

New fields may be added to the payload; `version` changes only when a field changes meaning or
goes away.
