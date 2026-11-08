---
title: Configuration
description: Helm values, Docker Compose settings and agent options for WatchLog.
---

# Configuration

Defaults work for most installs. This page lists what you can change.

## Helm chart `watchlog` (server and agents)

| Value                                                                                              | Default                                 | What it does                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicUrl`                                                                                        | `''`                                    | The URL people use to open WatchLog, used in alert links and install commands.                                                                                                                          |
| `admin.email`, `admin.password`                                                                    | `''`                                    | Create the admin at install time instead of using the setup code.                                                                                                                                       |
| `secretKey`                                                                                        | generated                               | Key for alert channel secrets (32 bytes, base64). Set it only to restore a backup.                                                                                                                      |
| `clusterName`                                                                                      | `kubernetes`                            | Name of this cluster in WatchLog.                                                                                                                                                                       |
| `demoMode`                                                                                         | `false`                                 | A read-only public demo: visitors enter as a viewer without a password, and every change is refused, even for admins. Secrets, tokens and channel targets are never shown. Not for a real installation. |
| `mcp.enabled`                                                                                      | `true`                                  | The MCP server at `/mcp`, so AI assistants (Claude, Cursor) can read your clusters with a personal API token. It needs a token anyway; `false` turns it off, and tokens still read the REST API.        |
| `seed`                                                                                             | `{}`                                    | Alert rules created at every backend start, once each, matched by name and never overwritten. See [Seed file](#seed-file).                                                                              |
| `cookieSecure`                                                                                     | `auto`                                  | The session cookie's Secure attribute: `auto` when the request came over https, or `always` or `never`. See [Behind a reverse proxy](#behind-a-reverse-proxy).                                          |
| `image.registry`, `image.tag`                                                                      | `ghcr.io/watchlog-light`, chart version | Where WatchLog images come from: use a mirror for air-gapped installs.                                                                                                                                  |
| `backend.replicas`, `backend.resources`                                                            | 1, 192Mi–512Mi                          | API server.                                                                                                                                                                                             |
| `backend.eventsRetentionDays`                                                                      | 15                                      | How long Kubernetes events are kept.                                                                                                                                                                    |
| `backend.clientIpHeader`                                                                           | `''`                                    | A header your proxy sets to the visitor's address (nginx: `X-Real-IP`), so rate limits count each visitor. Set it only if the proxy always sets that header.                                            |
| `backend.clientCountryHeader`                                                                      | `''`                                    | A header your proxy sets to the visitor's country (Cloudflare: `CF-IPCountry`), shown with an API token's last use. Unset: no country.                                                                  |
| `backend.trustedProxies`                                                                           | loopback and private ranges             | The proxies whose client-IP header and `X-Forwarded-Proto` are believed, as CIDRs.                                                                                                                      |
| `alertWorker.replicas`                                                                             | 1                                       | Evaluates rules and sends notifications; replicas share the work.                                                                                                                                       |
| `alerting.smtpUrl`, `alerting.smtpFrom`                                                            | `''`                                    | SMTP server for email alerts, e.g. `smtp://user:pass@smtp.example.com:587`.                                                                                                                             |
| `alerting.telegramApiUrl`                                                                          | Telegram's                              | Telegram Bot API mirror, where api.telegram.org is blocked.                                                                                                                                             |
| `alerting.httpsProxy`, `alerting.noProxy`                                                          | `''`                                    | Outbound proxy for Slack, Telegram and webhook alerts.                                                                                                                                                  |
| `web.service.type`, `web.service.port`                                                             | `ClusterIP`, 8080                       | The UI's Service.                                                                                                                                                                                       |
| `ingress.enabled`, `ingress.host`, `ingress.className`, `ingress.tlsSecret`, `ingress.annotations` | off                                     | Expose the UI through an Ingress.                                                                                                                                                                       |
| `postgresql.storage`, `postgresql.storageClass`                                                    | 8Gi                                     | Database volume.                                                                                                                                                                                        |
| `victoriametrics.retention`, `victoriametrics.storage`                                             | `15d`, 20Gi                             | Metrics retention and volume.                                                                                                                                                                           |
| `victoriametrics.extraArgs`                                                                        | unset                                   | More VictoriaMetrics flags, as a list (`[-search.maxQueryDuration=10s]`) or a map.                                                                                                                      |
| `watchlog-agent.enabled`                                                                           | `true`                                  | Install the agents for this cluster.                                                                                                                                                                    |
| `watchlog-agent.*`                                                                                 | see below                               | Agent settings, prefixed with `watchlog-agent.`.                                                                                                                                                        |

