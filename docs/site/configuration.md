---
title: Configuration
description: Helm values, Docker Compose settings and agent options for WatchLog.
---

# Configuration

Defaults work for most installs. This page lists what you can change.

## Helm chart `watchlog` (server and agents)

| Value                                                                                              | Default                                 | What it does                                                                       |
| -------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `publicUrl`                                                                                        | `''`                                    | The URL people use to open WatchLog, used in alert links and install commands.     |
| `admin.email`, `admin.password`                                                                    | `''`                                    | Create the admin at install time instead of using the setup code.                  |
| `secretKey`                                                                                        | generated                               | Key for alert channel secrets (32 bytes, base64). Set it only to restore a backup. |
| `clusterName`                                                                                      | `kubernetes`                            | Name of this cluster in WatchLog.                                                  |
| `image.registry`, `image.tag`                                                                      | `ghcr.io/watchlog-light`, chart version | Where WatchLog images come from: use a mirror for air-gapped installs.             |
| `backend.replicas`, `backend.resources`                                                            | 1, 192Mi–512Mi                          | API server.                                                                        |
| `backend.eventsRetentionDays`                                                                      | 15                                      | How long Kubernetes events are kept.                                               |
| `alertWorker.replicas`                                                                             | 1                                       | Evaluates rules and sends notifications; replicas share the work.                  |
| `alerting.smtpUrl`, `alerting.smtpFrom`                                                            | `''`                                    | SMTP server for email alerts, e.g. `smtp://user:pass@smtp.example.com:587`.        |
| `alerting.telegramApiUrl`                                                                          | Telegram's                              | Telegram Bot API mirror, where api.telegram.org is blocked.                        |
| `alerting.httpsProxy`, `alerting.noProxy`                                                          | `''`                                    | Outbound proxy for Slack, Telegram and webhook alerts.                             |
| `web.service.type`, `web.service.port`                                                             | `ClusterIP`, 8080                       | The UI's Service.                                                                  |
| `ingress.enabled`, `ingress.host`, `ingress.className`, `ingress.tlsSecret`, `ingress.annotations` | off                                     | Expose the UI through an Ingress.                                                  |
| `postgresql.storage`, `postgresql.storageClass`                                                    | 8Gi                                     | Database volume.                                                                   |
| `victoriametrics.retention`, `victoriametrics.storage`                                             | `15d`, 20Gi                             | Metrics retention and volume.                                                      |
| `watchlog-agent.enabled`                                                                           | `true`                                  | Install the agents for this cluster.                                               |
| `watchlog-agent.*`                                                                                 | see below                               | Agent settings, prefixed with `watchlog-agent.`.                                   |

## Helm chart `watchlog-agent` (agents only)

| Value                                                                       | Default                                 | What it does                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchlog.endpoint`                                                         | required                                | The WatchLog URL the agents push to.                                                                                                                                                         |
| `watchlog.clusterToken` or `watchlog.existingSecret`                        | required                                | The cluster token from Settings → Clusters, or a Secret that holds it (`existingSecretKey`, default `token`).                                                                                |
| `agent.networkFlows.enabled`                                                | `true`                                  | eBPF network flows for the service map. When on, the node agent runs as uid 0 with only the `BPF` and `PERFMON` capabilities; when off, as uid 65532 with none. See [security](security.md). |
| `agent.interval`                                                            | `15s`                                   | Collection interval.                                                                                                                                                                         |
| `agent.kubeletTLS`                                                          | `auto`                                  | Kubelet certificate check: `auto` verifies against the cluster CA and falls back if that fails, `verify` never falls back, `skip` never verifies.                                            |
| `agent.resources`                                                           | 48Mi request, 128Mi limit               | Node agent resources. It stays within 64 MB of memory and 1 % of a core.                                                                                                                     |
| `agent.tolerations`, `agent.nodeSelector`, `agent.priorityClassName`        | every node                              | Where the node agent runs.                                                                                                                                                                   |
| `clusterAgent.enabled`, `clusterAgent.resources`, `clusterAgent.goMemLimit` | on, 128Mi–512Mi, 400MiB                 | The cluster-agent that watches the Kubernetes API.                                                                                                                                           |
| `image.registry`, `image.tag`, `image.pullPolicy`                           | `ghcr.io/watchlog-light`, chart version | Agent images.                                                                                                                                                                                |

## Docker Compose server (`.env`)

| Variable                                          | Default    | What it does                                                          |
| ------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| `WATCHLOG_DB_PASSWORD`                            | required   | PostgreSQL password.                                                  |
| `WATCHLOG_SECRET_KEY`                             | required   | Key for alert channel secrets: `openssl rand -base64 32`. Back it up. |
| `WATCHLOG_PUBLIC_URL`                             | `''`       | How agents and browsers reach the server.                             |
| `WATCHLOG_VERSION`                                | `latest`   | Image version; pin it, e.g. `0.1.0`.                                  |
| `WATCHLOG_PORT`                                   | 8080       | The only published port.                                              |
| `WATCHLOG_RETENTION`                              | `15d`      | Metrics retention.                                                    |
| `WATCHLOG_SMTP_URL`, `WATCHLOG_SMTP_FROM`         | unset      | Email alerts.                                                         |
| `HTTPS_PROXY`, `NO_PROXY`                         | unset      | Outbound proxy for alert deliveries.                                  |
| `WATCHLOG_TELEGRAM_API_URL`                       | Telegram's | Telegram Bot API mirror.                                              |
| `WATCHLOG_ADMIN_EMAIL`, `WATCHLOG_ADMIN_PASSWORD` | unset      | Create the admin at startup instead of the setup code.                |

## Agent options

Set as environment variables, or as flags in the `docker run` command. The install commands set the required ones.

| Variable                 | Flag              | Default                          | What it does                                                                                             |
| ------------------------ | ----------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `WATCHLOG_ENDPOINT`      | `--endpoint`      | required                         | The WatchLog URL.                                                                                        |
| `WATCHLOG_TOKEN`         | —                 | required                         | The cluster token.                                                                                       |
| `WATCHLOG_EBPF`          | `--ebpf`          | `true`                           | Network flows. `false` turns them off; the service map then says so for this agent.                      |
| `WATCHLOG_HEALTH_OUTPUT` | `--health-output` | `true`                           | Docker: send health check output (redacted, one line, at most 512 bytes). `false` sends exit codes only. |
| `WATCHLOG_HOSTNAME`      | `--hostname`      | the host's                       | The name the host appears under.                                                                         |
| `WATCHLOG_DOCKER_SOCKET` | `--docker-socket` | `/var/run/docker.sock`           | Docker socket, used read-only.                                                                           |
| `WATCHLOG_BUFFER_DIR`    | `--buffer-dir`    | `/var/lib/watchlog-agent/buffer` | On-disk buffer while the server is unreachable: up to 200 MB or 15 minutes.                              |
