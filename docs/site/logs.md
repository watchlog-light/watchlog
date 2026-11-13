---
title: Container logs on demand
description: Read the last lines of a pod's or a Docker container's log in WatchLog, redacted and never stored, who may read them, and how to turn it off.
---

# Container logs on demand

When a pod crash-loops or a container keeps exiting, its last lines are usually the answer.
WatchLog shows them where you already look: open the pod or the container and read its log,
without `kubectl logs` or `docker logs`.

**What it is:** the last lines of one container's log, read when you ask, passed through the
WatchLog server to your browser, and then gone.

**What it isn't:** log management. There is no search, no filter across containers, no
history, no retention and no download of more than what you see. WatchLog never stores log
lines: not in its database, not in its metrics store, not in the agent's buffer, not in request
logs and not in the MCP call log. If you need to keep or search logs, keep using a log tool for
that.

## Where to find it

- **Kubernetes:** the **Logs** panel on a pod's page. Pick the container and how many lines.
  **Previous run** shows the container's last run before its latest restart, which is what you
  want for a crash loop.
- **Docker:** the **Logs** panel on a container's page. Each line is marked stdout or stderr.
  A stopped container's log is readable for as long as Docker keeps the container.
- **Follow:** turn it on to see new lines as they are written, for up to 5 minutes while the
  panel stays open.
- **Copy** copies the lines shown.
- **API:** `GET /api/v1/clusters/{id}/pods/{namespace}/{pod}/logs` and
  `GET /api/v1/clusters/{id}/docker/hosts/{host}/containers/{name}/logs` (see the
  [REST API](api.md)).
- **MCP:** the `get_container_logs` tool gives your assistant the same lines (see
  [Ask your cluster](mcp.md)).

## How it works

The WatchLog server never connects into your cluster or hosts. When you open the Logs panel,
the server holds your request, and the agent that is already connected out picks it up within a
second:

- **Kubernetes:** the cluster-agent reads the pod's log through the Kubernetes API, the same
  call `kubectl logs` makes. It needs `get` on `pods/log`, nothing more.
- **Docker:** the host's agent reads the container's log from the Docker API
  (`/containers/{id}/logs`), read-only.

Before a line leaves your cluster or host, the agent redacts it the way it redacts health check
output: passwords in `password=…` pairs, JSON fields such as `"password": "…"` and URLs
(`user:pass@`), `Authorization` and `Cookie` headers, API keys, tokens and JWTs become `***`.
Redaction is pattern-based and can't recognise every secret; the panel says how many lines it
changed. Control characters and colour codes are removed.

## Limits

| Limit                        | Value                                                     |
| ---------------------------- | --------------------------------------------------------- |
| Lines per read               | 100, 200 (default), 500 or 1,000; the API takes 1–1,000   |
| One line                     | Cut at 2 KB, ending in `…`                                |
| One answer                   | 512 KB; the oldest lines are left out first, and it says  |
| Follow                       | 5 minutes, then it stops; start it again if you need to   |
| Reads per user               | 30 a minute                                               |
| Follows open at once         | 3 per user, 50 per installation                           |
| `get_container_logs` (MCP)   | At most 200 lines and 16 KB, newest last                  |
| No agent picks it up in 10 s | The answer says so: the agent is older than 0.5.0, or off |

## Kubernetes and Docker

|                   | Kubernetes                                   | Docker                                                                       |
| ----------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Read by           | The cluster-agent, through the API server    | The host's agent, through the Docker socket                                  |
| stdout and stderr | Merged by Kubernetes, not marked             | Each line marked                                                             |
| Previous run      | Yes, the container's last run                | No; a stopped container's log stays while it exists                          |
| Which logs        | Whatever the kubelet keeps for the container | Containers with the `json-file`, `local` or `journald` driver; others say so |

## Who can read logs

Logs can contain things that metrics don't, so there are three switches.

- **Every signed-in role by default, Viewers included.** The teammate on call is often a
  Viewer, and reading a log changes nothing. API tokens and MCP read with their user's role.
- **Settings → General → Container logs:** _Every role_, _Owners and Admins only_ or _Off_.
  Owners and Admins change it. A Viewer who isn't allowed sees why in the panel.
- **Every read is recorded** with who, which container, how many lines, whether it followed and
  when. The lines themselves are never recorded.

## Turn it off for an installation

Logs on demand is on by default. Turning it off on the agent side means the agent refuses every
request, whatever the setting in WatchLog says.

- **Helm, `watchlog-agent` chart:** `logs.enabled: false`. The cluster-agent then has no
  `pods/log` permission at all.
- **Helm, `watchlog` chart:** `watchlog-agent.logs.enabled: false`.
- **Docker:** add `-e WATCHLOG_LOGS=false` to the agent's `docker run` command and re-create the
  container.

The Logs panel then says that logs are turned off for this cluster or host.

An upgrade to 0.5.0 turns it on, and grants the cluster-agent `get` on `pods/log`. Set the value
before upgrading if you don't want that.
