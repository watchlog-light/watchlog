# WatchLog v2 — Product & Technical Specification

Version 1.1 · 31 October 2026 · Owner: the maintainer · Status: Draft for Phase 0

# 1. How to use this document

This is the single source of truth for **WatchLog v2**, a rebuild of WatchLog as an open-source monitoring product for **Kubernetes clusters and Docker hosts only**. It is written for two readers: the product owner and Claude Code (implementer).

**Rules for Claude Code**

1. Read this whole document once before writing any code. Then read the session log (`HISTORY.md`, in the private notes) and `docs/DECISIONS.md`.
2. Work one phase at a time (see §13). Do not start a phase before the previous phase's acceptance criteria pass.
3. Anything marked **P0** is required for the phase it belongs to. **P1** is next, **P2** is later. Do not build P1/P2 items early.
4. If something in this spec is ambiguous or wrong, stop and ask. Record the answer in `docs/DECISIONS.md`.
5. At the end of every session, append an entry to the session log, `HISTORY.md` (format in §15).
6. Code, comments, commit messages and docs are in **English**. User-facing UI strings live in i18n files (`en` only in v2.0; the structure allows more locales later).

**Key words.** *MUST* = required. *SHOULD* = strongly preferred, deviate only with a recorded decision. *MAY* = optional.

# 2. Product overview

## 2.1 One-line positioning

> **WatchLog — open-source monitoring for Kubernetes and Docker. Install one agent, see every node, pod, container and the network between them in under five minutes.**

## 2.2 The problem

- Teams running Kubernetes or Docker either assemble Prometheus + Grafana + exporters + Alertmanager themselves (hours of setup, constant maintenance, dashboards that nobody owns), or pay for SaaS products priced per host at levels small teams cannot justify.
- The questions people actually ask are simple and urgent: *Which pod is restarting? Which node is out of memory? Why can service A not reach service B? What changed?* Answering them with DIY stacks needs PromQL knowledge.
- Many teams cannot or will not send infrastructure data to a third party; they need a self-hosted option that is as easy as SaaS.

## 2.3 The solution

- **One agent, one command.** A Helm chart (Kubernetes) or one `docker run` (Docker host). No exporters, no PromQL, no dashboard building.
- **Opinionated, ready dashboards** for cluster, nodes, workloads, pods, containers and Docker hosts.
- **Service map from network traffic (eBPF)** — who talks to whom, latency, errors, failed connections — without changing application code.
- **Sensible default alerts** that work on day one (CrashLoopBackOff, OOMKilled, node pressure, disk full, etc.).
- **Fully open source (AGPL-3.0)** and self-hostable for one cluster at no cost. The agent's source is public, which removes the trust barrier of installing a closed agent on production.
- **Cloud and Enterprise editions** for teams that want zero maintenance, multiple clusters, longer retention, anomaly detection and enterprise controls.

## 2.4 Target users

| Persona | Context | What they need | Edition |
|---|---|---|---|
| **Solo DevOps / small startup** | 1 cluster or a few Docker hosts, 3-30 nodes | Fast setup, alerts to Telegram/Slack, free | Community or Cloud Free |
| **Growing product team** | 2-5 clusters (staging/prod), 20-200 nodes | No maintenance, multi-cluster view, 30-day history, smart alerts | Cloud Pro |
| **Regulated organisation** (bank, telco, fintech, government) | On-prem, air-gapped, strict access control | Self-hosted, SSO/LDAP, RBAC, audit, support SLA | Enterprise |
| **Learner / blog reader** | Minikube, kind, homelab | Easy try-out, good docs | Community |

## 2.5 Non-goals (v2.0)

WatchLog v2 MUST NOT include, in any edition, until explicitly re-scoped:

- Bare-metal / VM agents for Ubuntu or other OSes outside a container runtime (the v1 agent is deprecated).
- APM / distributed tracing / code-level instrumentation.
- Log management (search, indexing). Showing the last N lines of a container's log on demand is allowed (P1).
- Synthetic monitoring, uptime checks from multiple regions, RUM.
- Custom dashboard builder. Dashboards are opinionated and fixed in v2.0.
- Docker Swarm, Nomad, OpenShift-specific features (they may work, but are not targeted).

## 2.6 Lessons from WatchLog v1

_Not part of the public specification._

## 2.7 Success metrics

_Not part of the public specification._

# 3. Editions and pricing

## 3.1 Principles

1. **The free product is complete for one cluster.** Monitoring, service map and alerting are never paywalled.
2. **Money comes from convenience and organisation-scale needs**: hosting, retention, multiple clusters, intelligence (anomaly detection), compliance and support.
3. **Nothing that was ever free becomes paid.** Only new capabilities can be paid.
4. **Simple unit: price per monitored node per month** (a Kubernetes node or a Docker host).

## 3.2 Edition matrix

| | **Community** | **Cloud Free** | **Cloud Pro** | **Enterprise** |
|---|---|---|---|---|
| Hosting | Self-hosted | WatchLog Cloud | WatchLog Cloud | Self-hosted or dedicated cloud |
| License | AGPL-3.0 | — | — | Commercial (`ee/`) |
| Price | Free | Free | **$1 / node / month** (min. $10 / month) | Custom quote |
| Clusters / Docker fleets | 1 | 1 | Unlimited | Unlimited |
| Nodes | Unlimited | Up to 5 | Unlimited | Unlimited |
| Node, workload, pod, container metrics | ✓ | ✓ | ✓ | ✓ |
| Docker host & container metrics | ✓ | ✓ | ✓ | ✓ |
| Service map & network (eBPF) | ✓ | ✓ | ✓ | ✓ |
| Kubernetes events & restarts | ✓ | ✓ | ✓ | ✓ |
| Default + custom threshold alerts | ✓ | ✓ | ✓ | ✓ |
| Channels: Slack, Telegram, Email, Webhook | ✓ | ✓ | ✓ | ✓ |
| Data retention | Limited by your disk (default 15 d) | 3 days | 30 days | Configurable (1 year+) |
| Users | 1 admin | 1 | Up to 10 | Unlimited |
| Unified multi-cluster view | — | — | ✓ | ✓ |
| SLO / availability reports | — | — | ✓ | ✓ |
| Anomaly detection — basic (auto-baselines) | — | — | ✓ | ✓ |
| Anomaly detection — advanced (correlation & root-cause hints) | — | — | — | ✓ |
| SSO (OIDC/SAML), LDAP | — | — | — | ✓ |
| RBAC (per-cluster / per-namespace roles) | — | — | — | ✓ |
| Audit log | — | — | — | ✓ |
| Air-gapped install, offline license | — | — | — | ✓ |
| Support | GitHub issues, community chat | Community | Email (2 business days) | SLA + dedicated channel |

**Why anomaly detection is paid:** it needs at least 7-14 days of history to learn weekly seasonality, which only the paid retention tiers provide, and it costs real compute per series.

## 3.3 Pricing rationale and billing

- **$1 per node per month** is deliberately far below typical per-host SaaS pricing. The goal is to make "just use Cloud" cheaper than the time spent maintaining a self-hosted stack, and to win on volume and word of mouth.
- **Minimum $10 / month** (covers up to 10 nodes). Without a minimum, Stripe's fixed per-transaction fee would eat a large share of very small invoices (e.g. a 3-node, $3 invoice). Alternative to evaluate: no minimum but **annual billing only** below 10 nodes. Record the choice in `DECISIONS.md`.
- **Annual plan:** 2 months free (pay for 10, get 12).
- **Billable nodes** = the 95th percentile of hourly node counts in the billing period, so autoscaling spikes do not inflate the bill.
- **Billing provider: Stripe** (Stripe Checkout + Billing + Customer Portal, usage-based price reported daily via Stripe usage records/meters). Invoices, tax and card management stay in Stripe; WatchLog stores only the Stripe customer and subscription IDs.
- **Enterprise:** custom annual contracts, invoiced through Stripe.

## 3.4 Licensing and repository layout

