---
title: Security
description: What the WatchLog agent can and cannot access on your nodes and containers, what it sends, how it is secured, and what API tokens and MCP can read.
---

# What the agent can and cannot access

WatchLog's agents are read-only. They never run commands you didn't install, never write to your cluster or hosts, and send data out; nothing connects in.

**Never collected, never sent:** Secrets, ConfigMap data, environment variable values, command lines, request or response payloads, and TLS contents. There is no TLS inspection, ever.

This page summarises [docs/security.md](https://github.com/watchlog-light/watchlog/blob/main/docs/security.md) in the repository, which has every detail and the decision behind it. That document changes in the same pull request as any change to what the agent can access.

## Kubernetes

Two agents with separate permissions:

- **Cluster-agent** (one Deployment) watches the Kubernetes API.
- **Node agent** (a DaemonSet) reads its own node. It never talks to the API server.

### Cluster-agent permissions

| Can read (get, list, watch)                                                                  | Why                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| nodes, namespaces, pods, persistentvolumeclaims                                              | Inventory, node and pod views                |
| deployments, replicasets, statefulsets, daemonsets, jobs, cronjobs, horizontalpodautoscalers | Workload views                               |
| events                                                                                       | Kubernetes events                            |
| services, endpointslices                                                                     | Service map: which pods are behind a Service |

It can also create TokenReviews, to check that a node agent is who it says, and use a Lease in its own namespace for leader election.

**No access** to Secrets, ConfigMaps, `nodes/proxy`, Ingresses or PersistentVolumes. Objects are trimmed before they're sent: no environment variables, commands, arguments, probe commands, termination messages or `managedFields`. Annotations are kept only from a short allow-list, such as the deployment revision.

### Node agent

- **Permissions:** `nodes/stats` on its own node's kubelet (`/stats/summary`), nothing else. It doesn't use the container runtime socket or `nodes/proxy`.
- **Host access:** read-only mounts of `/proc`, `/sys` and `/`, for host, container and filesystem metrics. No `hostPID`, no `hostNetwork`, read-only root filesystem, seccomp `RuntimeDefault`, no privilege escalation.
- **Capabilities:** with network flows on (the default), the container runs as uid 0 with **every capability dropped except `BPF` and `PERFMON`**. Linux only makes added capabilities effective for uid 0 in Kubernetes. Without `DAC_OVERRIDE`, root still can't write host files, and the mounts are read-only anyway. With `agent.networkFlows.enabled=false` it runs as uid 65532 with no capabilities.
- **Namespace:** it needs the `privileged` PodSecurity level, only because of the read-only hostPath mounts.

## Network flows (eBPF)

The kernel programs read:

- **TCP connections:** destination address and port, local port and state, state changes, retransmits and byte counts. Never the data itself. Counters are added up in the kernel per container, destination and port, and read every 15 seconds.
- **DNS outcomes:** the 12-byte header of DNS responses, for NXDOMAIN, SERVFAIL and timeouts per workload.
- **DNS names of external services:** for a successful DNS response, the agent reads the question and the A, AAAA and CNAME answers. That lets an external edge show `api.stripe.com:443` instead of `104.18.0.0/24:443`. The names stay in agent memory (at most 10,000, for the record's TTL), are never written to disk, and are sent only as that edge's destination name.

Edges carry workload names, never pod IPs. An external destination is a DNS name or a `/24` network.

## Docker hosts

The install command, and why each setting is there:

| Setting                                                         | Why                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--user 0:65532 --cap-drop ALL --cap-add BPF --cap-add PERFMON` | Network flows need `BPF` and `PERFMON`. Every other capability is dropped; no `--privileged`.                                            |
| `--security-opt no-new-privileges`                              | No privilege gain through setuid binaries.                                                                                               |
| `-v /var/run/docker.sock:...:ro`                                | Only `/_ping`, `/version`, container list, inspect and stats, and `/events` are called. The client refuses anything else before sending. |
| `-v /proc`, `/sys`, `/` read-only                               | Host and container metrics, filesystem usage.                                                                                            |
| `--pid host`                                                    | So the mounted `/proc` describes the host, not the agent's container.                                                                    |
| volume `watchlog-agent-state`                                   | Buffer while the server is unreachable.                                                                                                  |

Docker's inspect response contains a container's environment variables. The agent never decodes, stores, logs or sends them, nor the command line.

Health-check commands and probe output can contain credentials. The agent redacts passwords, tokens, auth headers and keys before sending, folds output to one line of at most 512 bytes, and `WATCHLOG_HEALTH_OUTPUT=false` turns output off entirely.

## What is sent, and how

- **Every 15 seconds over HTTPS:** metrics (CPU, memory, disk, network; container and pod resource use; connection counts), heartbeats (agent version, mode, node name and whether eBPF runs, with the reason if not), and object summaries (names, states, restart and exit reasons).
- **No** IP addresses as labels, process names, file contents or payloads.
- **Agent tokens:** `wl_ct_` plus 256 random bits. The server stores only a SHA-256 hash; you can rotate tokens and revoke them at once.
- **Network:** agents connect out to your WatchLog server only.

## The server

- **Secrets at rest:** alert channel secrets (Slack webhooks, Telegram tokens, webhook signing secrets) are encrypted with AES-256-GCM under a key you keep. The API never returns them.
- **Passwords:** hashed with argon2id. Sessions use secure cookies behind HTTPS, with CSRF protection and rate-limited sign-in.
- **Containers:** all server containers run as non-root with every capability dropped.
- **Images:** the agent image is `FROM scratch` with one static binary.
- **Signing:** release images and charts are signed with cosign (keyless). How to verify is in each release's notes.

## API tokens and MCP

- **Personal API tokens** (Settings → API tokens) are `wl_pat_` plus 256 random bits. The server keeps only a SHA-256 hash. The value is shown once, when you create the token.
- **Read only:** a token reads only the documented [REST API](api.md) routes and the [MCP server](mcp.md), and only what its user can see. It can't change anything: no setting, rule, channel or cluster.
- **Never returned to a token:** Secrets, environment values, payloads, alert channel targets, email and Telegram settings, other tokens, and the error text of a failed alert delivery, which can name your mail server or part of a webhook address.
- **Expiry and revocation:** tokens expire after 30 days, 90 days or a year, or never if you choose. You get an email 7 days before. Revoking stops a token at the next request.
- **Each token's history:** when it was created, its first use, use from a new address, and its expiry or revocation.
- **MCP call log:** each tool call's tool, a short argument summary, status, time and answer size, never the answer itself. Kept 30 days.
- **Limits:** 300 requests and 60 tool calls a minute per token.
- **Prompt injection:** names and messages from your cluster reach an AI assistant only as data, in their own fields, cleaned and cut to a fixed length. Since every tool only reads, an injected instruction can't make WatchLog do anything. See [Ask your cluster](mcp.md#security).
- **Turning MCP off:** set `mcp.enabled: false` (Helm) or `WATCHLOG_MCP_ENABLED=false` (Compose).

## Reporting a vulnerability

Please report privately. See [SECURITY.md](https://github.com/watchlog-light/watchlog/blob/main/SECURITY.md).
