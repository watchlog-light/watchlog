---
title: Probable cause
description: How WatchLog names the likely cause of an alert or a problem on Kubernetes and Docker, the twelve rules it uses, and where the answer shows up.
---

# Probable cause

When something breaks, WatchLog tells you why it most likely broke and shows the evidence. One
sentence first, then the chain behind it:

```text
Likely cause: web fails because api was scaled to 0: nothing answers its calls.

1. causes-e2e/web → causes-e2e/api   100% of its calls fail.        (service map)
      calls
2. causes-e2e/api                    It has no pods.                (Kubernetes)
      because
3. api                               Scaled from 1 to 0 replicas.   (change)   ← where it starts
```

It works the same on Kubernetes clusters and Docker hosts, in every edition, with no setup. It
uses only what WatchLog already collects: the state of pods, containers and nodes, their events
and restarts, the metrics, the change markers (rollouts, image changes, scaling), the service
map's connections and HTTP calls, DNS lookups, and the findings of monitored applications.

**No AI and no scores.** The answer comes from fixed rules over that data. The same data gives the
same answer, and every step names the fact it rests on.

## Likely, Possible, No clear cause

| Answer             | Meaning                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Likely**         | One rule explains the symptom completely: every step of its chain is in the data, and the cause began before or with the symptom. At most one cause is likely.                            |
| **Possible**       | A rule fits part of the way: a step is missing, or the timing can't prove it. Treat it as a lead to check. Up to three causes are shown.                                                  |
| **No clear cause** | Nothing WatchLog checked explains it. "What we checked" lists each check (the object itself, its events, recent changes, the node or host, CPU, its dependencies, DNS) and what it found. |

There are no percentages: a cause is either proven by the data or it isn't.

## The rules

Each rule looks at the object, at what is under it (its node or host), or across the service map
(what it calls). The walk follows up to two hops: a frontend failing because its API has no pods,
because the API was scaled to 0. It looks at the last 60 minutes.

| Rule                           | Kubernetes                                                                                                                                                     | Docker                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Out of memory at its limit** | A container is OOM-killed when it reaches its memory limit, again and again                                                                                    | The container is OOM-killed at its memory limit                                                 |
| **Crashes**                    | A container exits with a non-zero code and restarts with back-off                                                                                              | The container exits with a non-zero code and its restart policy restarts it                     |
| **A bad change**               | It fails since a rollout, an image change or a config change; or a dependency got slow or failing right after its own change                                   | The same, after the container was re-created with a new image or settings                       |
| **Image can't be pulled**      | New pods can't pull their image (no such image or tag, no access)                                                                                              | (Kubernetes only: Docker reports a failed pull to whoever ran it)                               |
| **Can't be scheduled**         | Pending: it requests more CPU or memory than any node has free, or no node tolerates it                                                                        | (Kubernetes only: Docker has no scheduler)                                                      |
| **A Job failed**               | A Job's pods exited with an error until it reached its backoff limit                                                                                           | (Kubernetes only: a one-shot container that fails is a crash)                                   |
| **A dependency is down**       | Something it calls has no ready pods: scaled to 0, crashing, out of memory                                                                                     | A container it calls is stopped or failing                                                      |
| **Connections fail**           | Its connections to a running target fail: nothing accepts connections on that port                                                                             | The same, between containers                                                                    |
| **A name doesn't exist**       | Its DNS lookups get NXDOMAIN (no such name)                                                                                                                    | The same                                                                                        |
| **An application finding**     | A monitored application explains it: a queue with no consumer (and why the consumer is gone), PostgreSQL out of connections (and who holds them), Redis, Nginx | The same                                                                                        |
| **The node or host**           | Its node is NotReady, cordoned, under memory, disk or PID pressure, or evicted its pods; a node reboot                                                         | The host stopped reporting, is out of memory or disk, or restarted (containers stopped with it) |
| **CPU throttling**             | It, or what it calls, is throttled at its CPU limit at least 25% of the time, and calls slowed with it                                                         | The same, at the container's CPU limit                                                          |

The rules that follow the service map need network flows (the agent's eBPF collector). With flows
off, the answer says so, and those rules can't run.

## Where you see it

- **Alert detail:** the panel above the chart, the cause's moments marked on the chart.
- **Overview, Needs attention:** one line under each problem: the chip and the sentence.
- **Pods, workloads, Docker containers and Compose services:** the panel on their pages when they
  have a problem.
- **Service map:** the panel for a failing or slow connection, in the side panel.
- **Applications:** beside a finding.

**Copy as text** copies the sentence and the chain, for a ticket or a chat.

## In alert messages

When an alert fires and its cause is likely, Slack, Telegram and email get one more line,
`Likely cause: …`, and the webhook gets a `likelyCause` field. The resolve message says
`Was likely: …`. A possible cause or no clear cause adds nothing, and the message never waits more
than 2 seconds for it. See [Alerts and notifications](alerts.md#the-likely-cause).

## Ask your AI

Over [MCP](mcp.md), your assistant gets the same evidence: `explain_alert` includes the causes,
`explain_problem` answers for any workload, pod, container, Compose service, connection or
application, and `get_problems` carries each problem's likely cause.

## API

`GET /api/v1/causes?cluster=<cluster id>&subject=<subject>` returns the whole answer: the state,
the sentence as a code with its facts, the causes with their chains, and the checks. A subject is
`alert:<id>`, `pod:<namespace>/<pod>`, `workload:<namespace>/<name>`, `container:<host>/<name>`,
`compose_service:<project>/<service>`, `edge:<edge id>` or `application:<id>`. The alert detail,
the overview's problems and the applications carry a short `likelyCause` when one cause is likely.
See [API](api.md).

## Limits

- It explains from the last 60 minutes and up to two hops along the service map.
- It names a cause only from data WatchLog has: it can't see inside your code, and it doesn't
  guess.
- A cause that started after the symptom is at most possible.