- Everything outside `ee/` is **AGPL-3.0**. This lets anyone self-host and modify, but prevents a third party from reselling WatchLog as a closed hosted service.
- `ee/` contains Enterprise-only code under a **commercial source-available license** (same model as GitLab). Enterprise features MUST be implemented as modules that the core loads only when a valid license key is present. The core MUST build and run with `ee/` deleted.
- Cloud-only billing code lives in a separate **private** repository, never in the public monorepo.
- Contributors sign a lightweight CLA (via CLA Assistant) so dual licensing stays possible.


# 4. Feature specification

Priority labels: **P0** = MVP / launch, **P1** = shortly after launch, **P2** = later. Edition is Community (C), Cloud Free (CF), Pro (P), Enterprise (E). "All" = every edition.

## 4.1 Cluster overview (home screen) — P0, All

The first screen after login. Answers "is anything wrong right now?" in 5 seconds.

- Health banner: **Healthy / Degraded / Critical**, computed from firing alerts.
- Tiles: nodes (ready / total), pods (running / pending / failed), restarts last 1 h, firing alerts, cluster CPU % and memory % (requests vs usage vs allocatable).
- "Needs attention" list: top 10 problems ordered by severity (CrashLoopBackOff pods, NotReady nodes, OOMKilled containers, pending pods > 5 min, PVCs > 85 % full).
- Recent Kubernetes events (Warning only) with links to the affected object.
- Time range selector: 15 m, 1 h, 6 h, 24 h, 7 d, custom (limited by retention).

## 4.2 Nodes — P0, All

- Table: name, status, roles, kubelet version, OS / kernel, CPU (used / allocatable), memory, disk, pods (count / capacity), age, conditions. Sortable, filterable.
- Node detail: CPU, memory, load, disk I/O, disk usage per mount, network rx/tx, conditions timeline (MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable), pods on node with their usage.
- eBPF capability badge per node (enabled / unsupported kernel / disabled).

## 4.3 Workloads, pods and containers — P0, All

- Namespace selector (multi-select) applies everywhere.
- Workloads list: Deployments, StatefulSets, DaemonSets, Jobs, CronJobs. Desired vs ready replicas, restarts, CPU / memory usage vs requests vs limits, last rollout time.
- Pod list and pod detail: phase, node, IP, QoS class, owner, containers, restarts with **last termination reason** (OOMKilled, Error, Completed) and exit code, events for this pod.
- Container metrics: CPU (cores and % of limit), throttling %, memory working set vs limit, network, filesystem.
- **Right-sizing hint (P1):** "requests are 4× higher than p95 usage over 7 d" / "memory limit is within 10 % of p99 usage — OOM risk".
- **Container logs on demand (P1):** last 500 lines via the Kubernetes API, streamed, never stored.

## 4.4 Docker hosts — P0, All

For hosts running Docker or containerd without Kubernetes. Several hosts in one account form a **Docker fleet** (counts as one "cluster" for edition limits).

- Hosts list: hostname, Docker version, OS / kernel, CPU, memory, disk, containers (running / stopped / unhealthy).
- Containers list: name, image, status, health-check status, restart count, uptime, CPU, memory vs limit, network, ports, Compose project / service label.
- Grouping by **Compose project** when `com.docker.compose.project` label exists.
- Events: container die / oom / restart / health_status changes.

## 4.5 Service map and network — P0 (basic), P1 (advanced), All

Built from eBPF data captured by the agent (§6.4). No application changes.

- **P0:** directed graph of workloads (nodes = workload or external endpoint; edges = TCP connections). Edge shows requests/connections per second, failed connections, mean and p95 TCP connect latency, bytes/s. Edge colour by health. Click an edge to see its time series.
- **P0:** external dependencies shown as grouped nodes (e.g. `db.example.com:5432`, "Internet").
- **P0:** DNS errors per workload (NXDOMAIN, timeout).
- **P1:** TCP retransmits and resets per edge; "connection refused" detection; per-namespace map filter.
- **P1:** HTTP-level stats (status codes, latency) for plain-text HTTP/1.1 where detectable. TLS payloads are never decrypted.
- Fallback when eBPF is unavailable: map built from Kubernetes Services/Endpoints only, clearly labelled "topology only, no traffic data".

## 4.6 Kubernetes events and change tracking — P0, All

- Store all Kubernetes events (Normal + Warning) for the retention period, de-duplicated by `involvedObject + reason`.
- Change markers on every chart: deployments rolled out, image changes, node added/removed, HPA scale events.

## 4.7 Alerting — P0, All

**Default rules (enabled on install, editable):**

| Rule | Condition (default) | Severity |
|---|---|---|
| Pod CrashLoopBackOff | any container in CrashLoopBackOff > 2 min | critical |
| Container OOMKilled | termination reason OOMKilled | warning |
| Pod pending too long | Pending > 5 min | warning |
| ImagePullBackOff | > 2 min | warning |
| Node NotReady | > 1 min | critical |
| Node memory pressure / disk pressure | condition true | critical |
| Node CPU high | > 90 % for 10 min | warning |
| Node disk usage | > 85 % warning, > 95 % critical | warning / critical |
| PVC usage | > 85 % | warning |
| Deployment replicas unavailable | ready < desired for 5 min | critical |
| Container CPU throttling | > 25 % for 15 min | warning |
| Docker container unhealthy / restarting | health = unhealthy or > 3 restarts in 10 min | warning |
| Service-to-service failed connections | > 5 % of connections fail for 5 min | warning |
| Agent not reporting | no heartbeat for 3 min; one alert for the whole cluster when all its agents are silent | critical |

**Custom threshold rules:** pick metric → scope (cluster / namespace / workload / node / label selector) → condition → duration → severity → channels. No PromQL required. P1: advanced mode with raw MetricsQL.

**Channels (P0):** Slack webhook, Telegram bot, Email (SMTP / provider), generic Webhook (JSON). **P1:** Microsoft Teams, Discord, PagerDuty, Opsgenie.

**Behaviour:** grouping (one message per rule+scope), resolve notifications, re-notify interval (default 4 h), silences with expiry, maintenance windows (P1), routing by severity/namespace (P1). Alert messages are short and actionable: what, where, since when, link.

**Silent clusters and held alerts (ADR-094):** when every agent of a cluster is silent, one "stopped reporting" alert is raised for the cluster instead of one per agent. The cluster's other alerts, and pod alerts on NotReady nodes, are held: neither notified nor resolved while their state is unknown, shown as "held back", and released when data returns.

**Server settings (ADR-093):** the public address, the email server (SMTP, password encrypted and write-only) and Telegram's HTTPS proxy are set in Settings and stored in the database. An environment variable, when set, overrides the stored value and the UI shows it read-only as set by the server's environment.

## 4.8 Anomaly detection — P1, Pro (basic) / Enterprise (advanced)

**Goal:** alerts with zero configuration. Sold as "we notice what is abnormal for *your* cluster", not as "AI".

**Basic (Pro):**

- Applies to a curated set of signals: workload CPU, memory, restarts, network bytes, service-map edge error rate and latency, node CPU / memory / disk I/O.
- Baseline per series per **hour-of-week** (168 buckets) using **median and MAD** over the last 14 days (minimum 7 days of data before a series becomes eligible).
- Score = |value − median| / (1.4826 × MAD). Anomaly when score > 4 (configurable) **for at least N consecutive minutes** (default 10).
- Suppress during deploy markers (± 15 min) and maintenance windows.
- Target: fewer than 3 anomaly notifications per cluster per day by default; users can tune sensitivity (low / medium / high).
- Each anomaly shows the series, its expected band and the deviation, with "mute this signal" and "this was useful / not useful" feedback buttons (stored for tuning).

**Advanced (Enterprise, P2):** correlate anomalies that start within the same 5-minute window and are connected on the service map; produce a "likely root cause" hint (earliest anomaly upstream in the graph).

**Implementation:** a separate worker (`anomaly-worker`) that reads from VictoriaMetrics on a schedule (every 1 min), keeps baselines in PostgreSQL (or a compact table), and emits anomalies into the same alert pipeline. Start with statistics only; ML models are out of scope until data proves the need.

