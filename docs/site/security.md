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

## Integrations collector (Applications)

Services you monitor on the Applications page (Redis, PostgreSQL, Nginx, RabbitMQ) are read by a separate collector, never by the node agent, which still reads no secrets.

- **Read-only by construction.** It runs a fixed list of statements and commands for each kind of service, written in the code. Nothing the server sends is ever executed. The users WatchLog asks you to create get monitoring roles only, such as PostgreSQL's `pg_monitor`, which reads statistics, never table data.
- **Kubernetes:** one Deployment per cluster, as uid 65532 with every capability dropped and a read-only root filesystem. It has no ClusterRole. It reads a Secret only if you name one, and only after you grant its ServiceAccount that one Secret. WatchLog shows the exact `kubectl create role … --resource-name` command.
- **Docker:** one container on each host that runs a monitored service, started with:

  | Setting                                              | Why                                                                                                                                             |
  | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | `--network host`                                     | It reaches each container at its address on the host's bridge networks, without joining them.                                                   |
  | `--user 0:0 --cap-drop ALL`                          | It reads root-owned `0600` files under `/etc/watchlog/secrets/` when you keep a password there. Every capability is dropped; no `--privileged`. |
  | `--read-only --tmpfs /var/lib/watchlog-integrations` | Nothing is written outside a small buffer in memory.                                                                                            |
  | `--security-opt no-new-privileges`                   | No privilege gain through setuid binaries.                                                                                                      |

  It mounts no Docker socket and no host filesystem other than that secrets directory, read-only.

- **Credentials:** a password WatchLog generates or you type in is stored encrypted with AES-256-GCM under the same key as alert channel secrets, tied to that one service: copied to another, it can't be decrypted. The API never returns it; the generated password appears once, inside the command you run to create the user. Only the collector of that service's cluster receives it, over TLS, and keeps it in memory. Who set or changed a credential, and when, is recorded, never the value.
- **Or keep the password yourself:** in a Kubernetes Secret, which the collector may read only after you run the two `kubectl create role/rolebinding` lines WatchLog shows for that one Secret; or in a file under `/etc/watchlog/secrets/` on the Docker host. WatchLog then stores only the name.
- **Least privilege, checked:** the user WatchLog creates gets monitoring rights only (PostgreSQL's `pg_monitor`; a Redis ACL of read-only commands). If you use an existing user that can do more, such as a superuser, the connect drawer says so.
- **Push only:** like the agents, the collector connects out to your WatchLog server. The server never connects into your cluster or hosts.

## What is sent, and how

- **Every 15 seconds over HTTPS:** metrics (CPU, memory, disk, network; container and pod resource use; connection counts), heartbeats (agent version, mode, node name and whether eBPF runs, with the reason if not), and object summaries (names, states, restart and exit reasons).
- **No** IP addresses as labels, process names, file contents or payloads.
- **Agent tokens:** `wl_ct_` plus 256 random bits. The server stores only a SHA-256 hash; you can rotate tokens and revoke them at once.
- **Network:** agents connect out to your WatchLog server only.

## The server

- **Secrets at rest:** alert channel secrets (Slack webhooks, Telegram tokens, webhook signing secrets), the email server password and service credentials are encrypted with AES-256-GCM under a key you keep. The API never returns them. You can rotate the key without downtime (see [Configuration](configuration.md#rotating-the-secret-key)).
- **Passwords:** hashed with argon2id. Sessions use secure cookies behind HTTPS, with CSRF protection and rate-limited sign-in.
- **Containers:** all server containers run as non-root with every capability dropped.
- **Images:** the agent image is `FROM scratch` with one static binary.
- **Signing:** release images and charts are signed with cosign (keyless). How to verify is in each release's notes.

## Users and roles

- **Three roles.** Viewers see everything and change nothing: no settings, rules, integrations or silences; they can make personal read-only API tokens. Admins run the clusters: rules, channels, silences, services and their credentials, and they invite and manage Admins and Viewers. There is one Owner, who can also hand ownership to an Admin and delete clusters.
- **Enforced by the server.** Every route that changes something names the roles it allows, and a test fails if one doesn't. The dashboard shows locked controls to Viewers with the reason; the server refuses the same change.
- **Invites and password resets are links.** An invite works once, for 7 days; a password reset works once, for an hour. The server keeps only a SHA-256 hash of each token (and, while an invite is pending, an encrypted copy so it can be copied again). With email set up they are also sent by email; without it you share the link yourself.
- **Resetting signs out everywhere.** The old password keeps working until a new one is set; setting it ends every session of that account.
- **Removing a user** signs them out and revokes their API tokens at once. What they set up stays.
- **Locked out?** The Owner can print a reset link inside the backend container with `watchlog admin reset-password` (see [Configuration](configuration.md#a-locked-out-owner)). Anyone who can run a command there already controls the install.
- **Audit:** invites, role changes, reset links (including from the command line), removals and the ownership handover are logged with who, when and from which address, shown to Owners and Admins. Never a token or a password.

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
