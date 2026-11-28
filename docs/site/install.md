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
helm install watchlog oci://ghcr.io/watchlog-light/charts/watchlog --version 1.3.0 \
  --namespace watchlog --create-namespace
```

1. Wait for the pods: `kubectl -n watchlog get pods`.
2. Open the UI: `kubectl -n watchlog port-forward svc/watchlog-web 8080`, then go to http://localhost:8080.
3. Enter the one-time setup code from `kubectl -n watchlog logs deploy/watchlog-backend -c backend | grep "setup code"` and create your admin account. To skip this step, install with `--set admin.email=you@example.com --set admin.password=...`.

The cluster appears within a minute, named `kubernetes` (set `--set clusterName=prod` to change it). Nodes, workloads, pods and events come first; the service map fills in as workloads talk to each other.

With [network devices](network.md) (Pro and Enterprise), a node's page also shows the switch port it is on (`sw-access-2 · Gi1/0/14 · 1 Gb/s`): the node agent reports its network cards, and the cluster's integrations collector polls the switches.

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

The cluster switcher at the top of the sidebar moves between them. In Pro, [All clusters and fleets](all-clusters.md) shows every one of them on one page.

## With Docker Compose

**1. WatchLog itself**, on one Linux host:

```bash
mkdir watchlog && cd watchlog
curl -fsSLO https://raw.githubusercontent.com/watchlog-light/watchlog/v1.3.0/deploy/docker/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/watchlog-light/watchlog/v1.3.0/deploy/docker/.env.example
```

Edit `.env` and set:

- `WATCHLOG_DB_PASSWORD`: any strong password.
- `WATCHLOG_SECRET_KEY`: from `openssl rand -base64 32`. Back it up with the database.
- `WATCHLOG_PUBLIC_URL`: how agents and browsers reach this host, for example `http://10.0.0.5:8080`.
- `WATCHLOG_VERSION=1.3.0`.

Then start it and get the setup code:

```bash
docker compose up -d
docker compose logs backend | grep "setup code"
```

Open `WATCHLOG_PUBLIC_URL`, enter the code and create your admin account. Only port 8080 is published. For anything beyond a trusted network, put a TLS-terminating proxy in front.

**2. The agents.** In the UI, go to **Settings → Clusters → Add cluster → Servers**, then run the command it shows on every server, including this one if it runs workloads. Each server's services, processes and containers appear within a minute. See [Linux servers](servers.md).

### HTTPS in front, on any port

Keep `compose.yaml` as released and put your changes in a `compose.override.yaml` next to it; Compose reads both.

- **Publish the dashboard on loopback only:** `WATCHLOG_PORT=127.0.0.1:8080` in `.env`. Add your TLS proxy (nginx, Caddy, Traefik) as a service in the override, publishing only its own ports and sending everything to `web:8080`. The web container passes `/api`, `/ingest`, `/mcp` and `/install.sh` to the backend.
- **The public URL includes the port** when it isn't 443, for example `WATCHLOG_PUBLIC_URL=https://watchlog.example.com:8443`. Install commands and email links use it as written.
- **What the proxy sends:** `X-Forwarded-Proto: https` and the visitor's address in `X-Real-IP` (then set `WATCHLOG_CLIENT_IP_HEADER=X-Real-IP`). Turn response buffering off and allow reads of at least 5 minutes: log follow and MCP answers are streamed. Allow request bodies of 8 MB for agents. See [Behind a reverse proxy](configuration.md#behind-a-reverse-proxy).
- **HSTS:** the backend sends it on API answers. If the proxy adds its own, hide the backend's copy, so browsers get one header.
- **A plain-HTTP port that only redirects:** a browser that has seen HSTS for the host upgrades `http://host:PORT` to `https://host:PORT` on that same port. Serve TLS on the redirect port too, and answer plain HTTP there with the redirect (nginx: `listen PORT ssl;`, `error_page 497 =301 https://…$request_uri;`), so both kinds of request get it.
- **Certificates without ports 80 and 443:** Let's Encrypt's HTTP-01 and TLS-ALPN-01 challenges need those ports. Use the DNS-01 challenge (acme.sh, lego and Caddy support most DNS providers), on this host or on another machine that copies the certificate here and reloads the proxy. Check propagation on the zone's authoritative servers: a public resolver that looked the name up before the TXT record existed keeps the empty answer for the zone's negative TTL, often 30 minutes.

### When Docker Hub can't be reached

`compose.yaml` takes PostgreSQL and VictoriaMetrics from Docker Hub; WatchLog's own images come from ghcr.io. Where Docker Hub refuses pulls (HTTP 403, or rate limits), take the same images and tags from another registry in `compose.override.yaml`:

```yaml
services:
  postgres:
    image: public.ecr.aws/docker/library/postgres:16-alpine
  victoriametrics:
    image: quay.io/victoriametrics/victoria-metrics:v1.155.0
```