## 4.9 SLO / availability reports — P1, Pro+

- Define an SLO on a workload: availability (ready replicas ≥ desired) or service-map edge success rate / latency.
- Monthly report: SLO %, error budget remaining, incidents list. Export as PDF (P2).

## 4.10 Organisation features

| Feature | Priority | Edition |
|---|---|---|
| Organisations, invite users by email | P0 | Cloud |
| Multiple clusters per org, cluster switcher, unified "all clusters" overview | P1 | Pro, E |
| Roles: Owner, Admin, Viewer | P1 | Pro, E |
| Fine-grained RBAC (per cluster / namespace) | P2 | E |
| SSO (OIDC, SAML), LDAP | P2 | E |
| Audit log (who changed which rule, who silenced what) | P2 | E |
| API tokens for automation | P1 | All |

# 5. System architecture

## 5.1 Components

| Component | Language / tech | Runs where | Responsibility |
|---|---|---|---|
| `agent` | Go | DaemonSet on every K8s node, or one container per Docker host | Node, container and eBPF network metrics; push to ingest |
| `cluster-agent` | Go (same binary, `--mode=cluster`) | Deployment, 1 replica per K8s cluster | Watch the Kubernetes API: objects, events, state metrics |
| `backend` | Node.js 24 LTS, TypeScript, Fastify | Server / Cloud | Auth, REST API, ingest gateway, metadata, alert rules, query proxy |
| `alert-worker` | Node.js (same codebase, separate process) | Server / Cloud | Evaluate rules every 30 s, manage state, send notifications |
| `anomaly-worker` | Node.js (P1) | Server / Cloud | Baselines and anomaly scoring (§4.8) |
| `web` | Vue 3, Vite, TypeScript, Tailwind, Pinia, Apache ECharts | Browser | Dashboard SPA |
| `site` | Nuxt 4 (static generation) | CDN / static host | Landing page, pricing, docs, blog |
| Metrics store | **VictoriaMetrics** (single-node; cluster version for Cloud scale) | Server | Time series, Prometheus-compatible, low RAM, built-in retention |
| Metadata DB | **PostgreSQL 16** | Server | Users, orgs, clusters, rules, alert state, events, baselines |
| Queue / cache | **Redis 7** (optional in Community) | Server | Rate limits and caches. Alert notifications use a PostgreSQL outbox (`notifications`, `FOR UPDATE SKIP LOCKED`, ADR-074), not a Redis queue |

**Why not Elasticsearch / InfluxDB:** the self-hosted edition must run in a small footprint (target: whole stack < 1 GB RAM for a 10-node cluster). VictoriaMetrics + PostgreSQL meets that; Elasticsearch does not. Kubernetes events go to PostgreSQL (partitioned by day) in v2.0.

## 5.2 Data flow

```
 ┌──────────── Kubernetes cluster ────────────┐
 │  agent (DaemonSet)      cluster-agent (x1)  │
 │   /proc, cgroups,        K8s API watch:     │
 │   kubelet, CRI,          objects, events,   │
 │   eBPF flows             kube state         │
 └───────┬───────────────────────┬────────────┘
         │ HTTPS, protobuf+snappy (remote_write)
         │ + JSON batches (metadata, events)
         ▼                       ▼
 ┌───────────────── backend: ingest gateway ─────────────┐
 │ auth by cluster token · tenant label injection ·      │
 │ cardinality & rate limits · plan limits                │
 └───────┬──────────────────────────────┬────────────────┘
         ▼                              ▼
   VictoriaMetrics                 PostgreSQL
   (metrics, flows)          (objects, events, rules, users)
         ▲                              ▲
         └──── backend REST API ────────┘ ◄── web (Vue SPA)
                     ▲
          alert-worker / anomaly-worker ──► Slack · Telegram · Email · Webhook
```

- Agents **push**; the backend never connects into customer clusters. Works behind NAT and firewalls; only outbound HTTPS 443 is needed.
- Collection interval: **15 s** for metrics, **real-time watch** for Kubernetes objects/events (batched every 5 s).
- Agents buffer up to **15 minutes** of data on disk (`emptyDir`, max 200 MB) when the backend is unreachable, then replay.
- Every series carries labels `cluster_id` (injected server-side from the token, never trusted from the agent) and `tenant_id` (Cloud).

## 5.3 Deployment modes

| Mode | How | Who |
|---|---|---|
| **Community, Kubernetes** | One Helm chart `watchlog/watchlog` installs agent + cluster-agent + backend + web + VictoriaMetrics + PostgreSQL into namespace `watchlog`. UI via port-forward or Ingress. | Self-hosters |
| **Community, Docker** | `docker compose up -d` with `deploy/docker/compose.yaml` (backend, web, VictoriaMetrics, PostgreSQL) + `docker run` agent on each host. | Docker users |
| **Cloud** | Customer installs only the agent chart with a token pointing at `ingest.watchlog.io`. | Cloud users |
| **Enterprise** | Same as Community chart + license key + `ee` image tags; HA values file (P2). | Enterprises |

Self-hosted footprint target (10 nodes, 15 d retention): backend 256 MB, VictoriaMetrics 512 MB, PostgreSQL 256 MB, agent ≤ 64 MB per node.

## 5.4 Multi-tenancy (Cloud)

- VictoriaMetrics: single-node in v2.0 with `tenant_id` label enforced on every query by the backend query proxy (users never send raw queries without the injected filter). Move to VictoriaMetrics cluster with native `accountID` tenants when > 2,000 nodes.
- PostgreSQL: every tenant table has `org_id`; enforced with Row-Level Security policies as a second layer.
- Retention per plan implemented by separate VictoriaMetrics instances per retention tier (3 d, 30 d) in v2.0 — simplest correct approach.

## 5.5 Cloud production hosting (v2.0)

WatchLog Cloud starts on **one Ubuntu server (22.04 / 24.04 LTS) running the whole stack with Docker Compose**. This is deliberately simple; it is enough for the first ~1,000 monitored nodes.

