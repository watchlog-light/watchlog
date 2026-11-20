---
title: Install
description: Install WatchLog on Kubernetes with one Helm chart, or with Docker Compose and one command on each Linux server. About five minutes.
---

# Install WatchLog

WatchLog has two parts: the **server** (backend, web UI, PostgreSQL, VictoriaMetrics) and the **agents** that send data to it. Pick the path that matches where you run things. Both take about five minutes.

## Requirements

- **Kubernetes:** 1.26 or newer, and Helm 3.8 or newer.
- **Linux servers:** systemd (Ubuntu 20.04+, Debian 11+, RHEL, Rocky and Alma 8+, Amazon Linux 2023), amd64 or arm64; or Docker Engine 20.10 or newer for the `docker run` agent. Docker Compose v2 to run WatchLog itself with Compose.
- **Network flows (service map):** Linux 5.8 or newer with BTF (`/sys/kernel/btf/vmlinux`) and cgroup v2. Most distributions since 2021 have both. On other kernels everything else works, and the service map shows topology from Services and says why.

## Kubernetes

One chart installs the server and the agents for this cluster:

```bash
helm install watchlog oci://ghcr.io/watchlog-light/charts/watchlog --version 0.10.0 \
  --namespace watchlog --create-namespace
```

1. Wait for the pods: `kubectl -n watchlog get pods`.
2. Open the UI: `kubectl -n watchlog port-forward svc/watchlog-web 8080`, then go to http://localhost:8080.
3. Enter the one-time setup code from `kubectl -n watchlog logs deploy/watchlog-backend -c backend | grep "setup code"` and create your admin account. To skip this step, install with `--set admin.email=you@example.com --set admin.password=...`.

The cluster appears within a minute, named `kubernetes` (set `--set clusterName=prod` to change it). Nodes, workloads, pods and events come first; the service map fills in as workloads talk to each other.

**PodSecurity:** the node agent needs read-only hostPath mounts, which the `baseline` and `restricted` levels forbid. If your cluster enforces one of them, label the namespace first:

```bash
kubectl create namespace watchlog
kubectl label namespace watchlog pod-security.kubernetes.io/enforce=privileged
```

**Back up the secret key.** It encrypts alert channel secrets (Slack webhooks, Telegram tokens), and without it they can't be read after a restore:

```bash
kubectl -n watchlog get secret watchlog-secret-key -o jsonpath='{.data.key}' | base64 -d
```

To expose the UI permanently, enable the chart's Ingress (`ingress.enabled`, `ingress.host`) and set `publicUrl` so alert links point to it. See [configuration](configuration.md).

### More clusters and Server fleets

One WatchLog holds as many Kubernetes clusters and Server fleets as you run, side by side, with no limit in Community. In the UI, go to **Settings → Clusters → Add cluster**:

- **Kubernetes:** run the `helm install` command it shows in the new cluster. It installs only the agents (chart `watchlog-agent`), with a token for that cluster.
- **Servers:** run the command it shows on each server of the new fleet: one command, a deb or rpm, or `docker run`. A fleet holds any number of servers. See [Linux servers](servers.md).

The cluster switcher at the top of the sidebar moves between them.

## With Docker Compose

**1. WatchLog itself**, on one Linux host:

```bash
mkdir watchlog && cd watchlog
curl -fsSLO https://raw.githubusercontent.com/watchlog-light/watchlog/v0.10.0/deploy/docker/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/watchlog-light/watchlog/v0.10.0/deploy/docker/.env.example
```

Edit `.env` and set:

- `WATCHLOG_DB_PASSWORD`: any strong password.
- `WATCHLOG_SECRET_KEY`: from `openssl rand -base64 32`. Back it up with the database.
- `WATCHLOG_PUBLIC_URL`: how agents and browsers reach this host, for example `http://10.0.0.5:8080`.
- `WATCHLOG_VERSION=0.10.0`.

Then start it and get the setup code:

```bash
docker compose up -d
docker compose logs backend | grep "setup code"
```

Open `WATCHLOG_PUBLIC_URL`, enter the code and create your admin account. Only port 8080 is published. For anything beyond a trusted network, put a TLS-terminating proxy in front.

**2. The agents.** In the UI, go to **Settings → Clusters → Add cluster → Servers**, then run the command it shows on every server, including this one if it runs workloads. Each server's services, processes and containers appear within a minute. See [Linux servers](servers.md).

## Applications (databases, caches, queues, web servers)

WatchLog finds Redis, PostgreSQL, Nginx and RabbitMQ in what the agents already see. Open
**Applications** and press **Monitor**. They are read by the integrations collector, with
read-only access:

- **Kubernetes:** the chart runs it in each cluster (`integrations.enabled`, on by default).
- **Servers:** the install installs it next to the agent and it reads services on the same
  server; with `docker run` agents, start it on each server that runs services (the service
  page shows the command).

Each integration has its own page: [Redis](integrations/redis.md),
[PostgreSQL](integrations/postgres.md), [MySQL and MariaDB](integrations/mysql.md),
[MongoDB](integrations/mongodb.md), [Nginx](integrations/nginx.md),
[Traefik](integrations/traefik.md), [RabbitMQ](integrations/rabbitmq.md) and
[Kafka](integrations/kafka.md).

## Upgrade

Upgrades never need manual steps.

- **Kubernetes:** `helm upgrade watchlog oci://ghcr.io/watchlog-light/charts/watchlog --version <new> -n watchlog --reuse-values`. The agents-only chart works the same way.
- **Docker server:** set `WATCHLOG_VERSION` in `.env`, then `docker compose pull && docker compose up -d`. Database migrations run on start.
- **Docker agents:** run the install command from **Settings → Clusters** again. It replaces the container, and the service map shows the exact command for any agent that needs it.

## Uninstall

- **Kubernetes:** `helm uninstall watchlog -n watchlog`. The secret key Secret is kept on purpose; delete it with `kubectl -n watchlog delete secret watchlog-secret-key` if you're sure.
- **Docker server:** `docker compose down -v` (`-v` deletes the data).
- **Docker agents:** `docker rm -f watchlog-agent && docker volume rm watchlog-agent-state`.