Use the tags in your `compose.yaml`, and check them again when you upgrade: a release may move to a newer tag. `docker compose config --images` lists every image the stack will pull.

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

## Enterprise

Add a licence key to turn on the Pro features (What changed, All clusters and fleets) on a
self-hosted install: paste it in **Settings → License**, or set `WATCHLOG_LICENSE`. It is
checked offline and works air-gapped. With Docker Compose also set
`COMPOSE_PROFILES=enterprise` in `.env` for What changed's worker; with Helm,
`license.key` and `anomalyWorker.enabled=true`. Units, expiry and the rest are in
[Enterprise licence](license.md).

## Upgrade

Upgrades never need manual steps.

- **Kubernetes:** `helm upgrade watchlog oci://ghcr.io/watchlog-light/charts/watchlog --version <new> -n watchlog --reuse-values`. The agents-only chart works the same way.
- **Docker server:** set `WATCHLOG_VERSION` in `.env`, then `docker compose pull && docker compose up -d`. Database migrations run on start. The steps below make it reversible.
- **Docker agents:** run the install command from **Settings → Clusters** again. It replaces the container, and the service map shows the exact command for any agent that needs it.

### A Docker server, step by step

**Before:** back up, in the folder with `compose.yaml`:

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
docker compose exec -T postgres pg_dump -U watchlog -d watchlog -Fc > backups/watchlog-$ts.dump
docker compose exec -T postgres pg_restore --list < backups/watchlog-$ts.dump | grep -c 'TABLE DATA'
for f in .env compose.yaml compose.override.yaml; do [ -f "$f" ] && cp -p "$f" "backups/$f.$ts"; done
for c in $(docker compose ps -aq); do
  docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.Image}}' "$c"
done > "backups/images-$ts.txt"
```

The dump must be larger than zero and list its tables. Keep `WATCHLOG_SECRET_KEY` with it: without
the key, alert channel secrets can't be read after a restore.

**Check the new release:** read its release notes' "Upgrading" section, and compare its
`compose.yaml` and `.env.example` with yours (`https://raw.githubusercontent.com/watchlog-light/watchlog/v<new>/deploy/docker/`).
With a `compose.override.yaml` that takes images from another registry, run
`WATCHLOG_VERSION=<new> docker compose config --images` and check every image still comes from a
registry you can reach, with the tags your override pins. You can pull before switching
(`WATCHLOG_VERSION=<new> docker compose pull`), so the switch itself takes seconds.

**Switch:** set `WATCHLOG_VERSION` in `.env`, run `docker compose up -d`, and wait for
`/api/v1/health` to report the new version. `docker compose logs migrate` lists the migrations
applied.

**Going back:** put the copied `.env`, `compose.yaml` and `compose.override.yaml` back. If a
migration ran, restore the dump into a fresh database and swap it in only once it's complete,
so the live database is never overwritten:

```bash
docker compose stop backend alert-worker web
docker compose exec -T postgres createdb -U watchlog watchlog_restore
docker compose exec -T postgres pg_restore -U watchlog -d watchlog_restore --no-owner < backups/watchlog-<ts>.dump
docker compose exec -T postgres psql -U watchlog -d postgres \
  -c 'ALTER DATABASE watchlog RENAME TO watchlog_before_restore' \
  -c 'ALTER DATABASE watchlog_restore RENAME TO watchlog'
docker compose up -d
```

With an Enterprise licence (`COMPOSE_PROFILES=enterprise`, [licence](license.md)), stop the
`anomaly-worker` with the others. The old images stay on the host after an upgrade unless you
remove them, so the previous version starts without a download.

A `compose.override.yaml` that sets something for every service (log rotation, for example)
should name the `anomaly-worker` too once the `enterprise` profile is on: an override's settings
reach only the services it names.

### Update the agents

WatchLog tells you when an agent is older than itself, and shows the command that updates it:
a banner on the **Nodes** page of a Kubernetes cluster ("3 of 12 nodes run an older agent") or
the **Servers** page of a fleet, a chip on each server's page, an **Agents** section in each
cluster's and fleet's **Settings**, and an item in Pro's
[All clusters and fleets](all-clusters.md). For Kubernetes the command is `helm upgrade` of
the chart the cluster runs (`watchlog` or `watchlog-agent`), with its release and namespace
when the chart reports them, keeping your values. For servers, see
[Linux servers](servers.md#update-the-agents).

## Uninstall

- **Kubernetes:** `helm uninstall watchlog -n watchlog`. The secret key Secret is kept on purpose; delete it with `kubectl -n watchlog delete secret watchlog-secret-key` if you're sure.
- **Docker server:** `docker compose down -v` (`-v` deletes the data).
- **Docker agents:** `docker rm -f watchlog-agent && docker volume rm watchlog-agent-state`.