- File: `deploy/cloud/compose.yaml` (in the private Cloud repository it is extended with billing settings and secrets).
- Services: `caddy` (reverse proxy, automatic TLS via Let's Encrypt), `backend` (API + ingest), `alert-worker`, `anomaly-worker` (P1), `web` (static files served by Caddy), `victoriametrics-3d`, `victoriametrics-30d`, `postgres`, `redis`.
- Domains on `watchlog.io`: `watchlog.io` (site), `app.watchlog.io` (dashboard), `ingest.watchlog.io` (agents), `api.watchlog.io` (optional, or `app.watchlog.io/api`), `status.watchlog.io` (external status page).
- Only ports 80/443 are open (UFW). PostgreSQL, Redis and VictoriaMetrics listen on the internal Docker network only. SSH with keys only.
- Persistent data in named volumes on a dedicated disk mount (`/srv/watchlog`). Nightly backups: `pg_dump` + WAL archiving and VictoriaMetrics snapshots, shipped to off-site S3-compatible storage; restore tested monthly.
- Deploy: GitHub Actions builds and pushes images to GHCR; the server pulls tagged images with `docker compose pull && docker compose up -d` (manually triggered workflow over SSH, or a small deploy script). Database migrations run as a one-shot `backend migrate` container before the new backend starts.
- The production server is monitored by a separate WatchLog Community install (dogfooding) plus an external uptime check.
- **Scale-out path (later):** move PostgreSQL to a managed service, VictoriaMetrics to its cluster version on a second server, then run backend replicas behind the proxy. The Compose layout keeps each service stateless or clearly stateful so this split is a configuration change, not a rewrite.


# 6. Agent specification

## 6.1 Goals and budgets

| Requirement | Target |
|---|---|
| Memory per node | ≤ 64 MB RSS (P0), ≤ 50 MB (goal) |
| CPU per node | ≤ 1 % of one core average at 15 s interval on a 50-pod node |
| Binary / image | Single static Go binary; distroless image ≤ 40 MB; `linux/amd64` and `linux/arm64` |
| Install time | Helm install → first data in backend ≤ 60 s |
| Kubernetes versions | 1.26+ |
| Kernel for eBPF | 5.8+ with BTF (CO-RE). Older kernels: agent runs without network features and reports `ebpf: unsupported` |
| Container runtimes | containerd, CRI-O, Docker Engine 20.10+ |

## 6.2 Modes (two binaries, one Go module — ADR-048)

| Mode | Binary / image | Flag | Deployed as | Collects |
|---|---|---|---|---|
| Node | `agent` | `--mode=node` (default) | DaemonSet | Host metrics, cgroup v1/v2 container metrics, kubelet summary, eBPF flows |
| Cluster | `cluster-agent` | — | Deployment (1 replica, leader election) | K8s objects, events, kube-state style metrics; serves the node-scoped pod map |
| Docker | `agent` | `--mode=docker` | `docker run` on each host | Host metrics, containers via Docker socket (read-only), eBPF flows |

Only the cluster-agent links client-go (it adds ~21 MB to the binary and ~11 MB idle RSS, measured), so node and Docker agents keep a small footprint.

## 6.3 Collectors (node / docker mode)

| Collector | Source | Key metrics (all prefixed `watchlog_`) |
|---|---|---|
| host | `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/diskstats`, `/proc/net/dev`, `statfs` | `node_cpu_seconds_total{mode}`, `node_memory_bytes{state}`, `node_load1/5/15`, `node_disk_io_bytes_total{dev,dir}`, `node_filesystem_bytes{mount,state}`, `node_network_bytes_total{iface,dir}` |
| containers | cgroups v2 (`cpu.stat`, `memory.current`, `memory.stat`, `io.stat`), v1 fallback | `container_cpu_seconds_total`, `container_cpu_throttled_seconds_total`, `container_memory_working_set_bytes`, `container_memory_limit_bytes`, `container_cpu_limit_cores`, `container_fs_bytes` (writable layer), `container_fs_io_bytes_total{dir}` (block I/O), `container_network_bytes_total{dir}` |
| runtime | Kubernetes: pod UID and container ID from cgroup paths, names and workload from the cluster-agent's node-scoped pod map (no CRI socket, ADR-049); Docker: Docker socket | container ↔ pod/namespace mapping, image, state, restart count, health: `container_state{state}`, `container_health{status}`, `container_restarts_total`, `container_oom_events_total`, `container_start_time_seconds`, `docker_info{docker_version,kernel,os,arch}` |
| kubelet | `/stats/summary` (node-local, authenticated with ServiceAccount; TLS `auto`/`verify`/`skip`, ADR-051) | ephemeral storage, volume (PVC) usage, pod network |
| network (eBPF) | §6.4 | `flow_connections_total`, `flow_connect_failed_total`, `flow_connect_latency_seconds` (histogram), `flow_bytes_total{dir}`, `flow_retransmits_total`, `dns_requests_total{rcode}` |

Labels on container series: `cluster_id` (server-injected), `node`, `namespace`, `pod`, `container`, `workload_kind`, `workload`. Docker mode: `host`, `container`, `image`, `compose_project`, `compose_service`.

**Cardinality rules (MUST):** no pod UID, no container ID, no IPs, no ports above the well-known range as labels except on flow series where the destination is aggregated (see §6.4). Agent hard cap: 20,000 active series per node; beyond that, drop lowest-priority collectors and emit `watchlog_agent_series_dropped_total`.

## 6.4 eBPF network collection

- Library: `github.com/cilium/ebpf` with CO-RE; programs compiled at build time via `bpf2go`.
- Hooks: `tcp_connect` / `inet_sock_set_state` tracepoint (connection lifecycle, latency, failures), `tcp_retransmit_skb`, `tcp_sendmsg` / `tcp_cleanup_rbuf` (bytes), UDP 53 kprobes or socket filter for DNS rcode.
- Per-connection state is aggregated **in user space every 15 s** into edges keyed by `(src_workload, dst_workload | dst_external, dst_port)`.
- IP → workload resolution uses the pod/service cache received from the cluster-agent (node agents subscribe to a lightweight endpoint on the cluster-agent, not to the API server directly, to protect the API server at scale).
- External destinations are aggregated by DNS name when known (from the DNS collector), otherwise by `/24` network + port, and collapsed into "Internet" beyond 50 distinct externals per workload.
- eBPF is **opt-out** (`agent.networkFlows.enabled=true` by default, ADR-107). If disabled or unsupported, everything else still works, and the service map says why and shows the fix.

## 6.5 Cluster-agent

- Uses client-go informers for: Nodes, Namespaces, Pods, Deployments, ReplicaSets (owner resolution), StatefulSets, DaemonSets, Jobs, CronJobs, PVCs, HPAs, Events (Phase 2, ADR-052); Services, Endpoints/EndpointSlices, Ingresses and PVs are added with the service map (Phase 4).
- Sends object **snapshots** (on start and every 10 min) and **deltas** (on change) to `POST /ingest/v1/objects` — trimmed to the fields the UI needs (no `managedFields`, no annotations except an allow-list, **never** env values or Secrets).
- Emits state metrics (`kube_pod_status_phase`, `kube_deployment_replicas{state}`, `kube_node_condition`, `kube_pod_container_restarts_total`, `kube_pod_container_last_termination_reason`, etc.; list and cap in ADR-056). Resource requests and limits stay on the objects, not as series.
- Ships events to `POST /ingest/v1/events` in batches.
- Serves node agents a node-scoped pod map (pod UID → namespace, pod, workload; container ID → container name) over in-cluster HTTPS, authenticated with the node agent's ServiceAccount token via TokenReview; each node gets only its own pods (ADR-066). Phase 4 adds the IP→workload map to the same endpoint.
- Node agents never depend on the cluster-agent for node-level metrics; they keep the last pod map on disk, hold unmapped container series up to 60 s, then drop and count them (ADR-049).

## 6.6 Security and RBAC

- Cluster-agent ClusterRole is **read-only**: `get, list, watch` on the resources in §6.5, plus `create` on `tokenreviews` (pod map authentication); a namespaced Role for its leader-election Lease. Node agent ClusterRole: `get` on `nodes/stats` only. **No access to Secrets, ConfigMaps or `nodes/proxy`** (ADR-049, ADR-060). `pods/log` `get` only if logs-on-demand (P1) is enabled.
- Node agent runs with `hostNetwork: false`, `hostPID` only where measured necessary, as a non-root user, read-only root filesystem, all capabilities dropped and none added until eBPF (Phase 4: `BPF`, `PERFMON`, `SYS_RESOURCE`, `SYS_PTRACE` for `/proc/<pid>` of other containers, `NET_ADMIN` only if required by the chosen hook). The release namespace is labelled `pod-security.kubernetes.io/enforce: privileged` because the agent needs read-only hostPath mounts of `/proc` and `/sys`. Document every capability and exception in `docs/security.md`.
- Docker mode mounts `/var/run/docker.sock` **read-only** and only calls list/inspect/stats/events endpoints.
- Transport: HTTPS with TLS 1.2+; cluster token in `Authorization: Bearer`. Tokens are per cluster, revocable, 256-bit random values stored as a SHA-256 hash in the backend (a slow hash adds cost without security for high-entropy tokens; argon2id is used for passwords; ADR-025).
- The agent never executes remote commands and has no inbound port except `:8080/healthz` and `:8080/metrics` (self-metrics), bound to pod IP.

## 6.7 Configuration

Helm values (excerpt):

```yaml
watchlog:
  endpoint: https://ingest.watchlog.io   # or in-cluster backend for Community
  clusterToken: ""                         # or existingSecret
  clusterName: production
agent:
  interval: 15s
  ebpf:
    enabled: true
  resources:
    requests: { cpu: 20m, memory: 48Mi }
    limits:   { memory: 128Mi }
  tolerations: [{ operator: Exists }]       # run on every node incl. control plane
clusterAgent:
  enabled: true
logs:
  enabled: false                            # P1
```

Docker install (shown on the onboarding screen):

```bash
docker run -d --name watchlog-agent --restart unless-stopped \
  --pid host --cap-add BPF --cap-add PERFMON --cap-add SYS_RESOURCE \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro \
  -e WATCHLOG_TOKEN=<token> -e WATCHLOG_ENDPOINT=https://ingest.watchlog.io \
  ghcr.io/watchlog-light/agent:latest --mode=docker
```

## 6.8 Self-observability and upgrades

- The agent exposes its own metrics (`watchlog_agent_*`: memory, CPU, series count, send latency, buffer size, dropped series, eBPF status) and sends a **heartbeat** every 15 s including version and capabilities.
- The UI shows agent version per node and a banner when a newer version exists. Upgrades are always user-initiated (`helm upgrade`); the agent never auto-updates.
- Ingest protocol is versioned (`/ingest/v1/...`). Backend MUST accept agents up to two minor versions old.

# 7. Data model (PostgreSQL)

All tables have `id` (UUID v7), `created_at`, `updated_at`. Tenant tables have `org_id` with RLS.

| Table | Key columns | Notes |
|---|---|---|
| `users` | email (unique), password_hash (argon2id), name, locale (default `en`), email_verified_at, signup_source (utm) | |
| `sessions` | user_id, token_hash (SHA-256), expires_at, last_seen_at | Web sessions (ADR-033) |
| `orgs` | name, slug, plan (`community`/`free`/`pro`/`enterprise`), stripe_customer_id, stripe_subscription_id, trial_ends_at | |
| `memberships` | org_id, user_id, role (`owner`/`admin`/`viewer`) | |
| `invites` | org_id, email, role, token_hash, expires_at | |
| `clusters` | org_id, name, kind (`kubernetes`/`docker`), status, first_seen_at, last_seen_at, agent_version, k8s_version, node_count | |
| `cluster_tokens` | cluster_id, token_hash, prefix (first 8 chars shown in UI), revoked_at | |
| `agent_instances` | cluster_id, node, mode, agent_version, capabilities (jsonb), last_seen_at | One row per agent (node / Docker host), updated by heartbeats (ADR-029) |
| `objects` | cluster_id, source (`kubernetes`/`docker`), kind, namespace, name, uid, node, spec_summary (jsonb), status_summary (jsonb), deleted_at | Upsert by (cluster_id, uid). Kubernetes objects and Docker hosts/containers (ADR-029) |
| `k8s_events` | cluster_id, day, involved_key, namespace, involved_kind, involved_name, involved_uid, type, reason, message, count, event_counts (jsonb), first_ts, last_ts, reporting_controller | Partitioned by day (UTC); key (cluster_id, day, involved_key, reason), no id column; retention job (ADR-061) |
| `change_markers` | cluster_id, kind (`rollout`/`image`/`scale`/`node`), target, namespace, details (jsonb), ts | |
| `alert_rules` | org_id, cluster_id (nullable = all), name, type (`default`/`threshold`/`anomaly`), rule_key (default rules), metric, scope (jsonb), condition (jsonb), for_seconds, severity, renotify_seconds, enabled, channel_ids, eval_error | |
| `alert_channels` | org_id, type (`slack`/`telegram`/`email`/`webhook`), name, config (jsonb, secrets encrypted with AES-GCM), verified_at | |
| `alert_states` | org_id, rule_id, cluster_id, fingerprint, state (`pending`/`firing`/`resolved`), severity, labels (jsonb), details (jsonb), started_at, fired_at, resolved_at, last_notified_at, silenced, flapping, held, rule_snapshot (jsonb), version | One open row per (rule, cluster, fingerprint); held = state unknown (ADR-094); rule_snapshot = the rule as the alert was evaluated (ADR-098) |
| `alert_worker_heartbeats` | worker_id, version, started_at, lock_pid, buckets, last_cycle_at, last_error | One row per running worker (ADR-088) |
| `alerting_periods` | started_at, ended_at | When alerting ran; gaps explain late alerts (ADR-098) |
| `server_settings` | key (`general`/`smtp`/`telegram`), value (jsonb), secret (encrypted) | Settings made in the UI; environment overrides (ADR-093) |
| `secret_key_check` | canary | Proves the secret key can decrypt stored secrets (ADR-079) |
| `telegram_verifications` | channel_id, code_hash, expires_at | Telegram deep-link connection |
| `notifications` | org_id, channel_id, kind (`firing`/`resolved`/`renotify`/`escalated`/`flapping`/`test`), payload (jsonb), status (`pending`/`sending`/`sent`/`failed`/`dropped`), attempts, next_attempt_at, dedupe_key, error, sent_at | The outbox: one row per channel and message (ADR-074); `notification_alerts` links a message to the alerts it covers |
| `silences` | org_id, matchers (jsonb), starts_at, ends_at, created_by, comment | |
| `anomaly_baselines` (P1) | series_key, hour_of_week, median, mad, samples, updated_at | |
| `funnel_events` | user_id, org_id, name, props (jsonb), ts | §10.4 |
| `subscriptions` (Cloud repo) | org_id, plan, stripe_subscription_id, nodes_billed_p95, period_start, period_end, status | Private Cloud repository; source of truth is Stripe, synced via webhooks |
| `audit_log` (E) | org_id, actor_id, action, target, diff (jsonb), ip, ts | `ee/` |

Migrations: `node-pg-migrate` (or Drizzle migrations — decide in Phase 0), forward-only, one file per change.

# 8. API

REST + JSON, base path `/api/v1`. Auth: HTTP-only secure session cookie for the web app; `Authorization: Bearer wl_pat_...` for personal API tokens. Errors follow RFC 9457 (`application/problem+json`). OpenAPI 3.1 spec generated from Fastify schemas at `/api/v1/openapi.json`.

## 8.1 Public API (excerpt)

| Method & path | Purpose |
|---|---|
| `POST /auth/signup` · `POST /auth/login` · `POST /auth/logout` | Email + password |
| `GET /auth/oauth/github` · `/google` | OAuth login (P0 GitHub, P1 Google) |
| `POST /auth/verify-email` · `POST /auth/forgot` · `POST /auth/reset` | |
| `GET /me` · `PATCH /me` | Profile, locale |
| `GET/POST /orgs` · `GET/PATCH /orgs/:id` · `POST /orgs/:id/invites` | |
| `GET/POST /clusters` · `GET/PATCH/DELETE /clusters/:id` | Create returns install commands + token (shown once) |
| `POST /clusters/:id/tokens` · `DELETE /clusters/:id/tokens/:tid` | Rotate / revoke |
| `GET /clusters/:id/onboarding-status` | Server-sent events: `agent_seen`, `cluster_agent_seen`, `first_metrics`, `ebpf_status`, `service_map_ready` |
| `GET /clusters/:id/overview` | Data for §4.1 |
| `GET /clusters/:id/nodes` · `/nodes/:name` | |
| `GET /clusters/:id/workloads` · `/pods` · `/pods/:ns/:name` | |
| `GET /clusters/:id/docker/hosts` · `/docker/containers` | |
| `GET /clusters/:id/service-map?from&to&namespace` | Graph JSON: `{nodes:[], edges:[]}` |
| `GET /clusters/:id/events` | Paged, filterable |
| `POST /query/range` | Curated metric query: `{clusterId, metric, scope?: {host?, container?, composeProject?}, agg?, step?, from, to}` (unix seconds); `metric` is one of the catalog keys in `backend/src/modules/query/catalog.ts` (16 in Phase 1) → backend builds MetricsQL with tenant filter. Raw MetricsQL only for P1 advanced mode. |
| `GET/POST/PATCH/DELETE /alert-rules` | |
| `GET/POST/PATCH/DELETE /alert-channels` · `POST /alert-channels/:id/test` | |
| `GET /alerts` (firing & history) · `POST /silences` | |
| `POST /funnel` | Client-side funnel events (§10.4) |

## 8.2 Ingest API (agent → backend)

| Method & path | Body | Notes |
|---|---|---|
| `POST /ingest/v1/write` | Prometheus remote_write (protobuf + snappy) | Backend validates token, injects `cluster_id`/`tenant_id`, enforces series limits, forwards to VictoriaMetrics |
| `POST /ingest/v1/heartbeat` | `{agent_version, mode, node, capabilities:{ebpf, cgroup}, series}` | Updates `clusters.last_seen_at`; triggers onboarding SSE |
| `POST /ingest/v1/objects` | `{snapshot|delta, objects:[...]}` (JSON, gzip) | |
| `POST /ingest/v1/events` | `{events:[{uid, namespace, involved:{kind, namespace, name, uid}, type, reason, message, count, first_ts, last_ts, reporting_controller}]}` (≤ 1,000 per request, JSON, gzip) | ADR-061 |

Responses: `204` OK; `401` bad token (agent logs a clear message and backs off 5 min); `413` / `429` with `Retry-After` for limits; `402` plan limit reached (agent keeps running, backend drops data beyond limit and the UI shows an upgrade banner).


# 9. Website and landing page

Built with Nuxt 4 in static mode, dark theme only (§11), English only. The marketing site's code lives in a separate private repository, not in this one (ADR-114). What users need from it stays public here: the docs (`docs/site/*.md`, rendered at `/docs` and `/security`), the screenshots (`docs/images/`) and the design tokens (`packages/design-tokens/`). The site's build takes them from this repository at a pinned commit, and fails when one is missing. Fast: Lighthouse ≥ 95 on performance and SEO, no client-side framework for content pages beyond what Nuxt ships.

## 9.1 Sitemap

| Path | Page |
|---|---|
| `/` | Landing |
| `/pricing` | Editions & pricing (§3) with node-count calculator |
| `/docs` | Documentation rendered from `docs/site/*.md` in this repository — install, configuration, alerts, security, FAQ |
| `/blog` | Blog (English, technical articles on Kubernetes / Docker monitoring for SEO) |
| `/open-source` | Why open source, license, how to contribute, link to GitHub |
| `/security` | What the agent can and cannot access (RBAC, capabilities, data sent) |
| `/enterprise` | Enterprise features + contact form |
| `/compare/prometheus-grafana` | Honest comparison vs DIY stack (P1) |
| `/legal/terms` · `/legal/privacy` | |
| `app.watchlog.io` | Dashboard (`web/`), separate origin |

## 9.2 Landing page sections (in order)

1. **Top bar:** logo, Product, Pricing, Docs, Blog, GitHub (with live star count), "Sign in", primary button **"Start free"**.
2. **Hero:**
   - Headline: **"See everything in your Kubernetes and Docker — in 5 minutes."**
   - Sub-headline: "Open-source monitoring with one agent. Nodes, pods, containers and the network between your services. No PromQL, no dashboards to build."
   - Buttons: **Start free** (primary green) · **View on GitHub** (secondary, outline).
   - Under the buttons: a copyable code block with `helm install` command and a tab for Docker.
   - Right side / below: product screenshot of the service map in dark UI with subtle green glow.
3. **Trust strip:** "Open source (AGPL-3.0) · Read-only agent · Self-host or use our cloud · Built with eBPF".
4. **Three pillars** (cards with icon): *One-command install* · *Service map without code changes* · *Alerts that work on day one* (Slack, Telegram, Email, Webhook).
5. **Feature walkthrough** (alternating text + screenshot): Cluster overview → Workloads & pods (restart reasons, OOM) → Service map → Alerts → Docker hosts.
6. **"Why not just Prometheus + Grafana?"** — short honest table: setup time, maintenance, service map, default alerts, cost. Link to full comparison.
7. **How it works:** 3 steps — Install agent → Data arrives → Get alerted. Small architecture diagram.
8. **Security block:** "What the agent can see" — bullets from §6.6, link to `/security`.
9. **Pricing teaser:** 4 cards (Community, Cloud Free, Pro, Enterprise) with "Compare plans" link.
10. **Open source block:** GitHub stars, contributors, "Self-host in one command".
11. **FAQ:** Is it really free? What data leaves my cluster? Which kernels support eBPF? Can I use it in air-gapped networks? How is it different from Coroot / Netdata? Which alert channels are supported? Where is Cloud data stored?
12. **Final CTA:** "Install WatchLog now" + Start free / GitHub.
13. **Footer:** product links, docs, blog, GitHub, Discord community, status page, legal.

## 9.3 SEO and analytics

- Each page: unique `<title>`, meta description, Open Graph image (dark, green accent), JSON-LD (`SoftwareApplication`, `FAQPage`).
- Privacy-friendly analytics (self-hosted Plausible or Umami). UTM parameters captured into `users.signup_source` on signup.

# 10. Signup and onboarding

The onboarding flow is the most important part of the product. Every step has a target time.

## 10.1 Signup — target ≤ 60 s

- Fields: email, password (min 10 chars, strength meter). Or **Continue with GitHub** (P0) / Google (P1).
- No company name, no phone, no credit card. Email verification link is sent but **does not block** onboarding (verify within 7 days to keep the account).
- After signup → straight to "Add your first cluster".

## 10.2 Add cluster wizard — target ≤ 3 min

1. **What do you want to monitor?** Two large cards: *Kubernetes cluster* · *Docker host(s)*.
2. **Name it** (pre-filled `my-cluster`).
3. **Install** — the screen shows the exact command with the token already embedded and a copy button. Tabs: Helm · kubectl manifest (`kubectl apply -f https://.../install.yaml?token=...`) · Docker run · Docker Compose snippet.
4. **Live connection checklist** (Server-Sent Events from `/clusters/:id/onboarding-status`):
   - ☐ Waiting for agent… → ✓ Agent connected on *N* nodes
   - ✓ Cluster agent connected (Kubernetes only)
   - ✓ First metrics received
   - ✓ eBPF network monitoring: enabled / not supported on kernel X (with explanation)
   - ✓ Service map ready (after ~2 min of traffic)
5. When the first metrics arrive, a **"Open dashboard"** button becomes primary and pulses once.
6. **Connect an alert channel** (skippable): Slack (OAuth or webhook), Telegram bot via deep link with one-click verification, email (pre-filled with the user's email).

## 10.3 Troubleshooting helpers (inside the wizard)

If no heartbeat after 2 minutes, show an expandable panel:

- Copy-paste diagnostic: `kubectl -n watchlog get pods` and `kubectl -n watchlog logs ds/watchlog-agent --tail=50`.
- Common causes: egress to `ingest.watchlog.io:443` blocked (show the IPs / domain to allow), wrong token, PodSecurity admission blocking capabilities (show the namespace label to apply), kernel without BTF.
- **"Get help installing"** button → opens Discord community / email with the cluster ID pre-filled. Founder-led concierge onboarding is part of the launch strategy.

## 10.4 Funnel tracking (P0, from day one)

Events stored in `funnel_events` (server-side where possible, client-side through `POST /api/v1/funnel`):

| Event | Fired when |
|---|---|
| `signup_completed` | Account created (props: method, source) |
| `cluster_created` | Wizard step 2 done (props: kind) |
| `install_command_copied` | Copy button clicked (props: method) |
| `agent_first_heartbeat` | First heartbeat for a cluster |
| `first_metrics_received` | First successful remote_write |
| `dashboard_first_view` | User opens overview with data |
| `alert_channel_connected` | Channel verified |
| `first_alert_sent` | First real notification |
| `day7_active` | Cluster still sending data 7 days after first heartbeat (daily job) |

An internal admin page (`/admin/funnel`, owner-only, behind an env flag) shows conversion between steps per week.

**Lifecycle emails (Cloud):** 1 h after signup without heartbeat → "Need help installing?" (plain text, from the founder). 24 h → troubleshooting tips. Day 3 with data → "Set up alerts". Day 25 of Free with > 5 nodes → upgrade suggestion.

# 11. Design system — dark only (v2.0)

The whole product (site + app) is **dark only** in v2.0. Light theme MAY be added later; all colours MUST come from CSS custom properties (tokens) so that a light theme is a token swap, not a rewrite.

## 11.1 Colour tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0E0F11` | Page background |
| `--surface-1` | `#15171A` | Cards, panels |
| `--surface-2` | `#1B1E22` | Hover, nested panels, table header |
| `--surface-3` | `#22252A` | Inputs, active rows |
| `--border` | `#2A2E34` | Borders, dividers |
| `--border-strong` | `#3A3F46` | Focused inputs, separators |
| `--text` | `#E8EAED` | Primary text |
| `--text-muted` | `#9BA1A9` | Secondary text, labels |
| `--text-subtle` | `#6B7179` | Placeholders, disabled |
| `--primary` | `#22C55E` | Brand green: primary buttons, links, active nav, focus ring |
| `--primary-hover` | `#16A34A` | Primary hover / pressed |
| `--primary-soft` | `rgba(34,197,94,0.12)` | Selected backgrounds, badges |
| `--primary-glow` | `rgba(34,197,94,0.35)` | Hero glow (site only) |
| `--on-primary` | `#04140A` | Text on green buttons |
| `--ok` | `#22C55E` | Healthy status |
| `--warning` | `#F5A524` | Warning |
| `--critical` | `#F04438` | Critical / error |
| `--info` | `#3B9EFF` | Informational |

**Status vs brand:** because the brand colour is green and "healthy" is green, status MUST never rely on colour alone — always pair with an icon and label (✓ Healthy, ▲ Warning, ✕ Critical).

**Chart palette** (series order, tested on `--surface-1`): `#22C55E`, `#3B9EFF`, `#F5A524`, `#A78BFA`, `#2DD4BF`, `#F472B6`, `#FB923C`, `#94A3B8`. Grid lines `--border`, axis labels `--text-muted`.

## 11.2 Typography

- UI: **Inter** (variable), 14 px base in the app, 16 px on the site.
- Code and metric values: **JetBrains Mono**, tabular numbers (`font-variant-numeric: tabular-nums`) everywhere numbers update.
- Scale: 12 / 13 / 14 / 16 / 20 / 24 / 32 / 48 / 64 px. Headings 600 weight, body 400.
- 11 px is a step for two uses only: uppercase micro-labels (section labels with letter-spacing, e.g. filter headings) and chart axis labels. Everything else uses 12 px or more (ADR-115).

## 11.3 Layout and components

- App shell: left sidebar (240 px, collapsible to 64 px) with cluster switcher at top; top bar with time range, namespace filter, search (⌘K command palette, P1).
- Radius: 6 px (inputs, buttons), 10 px (cards). Spacing scale 4 px base.
- Components (built in `web/src/components/ui`, Tailwind-based, no heavy UI kit): Button (primary / secondary / ghost / danger), Input, Select, Combobox, Tabs, Table (virtualised for > 500 rows), Card, StatTile, Badge/StatusPill, Tooltip, Drawer, Modal, Toast, EmptyState, CodeBlock with copy, TimeRangePicker, Sparkline, TimeSeriesChart (ECharts), ServiceMapGraph (ECharts graph or Cytoscape.js — decide in Phase 4).
- Empty states always explain what to do next, never just "No data".
- Accessibility: WCAG AA contrast on all text tokens, visible focus ring (`2px solid var(--primary)`; no glow in the app), full keyboard navigation.

## 11.4 Tailwind configuration

Tailwind theme maps directly to the tokens (`colors.bg = 'var(--bg)'`, etc.). Shared token file `packages/design-tokens/tokens.css` is imported by `web/` and copied into the marketing site at build time (§9).

# 12. Repository structure

Monorepo, on GitHub as `watchlog-light/watchlog` (private until launch). pnpm workspaces for JS/TS, Go module for the agent.

```
watchlog/
├── agent/                  # Go: node / cluster / docker modes
│   ├── cmd/watchlog-agent/
│   ├── internal/collectors/{host,containers,runtime,kubelet,network}/
│   ├── internal/ebpf/      # .c sources + bpf2go generated code
│   ├── internal/k8s/       # informers, cluster-agent
│   ├── internal/sender/    # remote_write, buffering, retries
│   └── Dockerfile
├── backend/                # Node.js 24, TypeScript, Fastify
│   ├── src/modules/{auth,orgs,clusters,ingest,query,alerts,funnel}/
│   ├── src/workers/{alert-worker,anomaly-worker}.ts
│   ├── migrations/
│   └── test/
├── web/                    # Vue 3 + Vite dashboard SPA
├── packages/
│   ├── design-tokens/      # tokens.css, tailwind preset
│   └── api-types/          # TS types generated from OpenAPI
├── ee/                     # Enterprise modules (commercial license)
├── deploy/
│   ├── helm/watchlog/      # full self-hosted chart
│   ├── helm/watchlog-agent/# agent-only chart (Cloud)
│   ├── docker/compose.yaml # self-hosted Community (Docker)
│   └── cloud/compose.yaml  # Cloud production stack on Ubuntu (§5.5)
├── docs/                   # SPEC.md, DECISIONS.md, security.md …; site/: the user docs
├── .github/workflows/      # CI: lint, test, build, e2e on kind
├── CLAUDE.md
├── LICENSE                 # AGPL-3.0
└── README.md
```

The marketing site (§9) is not in this repository; it lives in a private one and renders `docs/site/` from here. `pnpm check:private` fails if site code comes back.

The existing v1 repositories (`app_watchlog`, `get_metric`, `watchlog-backend`) are **frozen**: no new features. They stay online for any existing accounts until v2 Cloud launches, then are archived. Code MAY be copied from them only when it fits this spec; never import them as dependencies.


# 13. Roadmap and phases

Each phase ends with a demo-able result and explicit acceptance criteria. Durations are estimates for one developer working with Claude Code part-time.

## Phase 0 — Foundation (≈ 1 week)

- Monorepo skeleton (§12), pnpm workspaces, Go module, `CLAUDE.md`, `docs/` files, LICENSE, README.
- CI: lint + unit tests for Go and TS; Docker image builds for `agent`, `backend`, `web`.
- Design tokens package and Tailwind preset; `web` app shell with sidebar, top bar, dark theme, empty pages.
- Local dev: `docker compose -f deploy/docker/compose.dev.yaml up` brings up PostgreSQL, VictoriaMetrics, Redis, backend (watch mode), web (Vite).
- Decisions recorded: migration tool, ORM/query builder (Drizzle or Kysely), Fastify plugins, test framework (Vitest), Go version.

**Accept when:** `pnpm i && pnpm dev` and `make agent` work on a clean machine; CI is green; the app shell renders in dark theme with design tokens.

## Phase 1 — Docker mode end-to-end (≈ 2-3 weeks)

- Agent: host + containers + runtime (Docker socket) collectors; sender with remote_write, buffering, heartbeat.
- Backend: ingest gateway (token auth, label injection, limits), clusters + tokens API, curated `/query/range`.
- Web: Docker hosts list, containers list, container detail charts, host detail.
- Single-user local auth (Community mode).

**Accept when:** on a fresh VM, `docker compose up` (server) + one `docker run` (agent) shows host and container metrics in the UI within 60 s; agent ≤ 64 MB RSS with 30 containers; killing the backend for 5 minutes loses no data.

## Phase 2 — Kubernetes (≈ 3-4 weeks)

- Agent node mode (cgroups v2/v1, kubelet summary, CRI) and cluster mode (informers, objects, events, state metrics).
- Helm charts: `watchlog` (full self-hosted) and `watchlog-agent` (agent only).
- Web: cluster overview (§4.1), nodes, workloads, pods, pod detail with termination reasons, events, change markers.

**Accept when:** `helm install` on kind, k3s and one real multi-node cluster shows all P0 views; CrashLoopBackOff and OOMKilled test pods appear correctly within 30 s; e2e test on kind runs in CI.

## Phase 3 — Alerting (≈ 2 weeks)

- `alert-worker`, default rules (§4.7), custom threshold rules UI, silences.
- Channels: Slack, Telegram, Email, Webhook with "send test".

**Accept when:** every default rule has an automated test that triggers and resolves it; a CrashLoopBackOff pod produces exactly one firing and one resolve message per channel (Slack, Telegram, email, webhook).

## Phase 4 — Service map with eBPF (≈ 3-4 weeks)

- eBPF programs (connect, state, retransmit, bytes, DNS), IP→workload resolution via cluster-agent, edge aggregation.
- Web: service map graph, edge detail, DNS errors, external dependencies; fallback topology mode.
- Capability detection and reporting.

**Accept when:** on a demo app (e.g. a 6-service microservice demo) the map shows correct edges within 2 minutes; induced failures (scale a dependency to 0) show failed connections and fire the default rule; agent CPU stays within budget under 1,000 connections/s per node; kernels without BTF degrade gracefully.

**→ Open-source launch (Community):** GitHub public, docs site, Show HN, Reddit (r/kubernetes, r/selfhosted, r/docker), Product Hunt, CNCF Slack, dev.to / Medium posts.

## Phase 5 — Cloud and launch (≈ 3-4 weeks)

- Multi-tenancy (§5.4), signup / login / GitHub OAuth, orgs, invites, onboarding wizard with live checklist (§10), funnel tracking and admin funnel page, lifecycle emails.
- The marketing site on `watchlog.io` (landing, pricing, docs, blog), in its private repository (§9).
- Plan limits (Free: 1 cluster, 5 nodes, 3 d). Stripe billing ($1/node, $10 minimum, p95 node count, Customer Portal) in the private Cloud repository.
- Production deployment on the Ubuntu server with Docker Compose (§5.5), backups, monitoring by WatchLog Community itself.

**Accept when:** a new user goes from landing page to data on a kind cluster in under 5 minutes without reading docs (test with 5 real people, record times); funnel page shows every step.

## Phase 6 — Pro features (≈ 4 weeks)

- Multi-cluster overview, roles (Owner/Admin/Viewer), 30-day retention tier, SLO reports, right-sizing hints, logs on demand, basic anomaly detection (§4.8).

## Phase 7 — Enterprise (as demand appears)

- `ee/`: SSO (OIDC/SAML), LDAP, fine-grained RBAC, audit log, offline license keys, air-gapped install guide, HA Helm values, advanced anomaly correlation.

# 14. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Overview page loads < 1.5 s (p95) for a 100-node cluster; chart queries < 500 ms (p95) for 24 h range |
| Scale (Cloud v2.0) | 2,000 nodes total, 500 nodes per cluster |
| Availability (Cloud) | 99.5 % monthly for UI/API; ingest buffered by agents so short outages lose no data |
| Security | OWASP ASVS L1; argon2id password hashing; CSRF protection on cookie auth; rate limits on auth endpoints; channel secrets encrypted at rest; dependency scanning (Dependabot, `govulncheck`, `pnpm audit`) in CI; signed container images (cosign) |
| Privacy | No env values, Secrets, ConfigMap data, request payloads or TLS contents ever leave the cluster. Documented in `/security` and `docs/security.md` |
| Backups (Cloud) | PostgreSQL daily + WAL archiving; VictoriaMetrics daily snapshots for the 30 d tier |
| Testing | Go: unit tests per collector with fixture `/proc` and cgroup trees. Backend: Vitest unit + integration against real PostgreSQL/VictoriaMetrics in Docker. Web: Vitest component tests + Playwright for critical flows (signup, wizard, overview). E2E: kind cluster in CI installs Helm chart and asserts data arrives |
| Dogfooding | WatchLog Cloud is monitored by its own Community edition |
| i18n | English only in v2.0; all UI strings in `web/src/i18n/en.json` so more locales can be added later without refactoring |

# 15. Working with Claude Code

## 15.1 The `docs/` convention

| File | Purpose | Who updates |
|---|---|---|
| `docs/SPEC.md` | This document (Markdown version). Source of truth. | The maintainer; Claude Code proposes changes, never edits silently |
| `HISTORY.md` (private notes) | Append-only session log | Claude Code, **at the end of every session** |
| `docs/DECISIONS.md` | Architecture decision records (ADR-lite) | Claude Code when a decision is made; the maintainer approves |
| `docs/security.md` | Agent permissions, capabilities, data sent | Updated whenever the agent's access changes |
| `phases/phase-N.md` (private notes) | Checklist for the current phase, copied from §13, ticked as work completes | Claude Code |

The session log, the phase checklists, items pending review, designs and launch planning live in a
private notes repository next to this one, not in the public repository.

**HISTORY.md entry format:**

```markdown
## 2026-11-03 — Session 4 (Phase 1)
**Goal:** Docker containers collector
**Done:**
- Implemented cgroup v2 reader (agent/internal/collectors/containers)
- Added fixtures + 12 unit tests
**Decisions:** ADR-006 use cgroup v2 unified path detection via /proc/self/mountinfo
**Open / next:**
- cgroup v1 fallback not tested on CentOS 7
- Next session: runtime collector (Docker socket)
**Commits:** a1b2c3d, d4e5f6a
```

**DECISIONS.md entry format:**

```markdown
## ADR-006: <title>
- Date: 2026-11-03 · Status: accepted
- Context: <why a decision was needed>
- Decision: <what we chose>
- Alternatives: <what we rejected and why>
- Consequences: <trade-offs>
```

## 15.2 Rules for CLAUDE.md

```markdown
# WatchLog v2 — rules for Claude Code
- Source of truth: docs/SPEC.md. Read it and the last 3 entries of HISTORY.md at session start.
- Work only on the current phase (phases/). Do not build P1/P2 items early.
- Non-goals in SPEC §2.5 are hard limits. If a task seems to need one, stop and ask.
- Measure before changing: inspect real data (API responses, metrics, DB rows) before
  changing query or ingest code. Never infer data shapes from code alone.
- Keep UI changes and backend/agent changes in separate commits so each can be reverted alone.
- Every controller returns a response on every path (no swallowed errors without a reply).
- Agent: respect the budgets in SPEC §6.1; add a benchmark when touching collectors.
- Security: the agent must never read Secrets, ConfigMap data or env values.
- All colours come from design tokens; no hex values in components.
- English for code, comments, commits and docs. UI strings via i18n (en).
- At session end: append to HISTORY.md, update phases/phase-N.md checkboxes,
  record any decision in docs/DECISIONS.md.
- Conventional commits (feat:, fix:, chore:, docs:, refactor:, test:).
```

## 15.3 Kick-off prompt (paste into Claude Code for session 1)

```text
We are starting WatchLog v2, an open-source monitoring product for Kubernetes and
Docker. The full specification is in docs/SPEC.md (I will add it now). Read it
completely before doing anything.

Your task for this session is Phase 0 only (SPEC §13):
1. Create the monorepo structure from SPEC §12 (agent in Go, backend in Node.js 22 +
   TypeScript + Fastify, web in Vue 3 + Vite + Tailwind, site placeholder, packages/
   design-tokens with the tokens from SPEC §11.1).
2. Create CLAUDE.md with the rules from SPEC §15.2.
3. Create HISTORY.md, docs/DECISIONS.md, docs/security.md and
   phases/phase-0.md (checklist from SPEC §13 Phase 0).
4. Set up deploy/docker/compose.dev.yaml with PostgreSQL 16, VictoriaMetrics and
   Redis 7, plus pnpm dev scripts for backend and web.
5. Build the web app shell: dark theme only, sidebar, top bar, empty pages for
   Overview, Nodes, Workloads, Docker, Service Map, Alerts, Settings.
6. Add GitHub Actions CI: lint + test for Go and TS, build Docker images.

Before writing code, list the decisions Phase 0 needs (ORM, migration tool, test
framework, Go version, etc.), propose one option for each with a one-line reason,
and wait for my approval. Record approved decisions in docs/DECISIONS.md.

At the end of the session, append an entry to HISTORY.md in the format from
SPEC §15.1 and tick completed items in phases/phase-0.md.
```

## 15.4 Prompt template for every later session

```text
Continue WatchLog v2. Read CLAUDE.md, the last 3 entries of HISTORY.md and
phases/phase-<N>.md. Today's goal: <one concrete item from the phase checklist>.
Start by telling me your plan in 5 bullets or fewer, then implement it with tests.
End the session by updating HISTORY.md, the phase checklist and DECISIONS.md.
```

# 16. Open questions

_Not part of the public specification._