## Helm chart `watchlog-agent` (agents only)

| Value                                                                       | Default                                 | What it does                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchlog.endpoint`                                                         | required                                | The WatchLog URL the agents push to.                                                                                                                                                                                              |
| `watchlog.clusterToken` or `watchlog.existingSecret`                        | required                                | The cluster token from Settings → Clusters, or a Secret that holds it (`existingSecretKey`, default `token`).                                                                                                                     |
| `agent.networkFlows.enabled`                                                | `true`                                  | eBPF network flows for the service map. When on, the node agent runs as uid 0 with only the `BPF` and `PERFMON` capabilities; when off, as uid 65532 with none. See [security](security.md).                                      |
| `agent.networkFlows.podFilter`                                              | `true`                                  | The kernel records only connections and DNS lookups of this node's pods. Processes outside the cluster on the same kernel are never recorded, only counted. See [nodes that are containers](#nodes-that-are-containers-kind-k3d). |
| `agent.nodeMetricsScope`                                                    | `auto`                                  | Where node metrics come from: `host`, `cgroup` or `auto`. See [nodes that are containers](#nodes-that-are-containers-kind-k3d).                                                                                                   |
| `agent.interval`                                                            | `15s`                                   | Collection interval.                                                                                                                                                                                                              |
| `agent.kubeletTLS`                                                          | `auto`                                  | Kubelet certificate check: `auto` verifies against the cluster CA and falls back if that fails, `verify` never falls back, `skip` never verifies.                                                                                 |
| `agent.resources`                                                           | 48Mi request, 128Mi limit               | Node agent resources. It stays within 64 MB of memory and 1 % of a core.                                                                                                                                                          |
| `agent.tolerations`, `agent.nodeSelector`, `agent.priorityClassName`        | every node                              | Where the node agent runs.                                                                                                                                                                                                        |
| `clusterAgent.enabled`, `clusterAgent.resources`, `clusterAgent.goMemLimit` | on, 128Mi–512Mi, 400MiB                 | The cluster-agent that watches the Kubernetes API.                                                                                                                                                                                |
| `image.registry`, `image.tag`, `image.pullPolicy`                           | `ghcr.io/watchlog-light`, chart version | Agent images.                                                                                                                                                                                                                     |

## Docker Compose server (`.env`)

| Variable                                             | Default    | What it does                                                                     |
| ---------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `WATCHLOG_DB_PASSWORD`                               | required   | PostgreSQL password.                                                             |
| `WATCHLOG_SECRET_KEY`                                | required   | Key for alert channel secrets: `openssl rand -base64 32`. Back it up.            |
| `WATCHLOG_PUBLIC_URL`                                | `''`       | How agents and browsers reach the server.                                        |
| `WATCHLOG_VERSION`                                   | `latest`   | Image version; pin it, e.g. `0.1.2`.                                             |
| `WATCHLOG_PORT`                                      | 8080       | The only published port.                                                         |
| `WATCHLOG_RETENTION`                                 | `15d`      | Metrics retention.                                                               |
| `WATCHLOG_SMTP_URL`, `WATCHLOG_SMTP_FROM`            | unset      | Email alerts.                                                                    |
| `HTTPS_PROXY`, `NO_PROXY`                            | unset      | Outbound proxy for alert deliveries.                                             |
| `WATCHLOG_TELEGRAM_API_URL`                          | Telegram's | Telegram Bot API mirror.                                                         |
| `WATCHLOG_ADMIN_EMAIL`, `WATCHLOG_ADMIN_PASSWORD`    | unset      | Create the admin at startup instead of the setup code.                           |
| `WATCHLOG_DEMO_MODE`                                 | unset      | `true` makes the server a read-only public demo, like the Helm value `demoMode`. |
| `WATCHLOG_MCP_ENABLED`                               | `true`     | `false` turns the MCP server off, like the Helm value `mcp.enabled`.             |
| `WATCHLOG_CLIENT_IP_HEADER`                          | unset      | Like the Helm value `backend.clientIpHeader`.                                    |
| `WATCHLOG_CLIENT_COUNTRY_HEADER`                     | unset      | Like the Helm value `backend.clientCountryHeader`.                               |
| `WATCHLOG_TRUSTED_PROXIES`, `WATCHLOG_COOKIE_SECURE` | unset      | Like the Helm values `backend.trustedProxies` and `cookieSecure`.                |

## Behind a reverse proxy

WatchLog's web container (Caddy) serves the dashboard and passes `/api` and `/ingest` to the backend. When nginx, an ingress or Cloudflare terminates TLS in front of it:

- **The session cookie is marked Secure when the visitor came over https.** The backend knows this from the TLS connection, or from `X-Forwarded-Proto: https` sent by a trusted proxy. Have your proxy set that header (nginx: `proxy_set_header X-Forwarded-Proto $scheme;`). Plain http, such as a LAN install or local development, keeps a cookie that works over http. `cookieSecure: always` (`WATCHLOG_COOKIE_SECURE=always`) forces Secure; `never` turns it off.
- **Rate limits count each visitor only if the backend learns the visitor's address.** By default every request seems to come from the web container. Have the proxy set a header to the visitor's address (nginx: `proxy_set_header X-Real-IP $remote_addr;`; behind Cloudflare, use `CF-Connecting-IP` when it's set, else `$remote_addr`) and name it in `backend.clientIpHeader` (`WATCHLOG_CLIENT_IP_HEADER`). Set it only if your proxy always overwrites that header.
- **API tokens can show the country of their last use.** Behind Cloudflare, name `CF-IPCountry` in `backend.clientCountryHeader` (`WATCHLOG_CLIENT_COUNTRY_HEADER`). Without it no country is shown; WatchLog does no GeoIP lookup.
- **Only trusted proxies are believed.** The backend takes these headers only from a peer in `backend.trustedProxies` (`WATCHLOG_TRUSTED_PROXIES`, comma-separated CIDRs). The default is loopback and the private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), where the web container connects from in Docker and Kubernetes. A request from anywhere else is judged by its own connection. The web container likewise trusts proxies on private networks, so the backend still receives the `X-Forwarded-Proto` your proxy sent.

## Seed file

`WATCHLOG_SEED_FILE` (the Helm value `seed` sets it) names a JSON file of alert rules the backend creates when it starts. This is how a read-only demo gets its rules, since demo mode refuses every change through the API. Each rule is created once: a rule with the same name is never changed, even after you edit it, so a changed rule in the file needs a new name. A rule that can't be created (an unknown metric or cluster) is logged and skipped. If the file is unreadable or invalid, the backend doesn't start and logs the path and the problem.

```json
{
  "alertRules": [
    {
      "name": "Node memory above 75%",
      "metric": "node.memory.utilization",
      "clusterId": null,
      "scope": {},
      "condition": { "op": ">", "value": 0.75, "critical": 0.9 },
      "forSeconds": 300,
      "severity": "warning"
    }
  ]
}
```

The fields are those of a custom rule in the API. `clusterId` is `null` for every cluster, or a cluster's name or id. `enabled` and `renotifySeconds` are optional. A seed file can't hold channels, so it never holds secrets.

## Agent options

Set as environment variables, or as flags in the `docker run` command. The install commands set the required ones.

| Variable                      | Flag                   | Default                          | What it does                                                                                                             |
| ----------------------------- | ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `WATCHLOG_ENDPOINT`           | `--endpoint`           | required                         | The WatchLog URL.                                                                                                        |
| `WATCHLOG_TOKEN`              | —                      | required                         | The cluster token.                                                                                                       |
| `WATCHLOG_EBPF`               | `--ebpf`               | `true`                           | Network flows. `false` turns them off; the service map then says so for this agent.                                      |
| `WATCHLOG_EBPF_POD_FILTER`    | `--ebpf-pod-filter`    | `true`                           | Kubernetes: record only this node's pods in the kernel. `false` records every process and drops the others in the agent. |
| `WATCHLOG_NODE_METRICS_SCOPE` | `--node-metrics-scope` | `auto`                           | `host`, `cgroup` or `auto` (Kubernetes detects; Docker hosts use `host`).                                                |
| `WATCHLOG_HEALTH_OUTPUT`      | `--health-output`      | `true`                           | Docker: send health check output (redacted, one line, at most 512 bytes). `false` sends exit codes only.                 |
| `WATCHLOG_HOSTNAME`           | `--hostname`           | the host's                       | The name the host appears under.                                                                                         |
| `WATCHLOG_DOCKER_SOCKET`      | `--docker-socket`      | `/var/run/docker.sock`           | Docker socket, used read-only.                                                                                           |
| `WATCHLOG_BUFFER_DIR`         | `--buffer-dir`         | `/var/lib/watchlog-agent/buffer` | On-disk buffer while the server is unreachable: up to 200 MB or 15 minutes.                                              |

## Nodes that are containers (kind, k3d)

With kind or k3d, each Kubernetes node is a container, and the nodes share the kernel of the
machine they run on, often next to other containers and sites. WatchLog keeps that machine out
of what it shows:

- **Network flows.** The node agent gives the kernel the node's pod cgroups, and the kernel
  records only connections and DNS lookups made inside them. Connections of anything else on
  the machine (its own processes, plain Docker containers, the pods of other nodes) are never
  recorded, only counted in `watchlog_agent_flow_filtered_connections_total` and
  `watchlog_agent_dns_filtered_queries_total`. The agent also drops any flow it cannot attribute
  to a pod on its node, so nothing from outside the cluster appears on the service map. Turn the
  kernel filter off with `agent.networkFlows.podFilter=false`.
- **Node metrics.** `agent.nodeMetricsScope` says where they come from:

| Scope    | CPU                                                                                                               | Memory                                                                                                              | Load average | Disks and filesystems                                                          | Network                      | Boot time                       |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ | ---------------------------- | ------------------------------- |
| `host`   | the kernel's CPUs and time (`/proc/stat`)                                                                         | the kernel's (`/proc/meminfo`)                                                                                      | yes          | every disk's I/O and every local filesystem's size and free space              | the node's network namespace | the kernel's boot               |
| `cgroup` | the node container's limit (`cpu.max`, else its cpuset) and its usage (`cpu.stat`); idle is the rest of the limit | the node container's limit (`memory.max`; the machine's total only when unlimited, and the agent logs it) and usage | not reported | the node's block I/O summed over devices, no device names; no filesystem sizes | the node's network namespace | when the node container started |

`auto` (the default) picks `cgroup` when the node looks like a container: `/.dockerenv`,
`/run/.containerenv` or `/kind` in its root filesystem, or a cgroup root with `cpu.max` or
`memory.max`, which only a container's cgroup has. Otherwise it picks `host`. In `cgroup` scope
the nodes list, the node page and the overview show the node container's CPUs and memory as the
node's capacity, not what Kubernetes reports (the machine's). Without filesystem sizes, the disk
usage column and the disk usage alert stay empty for these nodes; give the node containers their
own volumes and watch those on the machine if you need them.
