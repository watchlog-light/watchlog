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
- **Fully open source (AGPL-3.0)** and self-hostable at no cost, for any number of clusters, Docker fleets and nodes (ADR-151). The agent's source is public, which removes the trust barrier of installing a closed agent on production.
- **Cloud and Enterprise editions** for teams that want zero maintenance, a unified view across clusters, longer retention, anomaly detection and enterprise controls.

## 2.4 Target users

| Persona | Context | What they need | Edition |
|---|---|---|---|
| **Solo DevOps / small startup** | 1 cluster or a few Docker hosts, 3-30 nodes | Fast setup, alerts to Telegram/Slack, free | Community or Cloud Free |
| **Growing product team** | 2-5 clusters (staging/prod), 20-200 nodes | No maintenance, multi-cluster view, 30-day history, smart alerts | Cloud Pro |
| **Regulated organisation** (bank, telco, fintech, government) | On-prem, air-gapped, strict access control | Self-hosted, SSO/LDAP, RBAC, audit, support SLA | Enterprise |
| **Learner / blog reader** | Minikube, kind, homelab | Easy try-out, good docs | Community |

## 2.5 Non-goals (v2.0)

WatchLog v2 MUST NOT include, in any edition, until explicitly re-scoped:

- Windows and macOS servers. (Linux servers outside a container runtime were a non-goal until 0.9.0; re-scoped by the owner on 2026-11-17: §4.15, ADR-207. The v1 agent stays deprecated.)
- APM / distributed tracing / profiling / code-level instrumentation, also on servers: WatchLog watches processes, cgroups and the network, never code.
- Log management (search, indexing). Showing the last N lines of a container's log, a unit's journal or a process manager's log on demand is allowed (P1).
- Synthetic monitoring, uptime checks from multiple regions, RUM. (Network devices, §4.17, are not this: no HTTP or ping checks of websites or services from outside; WatchLog reads the switches and routers the servers sit on, from inside the network, as the infrastructure under them. Re-scoped by the owner on 2026-11-24, ADR-233.)
- A dashboard builder beyond widgets of the user's own metrics. WatchLog's own pages are opinionated and fixed. Dashboards exist for the user's own metrics only (§4.18), built from widgets (a metric, a shape, at most one label to split by, a size): no query language, no variables, no formulas, and none of WatchLog's own metrics on them. (A custom dashboard builder was a non-goal in full until 1.0.0; re-scoped by the owner on 2026-11-25, ADR-237.)
- Docker Swarm, Nomad, OpenShift-specific features (they may work, but are not targeted).

## 2.6 Lessons from WatchLog v1

_Not part of the public specification._

## 2.7 Success metrics

_Not part of the public specification._

# 3. Editions and pricing

> WatchLog Cloud opens as a beta in release 0.6.0, before the launch (ADR-173). While billing is off (`BILLING_LIVE=false`), Pro is free during the beta, with 14 days' notice before billing starts. On WatchLog Cloud billing is live since 2026-11-18 at ADR-215's price, so Pro is paid there; since 0.9.5 no page or email offers the beta's free Pro unless the billing service says it is off (ADR-205, amended).

## 3.1 Principles

1. **The free product is complete, for every cluster you run.** Monitoring, service map and alerting are never paywalled.
2. **Money comes from convenience and organisation-scale needs**: hosting, retention, a unified multi-cluster view, intelligence (anomaly detection), compliance and support.
3. **Nothing that was ever free becomes paid.** Only new capabilities can be paid.
4. **Simple unit: price per monitored node per month** (a Kubernetes node or a Docker host).

## 3.2 Edition matrix

| | **Community** | **Cloud Free** | **Cloud Pro** | **Enterprise** |
|---|---|---|---|---|
| Hosting | Self-hosted | WatchLog Cloud | WatchLog Cloud | Self-hosted or dedicated cloud |
| License | AGPL-3.0 | — | — | Commercial (`ee/`) |
| Price | Free | Free | **$3 / node or server / month** (min. $15 / month, which covers the first 5; ADR-215) | Custom quote |
| Clusters / Docker fleets | Unlimited (ADR-151) | 1 | Unlimited | Unlimited |
| Nodes | Unlimited | Up to 5 | Unlimited | Unlimited |
| Node, workload, pod, container metrics | ✓ | ✓ | ✓ | ✓ |
| Docker host & container metrics | ✓ | ✓ | ✓ | ✓ |
| Service map & network (eBPF) | ✓ | ✓ | ✓ | ✓ |
| Kubernetes events & restarts | ✓ | ✓ | ✓ | ✓ |
| Default + custom threshold alerts | ✓ | ✓ | ✓ | ✓ |
| Channels: Slack, Telegram, Email, Webhook | ✓ | ✓ | ✓ | ✓ |
| Probable cause: fixed rules with their evidence, in the UI, API, MCP and messages (v0.4, ADR-146) | ✓ | ✓ | ✓ | ✓ |
| Data retention | Limited by your disk (default 15 d) | 3 days | 30 days | Configurable (1 year+) |
| Users | Unlimited: Owner, Admin, Viewer (ADR-140) | 1 | Up to 10 | Unlimited |
| Unified multi-cluster view: All clusters and fleets (0.11.0, ADR-226) | — (upgrade page) | — (upgrade page) | ✓ | ✓ |
| Network devices: switches, routers, the map, ports and links (0.16.0, §4.17, ADR-233); Wi-Fi (CAPsMAN), a NAS and iSCSI, recorders ("is it recording?") and UPSes (0.17.0, ADR-234); a device is one unit, controller-managed Wi-Fi access points free | — (teaser) | — (teaser) | ✓ | ✓ (licence feature `network`) |
| SLO / availability reports | — | — | ✓ (Phase 6) | ✓ |
| Anomaly detection — basic: What changed and anomaly alerts (0.8.0, ADR-195) | — (upgrade page) | — (upgrade page) | ✓ | ✓ |
| Anomaly detection — advanced (correlation & root-cause hints) | — | — | — | ✓ |
| SSO (OIDC/SAML), LDAP | — | — | — | ✓ |
| RBAC (per-cluster / per-namespace roles) | — | — | — | ✓ |
| Audit log | — | — | — | ✓ |
| Air-gapped install, offline license | — | — | — | ✓ |
| Support | GitHub issues, community chat | Community | Email (2 business days) | SLA + dedicated channel |

Rows marked (Phase 6) are not in 0.6.0: Cloud pages and the site say "coming to Pro" for them (ADR-173). The unified multi-cluster view shipped in 0.11.0 as All clusters and fleets (ADR-226), with the same editions as What changed. Basic anomaly detection shipped in 0.8.0 as What changed (§4.8, ADR-195): Pro and Enterprise in Cloud, and the live demo (ADR-203); Cloud Free and Community see an upgrade page in its place (ADR-201). Self-hosted Enterprise gets every Pro feature with an offline licence key since 0.15.0 (ADR-232, `docs/site/license.md`): one check, `proFeatures(config, license, orgId)`, for every Pro gate; units (Kubernetes nodes plus servers, the highest daily count of 7 days) with a 30-day rule over the limit; 30 days' notice and 14 days of grace. Cloud limits and how they answer (409 `plan-limit`, 402 on ingest for new nodes only): ADR-177.

**Why anomaly detection is paid:** it needs at least 7-14 days of history to learn weekly seasonality, which only the paid retention tiers provide, and it costs real compute per series.

## 3.3 Pricing rationale and billing

- **$3 per node (or server) per month** (ADR-215, the owner's decision of 2026-11-18, before billing went live; it replaces the $1 this section first set). It stays well below typical per-host SaaS pricing: the goal is still to make "just use Cloud" cheaper than the time spent maintaining a self-hosted stack. A Linux server counts as one node, whatever runs on it (§4.15).
- **Minimum $15 / month**, which covers the first 5 nodes: the number Cloud Free allows, so Pro's smallest bill starts where Free ends. Without a minimum, Stripe's fixed per-transaction fee would eat a large share of very small invoices. **Decided (ADR-178, amounts by ADR-215):** a graduated metered price, the first 5 nodes a flat $15, then $3 per node.
- **Annual plan:** 2 months free (pay for 10, get 12): a committed node count at $30 per node a year ($2.50 a month), minimum 5, with nodes above it billed monthly at $3 (ADR-178, ADR-215).
- **Billable nodes** = the 95th percentile of hourly node counts in the billing period, so autoscaling spikes do not inflate the bill.
- **Billing provider: Stripe** (Stripe Checkout + Billing + Customer Portal, usage-based price reported daily via Stripe usage records/meters). Invoices, tax and card management stay in Stripe; WatchLog stores only the Stripe customer and subscription IDs. Billing is a separate service in the private Cloud repository behind a provider interface; it writes the org's entitlements through an internal API, and the product never talks to Stripe (ADR-178). Built and tested on Stripe's test mode and stripe-mock; live once the payment entity exists (§16).
- **Enterprise:** custom annual contracts, invoiced through Stripe.

## 3.4 Licensing and repository layout

- Everything outside `ee/` is **AGPL-3.0**. This lets anyone self-host and modify, but prevents a third party from reselling WatchLog as a closed hosted service.
- `ee/` contains Enterprise-only code under a **commercial source-available license** (same model as GitLab; `ee/LICENSE`). Enterprise features MUST be implemented as modules that the core loads only when a valid license key is present. The core MUST build and run with `ee/` deleted.
- **How `ee/` is loaded and checked (0.15.0, ADR-232):** `ee/backend` (TypeScript modules, types from `backend/src/ee-contract.d.ts`) is found by `backend/src/ee.ts` at start-up and each module's routes sit behind its licence feature, read per request (404 unlicensed, 403 `license-ended` after the grace days); `ee/web` (Vue pages and sidebar items) by `import.meta.glob`, behind the same feature with the core's teaser otherwise; `ee/collector` (Go) is a separate module joined to the integrations collector by the `ee` build tag and a generated `go.work`, through the public `agent/ext` package; the collector holds no licence logic. Without `ee/` each of these finds nothing, silently. Files in `ee/` carry `SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise` and only there (`pnpm check:license`); CI's "core without ee" job deletes `ee/` and builds and tests the backend, web, agent and collector.
- Cloud-only billing code lives in a separate **private** repository, never in the public monorepo.
- Contributors sign a lightweight CLA (via CLA Assistant) so dual licensing stays possible.


# 4. Feature specification

Priority labels: **P0** = MVP / launch, **P1** = shortly after launch, **P2** = later. Edition is Community (C), Cloud Free (CF), Pro (P), Enterprise (E). "All" = every edition.

**Kubernetes and Docker (standing rule, ADR-124):** every feature ships for both Kubernetes clusters and Docker fleets in the same release, with each side's vocabulary (Kubernetes: namespaces, workloads, pods; Docker: hosts, Compose projects, containers), and is tested and documented for both. Only an ADR that explains why one side cannot have a feature makes an exception. Docker is a first-class target.

## 4.1 Cluster overview (home screen) — P0, All

The first screen after login. Answers "is anything wrong right now?" in 5 seconds.

- Health banner: **Healthy / Degraded / Critical**, computed from firing alerts.
- Tiles: nodes (ready / total), pods (running / pending / failed), restarts last 1 h, firing alerts, cluster CPU % and memory % (requests vs usage vs allocatable).
- "Needs attention" list: the first 6 problems, worst first (critical before warning, then firing alerts before object problems, then oldest), and "+N more in Alerts" (CrashLoopBackOff pods, NotReady nodes, OOMKilled containers, pending pods > 5 min, PVCs > 85 % full; ADR-159). Under each, its probable cause (v0.4, ADR-148, ADR-156, ADR-159): a Likely or Possible chip and the sentence, wrapped, never cut; a No clear cause chip alone; no line under an agent that stopped reporting. A container its host's reboot or its Docker daemon's restart stopped, and that its restart policy left stopped, is no problem; a pod its node's reboot restarted is not crash-looping.
- Recent Kubernetes events (Warning only) with links to the affected object.
- **Running here (0.13.0, ADR-230):** under the tiles, three cards, the same on Kubernetes and Server fleets in each one's words: **Services** (count, how many have problems, the first three, problems first), **Certificates** (count and how many need a look, the next 90 days as a strip of dots with the 14-day band, the three soonest; on a fleet "nginx :443 on app-1"; a failing renewal job on the certificate's row, "certbot.timer is failing") and **Scheduled jobs** (count and how many need a look, the three that need it first, then by next run, each with its last 12 runs as bars and an accessible summary; "systemd timer on worker-1", "cron on db-1 · 0 4 * * *"). Each card's header opens its page, its footer says one fact ("All 12 certificates · 10 renew themselves", "All 9 jobs · 240 of 340 runs fine in 24 h"). Skeletons while loading; an empty card says how they are found; agents older than 0.10 are named with a link to the update dialog. Three columns while each gets 300 px, else stacked. It replaces 0.10's certificates-and-jobs card on the Overview (a server's page keeps it).
- **First find (0.13.0, ADR-230):** once per user and per cluster or fleet, the first time either list isn't empty: "WatchLog found 12 certificates and 9 scheduled jobs on its own", what it watches for in the platform's words, the most urgent item, "See certificates", "See scheduled jobs" and ×. Any of the three hides it for good (`users.notices`); never in the read-only demo or for an API token (`GET /clusters/:id/first-find`, `POST …/first-find/dismiss`).
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
- **Right-sizing hints (v0.5, shipped in 0.5.0; ADR-168):** requests and limits compared with the last 7 days of use (5-minute resolution; at least 24 hours of data), per workload container on Kubernetes and per container on Docker, in plain sentences with no score: "web asks for 500m CPU; its busiest pod used at most 60m (p95) over 7 days. About 80m would cover it."
  - **Kubernetes:** CPU request ≥ 2 × p95 use (and ≥ 100m spare) or below p95 use; memory request ≥ 2 × the peak working set (and ≥ 128 MiB spare) or below its p95; memory limit within 10 % of the peak or an OOM kill in the window ("OOM risk"); CPU limit throttling ≥ 10 % of the time at p95; no request or no memory limit set.
  - **Docker** (limits reserve nothing, so no "too high" hint on a limit): memory limit within 10 % of the peak or an OOM kill, CPU limit throttling, a memory reservation too high or too low when set, no memory limit while it used more than a quarter of the host's memory.
  - Jobs and CronJobs are left out. Suggestions round up (CPU p95 × 1.25 to 10m, memory peak × 1.25 to 16 MiB).
  - **Where:** a card on the workload, Docker container and Compose service pages; the overview's card (count and the first three, OOM risk first); `GET /clusters/:id/right-sizing`; MCP `get_right_sizing`. Kept an hour per cluster. Hints are not alerts.
- **Container logs on demand (v0.5, shipped in 0.5.0; ADR-167):** the last N lines of one container (200 by default, up to 1,000; each line cut at 2 KB, 512 KB per answer), optionally followed for up to 5 minutes, streamed through the backend and **never stored** (no database, no metrics store, no agent buffer, no request log). Not log management (§2.5): no search, filter, history or retention.
  - **Kubernetes:** the cluster-agent reads the pod's log through the API server (`pods/log` `get`; the container's previous run too). **Docker:** the host's agent reads `/containers/{id}/logs` (allow-listed, ADR-024), stdout and stderr marked.
  - Lines are redacted in the agent, as ADR-047 does, before they leave the cluster or host; control characters and escapes are stripped (ADR-129).
  - The request reaches the agent through a long-poll it already holds open (`/ingest/v1/logs/requests`); the backend never connects into a cluster (§5.2).
  - **Who:** every role, Viewers included, unless an Owner or Admin limits it to Owners and Admins or turns it off in Settings; `logs.enabled` (charts) and `WATCHLOG_LOGS` (Docker agent), default on, turn it off for the installation. Every read is audited without its lines. 30 reads a minute and 3 follows per user.
  - **Where:** a Logs tab on the pod page (container picker, "previous run") and the Docker container page; `GET …/logs` (§8.1); MCP `get_container_logs` (at most 200 lines, 16 KB).

## 4.4 Docker hosts — P0, All (part of Servers, §4.15, from 0.9.0)

From 0.9.0 a Docker fleet is a Server fleet and Docker is one source of workloads on a server (ADR-207); what follows still holds for its containers.

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
- **v0.3:** HTTP-level stats (method, status code, latency) for plain-text HTTP/1.x, from the first bytes of each message on traced connections; no paths or bodies; TLS payloads are never decrypted (ADR-139).
- Fallback when eBPF is unavailable: map built from Kubernetes Services/Endpoints only, clearly labelled "topology only, no traffic data".
- **v0.7 (shipped in 0.7.0):** the external destinations over time, with first seen, new-destination alerts and expected destinations, are Egress watch (§4.14, ADR-184).

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
| Container CPU throttling (Kubernetes and Docker) | throttled > 25 % of the time for 15 min (throttled seconds a second, at most 100 %; ADR-160) | warning |
| Docker container unhealthy / restarting | health = unhealthy or > 3 restarts in 10 min | warning |
| Service-to-service failed connections | > 5 % of connections fail for 5 min | warning |
| Agent not reporting | no heartbeat for 3 min; one alert for the whole cluster when all its agents are silent | critical |
| New external destination (v0.7, shipped in 0.7.0; Kubernetes and Docker) | a source talks to a destination it never used and no expectation covers; quiet for a 7-day learning period (ADR-187, §4.14) | warning |
| Raw IP egress (v0.7, shipped in 0.7.0) | ≥ 5 connections in 10 min to the same public network and port with no DNS name (ADR-187) | warning |
| Large upload to a new destination (v0.7, shipped in 0.7.0) | > 100 MB sent in 1 h to a destination first seen in the last 24 h (ADR-187) | warning |
| Certificate expiring (v0.10; Kubernetes and Servers) | 14 days left (warning), 3 days (critical), expired (critical); one alert per certificate endpoint, resolved by a new certificate (ADR-225, §4.16) | warning / critical |
| Certificate name or chain wrong (v0.10) | the name asked for doesn't match, or the chain is incomplete (ADR-225) | warning |
| Scheduled job failed (v0.10; timers, cron, CronJobs) | the last run failed (warning); 3 in a row (critical); a job every minute alerts on 3 in a row only (ADR-225) | warning / critical |
| Scheduled job missed (v0.10) | a run expected and nothing started, the server and agent up (ADR-223, ADR-225) | warning |
| Scheduled job slow (v0.10) | running or ran far longer than its usual duration, after 5 runs (ADR-225) | warning |
| Unusual for this hour (shipped in 0.8.0; Pro and the live demo only; Kubernetes and Docker) | a catalog series' score against its hour-of-week baseline over 4 for 10 min; quiet 30 min after a rollout of the subject; one alert per subject and metric (ADR-200, §4.8) | warning |

**Custom threshold rules:** pick metric → scope (cluster / namespace / workload / node / label selector) → condition → duration → severity → channels. No PromQL required. P1: advanced mode with raw MetricsQL.

**Channels (P0):** Slack webhook, Telegram bot, Email (SMTP / provider), generic Webhook (JSON). **P1:** Microsoft Teams, Discord, PagerDuty, Opsgenie.

**Behaviour:** grouping (one message per rule+scope), resolve notifications, re-notify interval (default 4 h), silences with expiry, maintenance windows (P1), routing by severity/namespace (P1). Alert messages are short and actionable: what, where, since when, link.

**The likely cause in messages (v0.4, ADR-148, ADR-157):** when an alert fires, its probable cause is worked out once, within 2 s, just before the firing message is sent, and kept with the alert. A likely cause adds one line under the facts in Slack, Telegram and email ("Likely cause: web fails because api was scaled to 0: nothing answers its calls.") and `likelyCause` to the webhook's alert (`{rule, code, facts, since, headline, subject, text, chain}`); possible causes, no clear cause and an answer not ready in 2 s add nothing, and the message is never held back longer. The resolve message says "Was likely: …" from the answer kept at fire time. The alert's timeline marks the messages that carried it. The alert worker reads the API in-process as a viewer of the alert's organization; the headline's English comes from `@watchlog/cause-words`, which the dashboard uses too.

**Silent clusters and held alerts (ADR-094):** when every agent of a cluster is silent, one "stopped reporting" alert is raised for the cluster instead of one per agent. The cluster's other alerts, and pod alerts on NotReady nodes, are held: neither notified nor resolved while their state is unknown, shown as "held back", and released when data returns.

**Server settings (ADR-093):** the public address, the email server (SMTP, password encrypted and write-only) and Telegram's HTTPS proxy are set in Settings and stored in the database. An environment variable, when set, overrides the stored value and the UI shows it read-only as set by the server's environment.

## 4.8 Anomaly detection ("What changed") — Pro (basic, shipped in 0.8.0) / Enterprise (advanced)

**Goal:** alerts with zero configuration. Sold as "we notice what is abnormal for *your* cluster", not as "AI".

**Basic (Pro): "What changed", shipped in 0.8.0 (ADR-195 to ADR-204; the user page is `docs/site/what-changed.md`).** "See what changed first in every Kubernetes and Docker incident." Each metric in WatchLog's catalog learns its own normal week; when something breaks, one list shows everything that left its range, in the order it happened, with the probable cause underneath. Statistics only, worked out inside WatchLog: nothing is sent to an AI, and the same data always gives the same answer.

- **Editions (ADR-195):** Cloud Pro and Cloud Enterprise (the org's `pro_features` entitlement, ADR-177, which follows the plan since 0.8.1, ADR-205), including the Pro beta; the live demo through a demo-only entitlement (ADR-203). Cloud Free and Community never run the anomaly-worker and never get the data: the "What changed" entry opens an upgrade page (ADR-201). Community is otherwise unchanged: no new process or load. Kubernetes and Docker both, each in its own vocabulary (ADR-124).
- **Which series (ADR-196):** the curated catalog keys (ADR-028) for workloads, pods, nodes, Docker hosts, containers, Compose services and applications (§4.12), plus the service map's HTTP and connection series. Never raw MetricsQL or unbounded label sets. The scored keys were chosen by measuring (ADR-196 as built): nodes, workloads, Docker hosts and containers, three new per-workload HTTP keys (requests, errors, p95), the map's edges and the integrations' behaviour keys; pods (they churn) and flat or event-like keys that a default rule covers are left out. About 113 series a Kubernetes node and 303 a Docker host.
- **Baselines (ADR-196):** per series, per **hour of the week** (168 UTC buckets), the **median and MAD** of the one-minute values over the last **14 days**; a series is used once it has **7 days** of data. Minutes when another alert was firing on the subject (or its workload or Compose service) are left out, so incidents don't become normal.
- **Score:** `|value − median| / max(1.4826 × MAD, floor)`, with a floor on the spread chosen per metric kind from measured spreads, so a flat series doesn't make every wobble infinite. **Unusual:** a score over **4 for 10 consecutive minutes**. The usual range shown is the median ± 2 spreads. 4 and 10 are fixed in 0.8.0; no sensitivity setting yet.
- **The What changed page (ADR-199):** windows around an alert, the last hour, the last 6 hours or a custom range (at most 24 hours); the unusual-activity chart with the window marked; ranked rows (when it started, what, usual → now) by "first to move" or "furthest out"; the probable-cause card (§4.13) underneath. On every alert detail, a "What changed around it" card with the first three rows (Cloud Free: a locked line to the upgrade page).
- **After the learning week (0.14.0, ADR-231):** the page reads top-down: a live line ("Watching 251 series · checked 12 s ago") and "Hide WatchLog's own parts" (on by default, per browser); a **live map** of every scored series as a square (inside in three shades, near the edge, outside; grouped by workload or by server and its services; polled each minute, `GET /what-changed/live`); the selected **episode** as one sentence from fixed templates, a cause box (probable cause's likely cause, else the change linked by rule, else "No clear cause" naming the checks), and a switcher; **how it spread** (the linked change, then each series with the minutes between, arrows only along service-map calls or a shared node or server); **what moved** with band sparklines and "14× usual" chips; **why** (every check, changed around then, the evidence buttons); the chart last, with episodes and change markers. When everything is inside, the last 7 days' episodes (`GET /what-changed/recent`). Kubernetes and Server fleets each in their own words, with scheduled runs and service restarts among a fleet's changes.
- **Anomaly alerts (ADR-200):** a default rule, "Unusual for this hour", warning, on for Pro; quiet for 30 minutes after a rollout of the same subject (Docker: a re-created container, an image or Compose change); one alert per subject and metric; messages say "usual for <weekday> <hour> UTC: X–Y; now Z" and add the likely cause when there is one (§4.7). "Was this worth an alert?": "normal for us" (Owners and Admins, audited) widens that series' range for that hour. No anomaly alert opens while another alert fires on the same subject; `WATCHLOG_ANOMALY_ALERT_KEYS` (alert worker) chooses which keys may alert (default all but the map's edges). Aimed at fewer than 3 a day per cluster: the demo's hourly chaos raises none (ADR-200 as built). Maintenance windows aren't built (§4.7).
- **API and MCP (ADR-202):** `GET /api/v1/what-changed?cluster=…&from=…&to=…` or `…&alert=…` (§8.1) and MCP `get_what_changed` (§4.11): read-only, bounded (50 rows, 30 through MCP, 24 hours), Pro-gated (403 `pro-feature` for Cloud Free; 404 and no tool in Community), in the isolation suite (ADR-182).
- **Upgrades (ADR-204):** no manual step. Learning starts at the upgrade (or the switch to Pro), never from older history; until 7 days have passed nothing is listed and nothing alerts. The live demo is the one exception: in demo mode the worker learns from the history the demo keeps at its first start, so the demo's page has rows the day it is deployed (ADR-203).
- **Ready after 7 days of data (0.9.6, ADR-217):** one rule, shared by the worker's scoring and everything that reports it. A cluster is ready when every hour of the week is learned (or was looked at twice with no data), and not before 7 days after its first series; a series is scored when the worker has recomputed every hour of the week since it was first seen. Without a gap that is exactly 7 days. Hours when the org was not on Pro, the worker was down or no data arrived are learned when they come round; after a return within 30 days what was learned before still counts, and the page says when learning resumed.
- **The learning week (0.9.4, ADR-216):** for those 7 days the page shows what is happening instead of the list: "Learning · day N of 7", the ready date and time in the viewer's time zone, the series watched in the kind's words, and the 7 × 24 hours of the week (learned, this hour, not seen yet) from the baselines that exist. A member can ask for one email when it is ready. Afterwards a strip says how many series that joined later still learn. The alert card, the sidebar ("day 3/7"), the API and the MCP tool say the same in small. On the upgrade page (ADR-201) the same centrepiece waits, labelled "Not learning yet", with the date it would be ready if the org upgraded today; Community gets no date. Learning itself is unchanged.

**Advanced (Enterprise, P2):** correlate anomalies that start within the same 5-minute window and are connected on the service map; produce a "likely root cause" hint (earliest anomaly upstream in the graph). The 0.8.0 list is ordered by time only and draws no cause from that order (ADR-199).

**Implementation (ADR-197, ADR-198):** a separate `anomaly-worker` (§5.1), started only in Cloud or in demo mode. Every minute it scores the recent window of each series of Pro orgs' clusters and stores unusual periods in PostgreSQL; every hour it recomputes the hour-of-week bucket that just ended. The alert worker opens anomaly alerts from the stored periods through the existing pipeline. Baselines go to PostgreSQL rows (one row per series, two `real[168]` arrays) unless slice 1's measurements at 1,000 nodes choose VictoriaMetrics series. Its CPU, memory and storage are measured at the load test's 1,000 nodes; if it doesn't fit the current server, the catalog it scores shrinks first.

## 4.9 SLO / availability reports — P1, Pro+

- Define an SLO on a workload: availability (ready replicas ≥ desired) or service-map edge success rate / latency.
- Monthly report: SLO %, error budget remaining, incidents list. Export as PDF (P2).

## 4.10 Organisation features

| Feature | Priority | Edition |
|---|---|---|
| Organisations, invite users by email | P0 | Cloud |
| Invite users by email into the installation | v0.3 | All (ADR-140) |
| Several clusters and Docker fleets in one installation, cluster switcher | v0.4 | All (ADR-151) |
| Unified "all clusters" overview: All clusters and fleets (ADR-226) | v0.11 | Pro, E |
| Roles: Owner, Admin, Viewer | v0.3 | All (ADR-140) |
| Fine-grained RBAC (per cluster / namespace) | P2 | E |
| SSO (OIDC, SAML), LDAP | P2 | E |
| Audit log (who changed which rule, who silenced what) | P2 | E |
| API tokens for automation (§4.11) | v0.2 | All |

## 4.11 API tokens and AI assistants (MCP) — v0.2, All

Let people ask their own AI assistant about their cluster ("why is payments-api crash-looping?"). WatchLog supplies facts; the assistant does the talking. No LLM runs in WatchLog.

- **Personal API tokens (ADR-125):**
  - `wl_pat_` + 256 random bits, stored as SHA-256, shown once;
  - scope `read` only: an allowlist of the routes tagged `public` (ADR-126), plus `/mcp`; every other route answers 403 `token-scope`;
  - expiry chosen at creation (default 90 days, "never" allowed);
  - revocable at once, with the last-used time and IP;
  - at most 10 active per user; 300 REST requests and 60 MCP tool calls a minute per token;
  - a token history on each row (created, revoked, expired, first use from a new IP);
  - created and revoked in Settings → API tokens;
  - refused in demo mode.
- **Public REST API (ADR-126):** the routes tagged `public` (24 reads, `POST /query/range` among them) are stable under `/api/v1`, for Kubernetes clusters and Docker fleets.
  - `/api/v1/openapi.json` serves only them, with a `bearerAuth` scheme, and needs no token.
  - A committed snapshot (`packages/api-types/openapi.public.json`) must match the served spec. A test names any breaking change; `pnpm -C backend openapi:snapshot` writes additions and refuses a breaking change without `--breaking`.
  - Additions are allowed at any time. A breaking change needs `/api/v2` or two minor versions of deprecation.
  - Docs: `docs/site/api.md`, with examples for both kinds of cluster.
- **MCP server (ADR-127):**
  - `POST /mcp` in the backend, Streamable HTTP, a read token in the `Authorization` header;
  - the official MCP TypeScript SDK (v2: `@modelcontextprotocol/server`), serving the 2026-07-28 protocol and, through its stateless fallback, clients still on the 2025 versions;
  - stateless;
  - tools read through the public REST API in-process, as the same token: never more than the API shows it;
  - 60 tool calls a minute per token; `/mcp` requests also count toward the token's 300 requests a minute;
  - `mcp.enabled` in Helm and Compose, default on;
  - every call logged with the tool, a short argument summary, the status, the duration and the size, never the output; kept 30 days, the last 50 shown per token;
  - OAuth for native "custom connectors" in a later version.
- **Tools (ADR-128), read-only, for Kubernetes and Docker alike:** each takes a cluster and returns its kind with that kind's vocabulary.

  | Tool | Kubernetes | Docker |
  |---|---|---|
  | `list_clusters` | clusters with health, nodes, eBPF | fleets with hosts |
  | `get_problems` | Needs attention: workloads and pods with reasons, worst first (critical first, then firing alerts; ADR-159); each with its `subject` for `explain_problem` and, when one cause is likely, its `likelyCause` (v0.4, ADR-148) | containers that are unhealthy, restarting, OOM-killed or exited non-zero (not those their host's or daemon's restart stopped), firing alerts; the same `subject` and `likelyCause` |
  | `list_alerts` | firing or recent alerts | the same |
  | `explain_alert` | the alert, its rule, its `causes` (v0.4, ADR-148: the evidence of `GET /causes`), the object's state, last terminations, events and changes before it | the same for containers and hosts |
  | `explain_problem` (v0.4) | the probable cause of a workload, pod, edge, application or alert: `state`, `headline`, ranked `causes` with each rule's meaning and its evidence chain, `checks`, `flowsOff` (ADR-148, ADR-155) | the same for a container or Compose service |
  | `get_workload` | replicas, images, restarts, terminations, use vs requests and limits | a Compose service: its containers, the same facts |
  | `get_pod` | containers, states, exit codes, OOM, conditions, events | a container |
  | `get_node` | conditions, capacity vs use, top pods | a host |
  | `get_service_map` | edges of a workload or the failing edges, DNS errors | the same between containers |
  | `get_events` | grouped warning events, at most 24 h | container die / OOM / restart / health events |
  | `get_recent_changes` | rollouts, image changes, scaling, nodes | container re-creations and image changes |
  | `query_metric` | catalog keys only, at most 24 h, 10 series, 60 points; statistics by default | the Docker catalog keys |
  | `get_container_logs` (v0.5) | a pod container's last lines (at most 200, 16 KB; `previous` for the last run), redacted, never stored; cluster-controlled data (ADR-129, ADR-167) | a container's last lines, with their stream |
  | `get_right_sizing` (v0.5) | right-sizing hints for a namespace or workload: codes and facts, what each is based on, the suggestion (ADR-168) | the same for a host, Compose service or container |
  | `get_egress` (v0.7) | a cluster's or a workload's external destinations with first and last seen, traffic and badges; at most 50 rows, up to 30 days (ADR-189, §4.14) | the same for a host, Compose service or container |
  | `get_new_destinations` (v0.7) | destinations first used by a source in the last N hours (default 24, at most 168), names and public networks only; at most 30 rows | the same |
  | `get_expected_destinations` (v0.7) | the expected destinations and patterns, their source and port, who marked them, the rows each covers (ADR-186); at most 50 | the same |
  | `get_what_changed` (0.8.0; Pro only, not registered in Community) | what left its usual range in a window or around an alert, first to move or furthest out, with the probable cause; at most 30 rows, 24 hours (ADR-202, §4.8) | the same for hosts, Compose services and containers |

  Prompts: `investigate_problem`, `why_is_it_crashing`.
- **Caps:** every tool has a maximum number of items and at most 16 KB of output. Beyond it the result says `truncated`, how many more, and which argument narrows the query.
- **Safety:**
  - never Secrets, env values, payloads, channel targets, SMTP or Telegram settings, or tokens;
  - cluster-controlled text (names, labels, messages) only in delimited data fields, capped and stripped of control characters, never inside WatchLog's own sentences (ADR-129);
  - read-only scope bounds the effect of prompt injection.
- **Live demo (ADR-130):** a public read token for demo.watchlog.io: 30 tool calls a minute per visitor and 600 in total, plus the demo's query caps.
- **Docs:** `docs/site/mcp.md` with setup for Claude Code (`claude mcp add --transport http … --header`), Claude Desktop (`mcp-remote`) and Cursor, examples for a Kubernetes cluster and a Docker fleet, and the security notes. The site's "Ask your cluster" section stays behind a flag.

- **Probable cause (v0.4, ADR-148, ADR-155):** the answers carry codes and facts, as `GET /causes` does, plus each rule's meaning in a sentence without names; no rendered English sentence. Tool descriptions say the causes come from fixed rules over collected data, with no score.
- **End to end:** `deploy/test/k8s/mcp-e2e.sh` drives the SDK client (both protocol generations), Claude Desktop's `mcp-remote` path, Claude Code and Cursor when its CLI is there, against the kind demo and a Docker host (`deploy/test/demo-up.sh`). `deploy/test/causes-e2e.sh mcp` asserts `explain_problem`, `get_problems.likelyCause` and `explain_alert.causes` against every probable-cause scenario on both.

**Accept when:**
- on the kind demo, Claude Code connected through MCP correctly explains the crash-looping and OOM pods from WatchLog data alone; the same works on a Docker host for an OOM-killed and a restarting container;
- revoking the token stops access at the next call;
- the protocol works with Claude Code, Claude Desktop through `mcp-remote`, Cursor where it can be scripted, and the SDK's own client.

## 4.12 Applications (service integrations) and multi-user — v0.3, All (wave 2 shipped in 0.5.0)

(v0.10: Applications has three tabs, Services (this section), Certificates and Scheduled jobs (§4.16, ADR-221).)

Monitor the services people run next to their workloads (databases, caches, queues, proxies) with the same quality as the rest of WatchLog. Services are discovered automatically and get opinionated pages, default alerts and plain-language reasons. These are service metrics, not APM: no code instrumentation, no tracing, never table data (SPEC §2.5). Community edition: monitoring is never paywalled (§3.1). Decisions: ADR-131 to ADR-145; wave 2 (v0.5): ADR-162 to ADR-166.

**Architecture:**
- **The collector:** a separate `integrations` collector, one per Kubernetes cluster and one per Docker host that runs a monitored service. It pushes like the agents and pulls its targets from the backend. The node agent stays small and never reads secrets (ADR-131).
- **Discovery:** from images, container and Service ports, and eBPF flows the agents already report. "Found N services that aren't monitored yet" with Monitor, Ignore and Add manually. Nothing is contacted before Monitor (ADR-132). A pod or container that runs a server's image only as a client (it connects out on the type's port, nothing connects to it there, and it declares or publishes no such port) isn't offered (ADR-172).
- **Connecting:** services that need nothing start at once. Those that need a read-only user offer three ways: a generated user and the one-time command, an existing user (its privileges checked), or the user's own Secret or file (ADR-134). Stored credentials are AES-256-GCM encrypted, write-only, and sent only to that cluster's collector (ADR-133).
- **Pages:**
  - Applications is a list with problems first and filters by type.
  - One service-page template: header, "What WatchLog sees", stat tiles, tabs by metric family, a panel grid, "Alerts for this service", the connected workloads from the service map, and the MCP hint.
  - Eight shared panel types: line with limit, stacked area, horizontal bars, histogram, capacity gauge, hour × day heatmap, table, stat tiles (ADR-135).
- **Metrics:** catalog keys with per-instance caps. Any of them can be used in a rule with a "service" scope, and each integration ships default rules (ADR-136).
- **Reasons:** structured facts with links to workloads, containers and edges, the inputs to v0.4's probable cause. They are returned by MCP `list_applications` and `get_application` and by `GET /applications` (ADR-137).
- **Query text:** normalised only, with a per-service switch (ADR-138).
- **HTTP stats on the service map:** from eBPF, plain HTTP/1.x, method, status and latency only (ADR-139).
- **The landing site's "Applications" section** stays behind a site flag until 0.3.0 ships.

**An integration is done when it has:**
1. discovery;
2. the full tabbed page;
3. default alerts;
4. reasons;
5. an MCP view through `get_application`;
6. install docs (`docs/site/integrations/<service>.md`);
7. the landing entry;
8. tests against the real service on Kubernetes **and** Docker (ADR-124), the generated setup command included.

**Order:** foundation → multi-user → Redis → PostgreSQL → eBPF HTTP + Nginx → RabbitMQ (v0.3, ADR-141). **v0.5.0, before the launch (ADR-162):** MySQL / MariaDB → MongoDB → Traefik → Kafka. Elasticsearch and MinIO come after the launch, in the order users ask; Elasticsearch's catalog stays below.

**Panel types:** L line with limit line · SA stacked area · HB horizontal bars · H histogram · G capacity gauge · HM hour × day heatmap · T table · S stat tiles.

**Not collectable as the mock-up implies:** each catalog below flags (⚑) where a metric can't come from the named source, with the closest alternative.

The catalog follows the owner's mock-up (`design/v0.3-integrations/Main.dc.html`, its `data()`): tabs and panels per service, each with its real source.

### Redis (INFO, CONFIG GET, MEMORY STATS, SLOWLOG, LATENCY, CLIENT LIST)

Access: nothing without a password; otherwise the password or a small ACL user (`+info +slowlog +latency +config|get +client|list +memory|stats +memory|usage +scan +ping`).

| Tab | Panels and sources |
|---|---|
| Overview | **S** memory / maxmemory, hit rate, commands/s (peak), clients (blocked), evicted keys 24 h, keys with the share that has a TTL (`INFO keyspace` keys, expires) · **L** `used_memory` vs `maxmemory` · **SA** hits and misses/s (`keyspace_hits`, `keyspace_misses`) · **T** slow log: command (normalised, ADR-138), duration, client workload (the entry's client address via the IP map), when |
| Memory | **SA** dataset, overhead, fragmentation (`MEMORY STATS` `dataset.bytes`, `overhead.total`; `used_memory_rss` − `used_memory`) · **G** maxmemory with its policy; fragmentation ratio (healthy below 1.5) · **HB** biggest key prefixes. ⚑ Redis has no such statistic; closest: every 10 min, sample 2,000 keys with `SCAN` and `MEMORY USAGE`, group by the prefix before the first `:` or `{`, and extrapolate. Only prefixes are kept; values are never read. · **L** expired and evicted keys/s |
| Commands | **SA** calls/s by command (`INFO commandstats`, top 20) · **HB** slowest commands by mean (`usec_per_call`) · **H** command latency (`LATENCY HISTOGRAM`, Redis 7+). ⚑ Older versions have no histogram; the panel says so. |
| Clients | **L** connected and blocked clients · **HB** clients by workload (`CLIENT LIST` addresses via the IP map) · **G** clients vs `maxclients` |
| Persistence and replication | **S** last RDB save (status, age), AOF (off / status), replica state, changes since the last save · **L** replication offset lag in bytes. ⚑ Redis has no lag in seconds; closest: offset difference and the replica's ack age. |

- **Default rules:**
  - memory > 90 % of maxmemory for 5 min (warning);
  - keys are being evicted (warning);
  - replica disconnected (critical);
  - last RDB/AOF save failed (critical);
  - blocked clients for 2 min (warning).
- **Reasons:** `memory_near_max`, `evicting`, `no_maxmemory` (memory can grow to the container limit; linked to it), `slow_keys_command`, `replica_down`, `save_failed`, `clients_rejected`, `clients_blocked`.
- ⚑ **The connected-workloads card's ops/s per client:** commands per client aren't in `CLIENT LIST`; closest: eBPF bytes/s and connections per client workload.

### PostgreSQL (pg_stat_*, pg_locks, pg_ls_waldir, pg_stat_statements; versions 12+)

Access: a login role with `pg_monitor`. It reads statistics views and the WAL directory listing, never table data. `pg_stat_statements` is optional and unlocks the query tables.

| Tab | Panels and sources |
|---|---|
| Overview | **S** connections / max, transactions/s with commit %, cache hit, replication lag, database size with growth per day, longest query · **L** connections vs `max_connections` · **SA** commits and rollbacks/s (`pg_stat_database`) · **T** slowest queries by mean: mean, calls (1 h), total time (`pg_stat_statements`) · **HB** busiest databases by transactions/s · **G** capacity: connections vs `max_connections` (`superuser_reserved_connections` noted); data volume vs its capacity with days left at the 7-day growth. The capacity comes from the pod's PVC (kubelet volume stats). ⚑ On Docker, the data directory's volume has no capacity of its own; closest: the host filesystem that holds it, from the agent. |
| Connections | **SA** backends by state: active, idle, idle in transaction, waiting (`pg_stat_activity`) · **HB** by client: workload from `client_addr` via the IP map, or `application_name` for manual sessions · **G** limits: `max_connections`; idle-in-transaction count with `idle_in_transaction_session_timeout` · **L** new connections/s (`pg_stat_database.sessions`, 14+). ⚑ Older versions lack it; closest: the eBPF connection rate into 5432. |
| Queries | **SA** rows/s by operation (`tup_fetched`, `tup_inserted`, `tup_updated`, `tup_deleted`) · **H** query duration. ⚑ PostgreSQL keeps no per-execution histogram; closest: each statement's calls bucketed by its mean time, labelled "by statement mean". · **L** temporary files written (`temp_bytes`) · **T** top queries by total time: total, mean, rows per call |
| Locks and waits | **SA** what sessions wait on (`pg_stat_activity.wait_event_type`: Lock, LWLock, IO, Client) · **T** blocking right now: blocked and blocking queries, both clients' workloads and states, what is waited for, how long (`pg_blocking_pids()`, `pg_locks`, normalised text by `query_id`) · **HM** lock waits by hour and day · **L** deadlocks · **HB** most locked tables. ⚑ Waits aren't counted by PostgreSQL; closest: `pg_locks` sampled every 15 s, so very short waits are missed. |
| Replication | **L** replay lag per replica with the 30 s line (`pg_stat_replication`; on a replica `now() − pg_last_xact_replay_timestamp()`) · **T** replicas (state, sync, lag) · **G** WAL: `pg_wal` size vs `max_wal_size` (`pg_ls_waldir()`); replication slots active and inactive (`pg_replication_slots`) · **L** WAL generated (`pg_stat_wal.wal_bytes`, 14+; older: LSN difference) |
| Tables and storage | **HB** largest tables (`pg_total_relation_size`, top 100) · **HB** estimated bloat. ⚑ Exact bloat needs `pgstattuple`, which reads every page and is not run; closest: a statistics-based estimate from `pg_stats`, labelled "estimate". · **T** indexes never used (`pg_stat_user_indexes.idx_scan`, unchanged over 30 days of WatchLog's history). ⚑ Until 30 days of history exist, the table shows "no scans since statistics were reset on <date>". · **L** database size |
| Vacuum | **T** tables waiting for vacuum: dead rows and ratio, last autovacuum, a note (`pg_stat_user_tables`). ⚑ "autovacuum keeps getting cancelled" appears only in the server log; closest: "autovacuum isn't finishing" when dead rows rise for 24 h while `autovacuum_count` stays the same. · **L** dead rows of the top tables · **G** transaction ID age per database vs 2,000 M, with `autovacuum_freeze_max_age` noted |

- **Default rules:**
  - connections > 90 % of max for 5 min (warning);
  - a query runs longer than 5 min (critical; active backends, not autovacuum or walsenders);
  - replication lag > 30 s for 2 min (warning);
  - transaction ID age > 1,500 M (critical);
  - deadlocks detected (warning).
- **Reasons:** `connections_near_max` (with the workloads holding most), `long_query`, `idle_in_transaction`, `lock_waits` (the blocking client's workload), `deadlocks`, `replica_lag`, `slot_retains_wal`, `wraparound_risk`, `cache_hit_low`, `autovacuum_not_finishing`, `statements_unavailable` (hint).

### Nginx (ingress-nginx metrics; stub_status; eBPF HTTP)

Access:
- **ingress-nginx:** its metrics on :10254, read as they are (labels renamed where they'd collide, ADR-143). The controller serves them only with `--enable-metrics` (the chart's `controller.metrics.enabled`, off by default): until then requests, errors and latency come from eBPF and the page gives the one command (ADR-143).
- **Plain Nginx:** nothing for requests, errors and latency (eBPF, ADR-139). `stub_status` (one location block) adds the Connections tab.

| Tab | Panels and sources |
|---|---|
| Overview | **S** requests/s (peak), 5xx (15 min), p95 (p50), active connections (waiting), upstreams ready / total, bandwidth out · **SA** requests/s by status class (`nginx_ingress_controller_requests`, or eBPF) · **L** p50, p95, p99 · **HB** busiest upstreams |
| Errors | **L** 5xx by upstream · **HB** status codes in the last hour. ⚑ 499 is logged by Nginx but never sent, so only ingress-nginx's metrics have it; eBPF sees the codes on the wire. · **T** error bursts: periods where an upstream's 5xx rate was ≥ 5 % for ≥ 10 s, derived by WatchLog, with the upstream's rollouts ("during rollout") |
| Latency | **H** request duration (`nginx_ingress_controller_request_duration_seconds`, or eBPF) · **HB** slowest upstreams by p95 · **L** p95 by upstream. ⚑ For plain Nginx, latency is time to the first response byte as eBPF sees it, not `$request_time`. |
| Connections | **SA** waiting, reading, writing (`stub_status` or `nginx_ingress_controller_nginx_process_connections`) · **L** accepted vs dropped/s (accepts − handled) |

- ⚑ **Upstream health** is an NGINX Plus API. Closest: the backend Service's ready endpoints (Kubernetes) and eBPF connect failures (Docker).
- **Not collected:** request paths (ADR-139).
- **Default rules:**
  - 5xx > 5 % for 5 min (critical);
  - p95 > 1 s for 5 min (warning);
  - an upstream has no healthy endpoint (critical);
  - a certificate expires within 14 days (warning, ingress-nginx: `nginx_ingress_controller_ssl_expire_time_seconds`).
- ⚑ **Plain Nginx certificates:** TLS terminates inside Nginx and WatchLog doesn't read its files, so there is no expiry rule for plain Nginx.
- **Reasons:** `errors_high` (top upstream, linked to its workload's state and last rollout), `upstream_no_endpoints`, `latency_high`, `connections_dropped`, `certificate_expiring`, `stub_status_missing` and `ingress_metrics_off` (hints, with the snippet or command).

### RabbitMQ (rabbitmq_prometheus on 15692; versions 3.10+)

Access: nothing; the plugin ships with RabbitMQ. If it is off, the generated command enables it, with no restart.

| Tab | Panels and sources |
|---|---|
| Overview | **S** ready (with its rate), unacked, publish/s, deliver/s with its value before a drop, consumers (was), memory % of the high watermark · **L** queue depth: ready, unacked · **L** publish vs deliver · **T** queues: ready, consumers, rate (`/metrics/detailed` families `queue_coarse_metrics` and `queue_consumer_count`, top 200) |
| Queues | **HB** depth by queue · **HB** consumers by queue · **L** ready messages of the top queues |
| Message rates | **SA** publish, deliver, redeliver, ack/s (`rabbitmq_global_messages_*_total`) · **L** publisher confirms/s (`rabbitmq_global_messages_confirmed_total`) |
| Resources | **G** node limits: memory vs the high watermark (`rabbitmq_process_resident_memory_bytes`, `rabbitmq_resident_memory_limit_bytes`), free disk vs the alarm limit, file descriptors, Erlang processes (`rabbitmq_erlang_processes_used`/`_limit`) · **L** memory with the watermark |

- **Default rules:**
  - a queue grows with no consumers for 5 min (critical);
  - memory or disk alarm (critical);
  - unacked messages > 10,000 (warning);
  - a node is down (critical);
  - a dead-letter queue is growing (warning).
- ⚑ **Dead-letter counters** exist only on 3.12+ (`rabbitmq_global_messages_dead_lettered_*`). Closest on older versions: queues named `*dead*letter*`, `*.dlq` or `*.dlx` that grow.
- ⚑ **Network partitions** aren't exported by the plugin. Closest: a member whose endpoint stops answering.
- **Reasons:** `queue_no_consumers` (linked to the workloads or containers that were connected to RabbitMQ in the last 24 h, from eBPF flows, and ended since, closest to when the queue lost its consumers: the plugin doesn't say which client consumed which queue; ADR-145), `queue_growing`, `memory_alarm` and `disk_alarm` (publishers blocked), `unacked_high`, `dead_letters_growing`, `prometheus_plugin_off` (with the command per node). A node down is a member down, as for every service.

### MySQL and MariaDB (status variables, performance_schema, InnoDB tables; MySQL 8.0+, MariaDB 10.6+) — v0.5 (shipped in 0.5.0; ADR-163)

Access: a user with `PROCESS` (required), `REPLICATION CLIENT` (MariaDB: and `SLAVE MONITOR`), `SELECT` on `performance_schema.*` and `SELECT` on `mysql.innodb_table_stats`, at most 2 connections; each missing optional privilege costs the panels it names. It reads statistics, never table data. The session is read-only with a 5 s statement limit. One type for both servers, named by `version_comment`.

| Tab | Panels and sources |
|---|---|
| Overview | **S** connections / max (`Threads_connected`, `max_connections`), queries/s (`Questions`), slow queries/s (`Slow_queries`), buffer pool hit (`Innodb_buffer_pool_read_requests` vs `Innodb_buffer_pool_reads`), replication lag, longest running query (process list `TIME`) · **L** connections vs `max_connections` · **SA** statements/s by type (`Com_select`, `Com_insert`, `Com_update`, `Com_delete`, other) · **T** slowest statements by mean: digest text, mean, calls (1 h), total (`events_statements_summary_by_digest`) |
| Connections | **SA** threads connected and running (`Threads_connected`, `Threads_running`) · **HB** by client: workload from the process list's host via the IP map, or the user for manual sessions · **G** `max_connections` with `Max_used_connections` · **L** aborted and refused connections/s (`Aborted_connects`, `Connection_errors_max_connections`) |
| Queries | **SA** rows/s by operation (`Innodb_rows_read`, `_inserted`, `_updated`, `_deleted`) · **H** statement latency (`events_statements_histogram_global`, MySQL 8.0.19+). ⚑ MariaDB has no histogram; closest: statements bucketed by their mean, labelled "by statement mean". · **L** temporary tables on disk and full scans/s (`Created_tmp_disk_tables`, `Select_scan`) · **T** top statements by total time: total, mean, rows examined per call |
| Locks | **L** row lock waits/s and time (`Innodb_row_lock_waits`, `Innodb_row_lock_time`) · **T** blocking right now: waiting and blocking sessions, both clients' workloads, the table, how long (`performance_schema.data_lock_waits` on MySQL, `information_schema.INNODB_LOCK_WAITS` on MariaDB, with `INNODB_TRX` and the process list) · **L** deadlocks (`INNODB_METRICS` `lock_deadlocks` on MySQL, `Innodb_deadlocks` on MariaDB) |
| InnoDB and storage | **G** buffer pool: pages with data and dirty vs total (`Innodb_buffer_pool_pages_*`) · **L** buffer pool reads from disk/s · **L** redo written/s (`Innodb_os_log_written`) · **HB** largest tables (`mysql.innodb_table_stats`: clustered and other index pages × page size). ⚑ These are InnoDB's persistent statistics, refreshed by automatic recalculation or `ANALYZE TABLE`; exact sizes need privileges on the tables themselves; labelled "estimate". |
| Replication | **S** IO and SQL threads running, last error (redacted) · **L** lag (`SHOW REPLICA STATUS` `Seconds_Behind_Source`; MariaDB's and older servers' `Seconds_Behind_Master`) with the 30 s line. ⚑ A source lists its replicas (`SHOW REPLICAS`) without their lag; each replica is monitored on its own. |

- ⚑ **MariaDB's performance_schema is off by default:** without it the statement tables, the histogram and MySQL's lock tables are empty, and the page shows the one setting (`performance_schema=ON`, a restart). Lock waits still come from `INNODB_LOCK_WAITS`.
- ⚑ **The slow query log** (a file, or a table when `log_output=TABLE`) isn't read. Closest: the digest summary's mean and maximum per statement, and the process list for what runs now.
- ⚑ **Galera and group replication** are read as single servers; their cluster state is flagged, not interpreted.
- **Discovery:** images `mysql`, `mariadb`, `percona`, `bitnami/mysql`, `bitnami/mariadb`, the Oracle MySQL operator's and the MariaDB operator's; port 3306.
- **Default rules:**
  - connections > 90 % of max for 5 min (warning);
  - a query runs longer than 5 min (critical; client sessions, not replication threads);
  - replication stopped: IO or SQL thread not running (critical);
  - replication lag > 30 s for 2 min (warning);
  - deadlocks detected (warning).
- **Reasons:** `connections_near_max` (with the clients holding most), `connections_refused`, `long_query`, `lock_waits` (the blocking session's workload), `deadlocks`, `replica_stopped`, `replica_lag`, `buffer_pool_hit_low`, `tmp_disk_tables_high`, `performance_schema_off` and `table_stats_unavailable` (hints).
- **Probable cause:** `lock_waits` and `connections_near_max` are application findings, like PostgreSQL's: the chain ends at the holder's own cause.

### Traefik (its Prometheus metrics; eBPF HTTP; v2.10+ and v3) — v0.5 (shipped in 0.5.0; ADR-165)

Access: nothing. Traefik's metrics on its `metrics` entrypoint (`:9100/metrics` in the Helm chart and k3s's bundled Traefik; `:8080/metrics` on the default entrypoint). Without them, requests, errors and latency come from eBPF (ADR-139) and the page gives the setting.

| Tab | Panels and sources |
|---|---|
| Overview | **S** requests/s (peak), 5xx (15 min), p95 (p50), open connections, services with a server up / total, the soonest certificate expiry · **SA** requests/s by status class (`traefik_entrypoint_requests_total`, or eBPF) · **L** p50, p95, p99 (`traefik_entrypoint_request_duration_seconds`, or eBPF) · **HB** busiest services (`traefik_service_requests_total`) |
| Services | **T** services: requests/s, 5xx %, p95, servers up / total (`traefik_service_server_up`), retries/s (`traefik_service_retries_total`), the backend workload or container · **L** 5xx by service · **HB** slowest services by p95 (`traefik_service_request_duration_seconds`). ⚑ Routers only when Traefik exports their labels (`addRoutersLabels`, off by default); closest: services. |
| Entrypoints and TLS | **SA** requests by entrypoint (`web`, `websecure`) · **L** open connections by entrypoint (`traefik_open_connections`; v2: `traefik_entrypoint_open_connections`) · **T** certificates: names, expiry (`traefik_tls_certs_not_after`) · **S** config reloads, last reload succeeded (`traefik_config_reloads_total`, `traefik_config_last_reload_success`) |

- **Service names to backends:** `<namespace>-<service>-<port>@kubernetes` is the Kubernetes Service; an IngressRoute's `<namespace>-<route>-<hash>@kubernetescrd` names only the route; `<service>-<project>@docker` (or a label's `<name>@docker`) the container or Compose service (measured in slice 3).
- **No server up:** Traefik's own 503s are counted on the entrypoint and never on a service, so "answered by Traefik" is the entrypoints' 503s minus the services'; the service is found from its backend's ready endpoints (Kubernetes), its container's state (Docker), or `traefik_service_server_up` (health checks only).
- ⚑ **Failed reloads:** Traefik 3 reports only the last success; the rule works on Traefik 2.
- **On the service map (ADR-165):** eBPF stays the source of an edge's HTTP stats. Traefik's numbers fill a Traefik → backend edge only where eBPF has none (TLS or HTTP/2 to the backend), marked "from Traefik". Requests Traefik answered itself with no connection made (no server up, a timeout) show on that edge as their own figure. The Traefik node shows requests per entrypoint, TLS included.
- ⚑ **Without metrics,** plain-HTTP traffic is eBPF's (time to the first response byte); TLS entrypoints and Traefik's own 502/503/504 aren't seen.
- **Not collected:** request paths and hosts (ADR-139).
- **Discovery:** images `traefik`, `rancher/mirrored-library-traefik` (k3s); ports 80, 443, 8080, 9100.
- **Default rules:**
  - 5xx > 5 % for 5 min (critical);
  - p95 > 1 s for 5 min (warning);
  - a service has no server up (critical);
  - a certificate expires within 14 days (warning);
  - the last configuration reload failed (warning).
- **Reasons:** `errors_high` (top service, linked to its workload's state and last rollout), `no_server_up` (linked to the backend), `latency_high`, `certificate_expiring`, `config_reload_failed`, `metrics_off` (hint, with the setting for k3s, Helm and Docker).
- **Probable cause:** `no_server_up` is an application finding that chains to the backend's own cause (scaled to 0, crashing, OOM).

### Kafka (the Kafka protocol's admin API; Kafka 3.0+, ZooKeeper or KRaft) — v0.5 (shipped in 0.5.0; ADR-166)

Access: nothing on PLAINTEXT listeners; otherwise SASL (PLAIN, SCRAM-SHA-256/512, the first the broker offers), with or without TLS (detected, unverified). A broker whose advertised host the collector can't resolve is reached at its discovered pod or container address. With ACLs: `Describe` on the cluster, every topic and every group (`DescribeConfigs` on topics optional, for retention). Read-only, through `franz-go`; no JMX.

| Tab | Panels and sources |
|---|---|
| Overview | **S** brokers up / known, offline partitions, under-replicated partitions, messages in/s, consumer groups (without members), the largest lag · **L** messages in/s by topic (end-offset growth, `ListOffsets`) · **L** lag per group (end − committed offsets, `ListOffsets` + `OffsetFetch`) · **T** groups: state, members, topics, lag, lag in time |
| Topics | **HB** largest topics (`DescribeLogDirs`, leader replicas) · **HB** busiest topics by messages in/s · **T** topics: partitions, replication factor, offline, under-replicated, retention (`Metadata`, `DescribeConfigs`), size |
| Consumer groups | **L** lag per group and topic · **L** consumed/s per group (committed-offset growth) · **T** members: client id, client workload (`DescribeGroups` client host through the IP map), assigned partitions |
| Brokers | **T** brokers: id, rack, controller, reachable (`Metadata`; KRaft quorum through `DescribeQuorum` when allowed) · **HB** partitions and leaders per broker · **HB** log size per broker (`DescribeLogDirs`) |
| Broker internals (only with a Prometheus endpoint) | **L** bytes in and out/s, requests/s, from a JMX exporter found on the usual ports (9404 Strimzi, 5556 Bitnami, 7071) at `/metrics`, read with promtext |

- ⚑ **Messages in/s** is end-offset growth, labelled "offsets/s": transaction markers and compaction make it approximate.
- ⚑ **Lag in time** isn't in the protocol. Closest: lag ÷ the topic's in-rate, labelled "about".
- ⚑ **Bytes in and out, request latency, handler idle and ISR shrinks** are JMX metrics; without a Prometheus endpoint they aren't shown.
- ⚑ **ZooKeeper's own health** isn't read.
- **Caps:** 200 topics (by size), 100 groups (lagging first); partitions are summed per topic, and only offline and under-replicated partitions are listed one by one (top 50).
- **Discovery:** images `apache/kafka`, `apache/kafka-native`, `bitnami/kafka`, `confluentinc/cp-kafka`, Strimzi's; port 9092. The other brokers come from `Metadata`.
- **Default rules:**
  - offline partitions (critical);
  - under-replicated partitions for 5 min (warning);
  - a broker down (critical);
  - a group's lag grows for 10 min (warning);
  - a group lost its members while its lag grows, for 5 min (critical).
- **Reasons:** `offline_partitions`, `under_replicated`, `broker_down`, `group_lag_growing`, `group_no_members` (the lost group: linked to the members it had, from the collector's last description with members, through the IP map; else to the clients whose eBPF flows into the broker port ended, as RabbitMQ's lost consumer, ADR-145), `acl_denied` (hint, with what each missing ACL costs).
- **Probable cause:** `group_no_members` is an application finding that chains to the lost member's own cause (OOM-killed, crashing, scaled to 0).

### MongoDB — v0.5 (shipped in 0.5.0; ADR-162, ADR-164; versions 6.0+, standalone and replica sets)

Access: nothing with authentication off; otherwise a user with `clusterMonitor`, which on 7.0 and 8.0 also reads `local` (the oplog window; measured in slice 2). The official Go driver v2, one direct connection per member (ADR-164).

| Tab | Panels and sources |
|---|---|
| Overview | **S** operations/s (reads %), connections of available, replication lag, slow operations (1 h), WiredTiger cache %, oplog window · **SA** operations by type (`opcounters`) · **L** lag per secondary (`replSetGetStatus`) · **T** replica set members: state, health, lag |
| Operations | **H** operation latency (`serverStatus` `opLatencies` histograms) · **HB** busiest collections (`top`) · **T** slow operations: shape, collection, duration, plan, COLLSCAN marked, client workload (`getLog global` "Slow query" entries; the shape keeps field names and operators, every literal becomes `?` (ADR-138); `queryShapeHash` on 8.0; the entry's `remote` address through the IP map) · **HB** connections by client workload (`$currentOp` with idle connections, client addresses through the IP map) |
| Cache and storage | **G** WiredTiger cache used vs maximum (dirty %); disk (`dbStats` `fsUsedSize`/`fsTotalSize`) · **L** read and write tickets available (`wiredTiger.concurrentTransactions`; `queues.execution` on 7.0+) · **HB** largest collections (`$collStats`) |

- ⚑ **The oplog window** is the first-to-last entry span: until the oplog is full it is only the set's age, so the rule waits for the oplog to be 90 % full (`$collStats` size vs `maxSize`).
- ⚑ **The slow-operation table** comes from `getLog global`, the server's in-memory ring of its last 1,024 log lines: on a busy server, entries between two scrapes can be missed. Closest for the count: `serverStatus` `metrics.operation`/`opLatencies` totals; the table is labelled "recent".
- ⚑ **Sharded clusters:** a `mongos` is read as one member (`serverStatus`); the shards behind it are monitored only if each is added.
- **Discovery:** images `mongo`, `mongodb/mongodb-community-server`, `bitnami/mongodb`, Percona's and the community operator's; port 27017.
- **Default rules:**
  - no primary (critical);
  - replication lag > 30 s for 2 min (warning);
  - a member is down (critical);
  - slow operations > 20/min for 5 min (warning);
  - oplog window < 24 h (warning).
- **Reasons:** `no_primary`, `member_down`, `replica_lag`, `slow_collscan` (with the client workload that sends the scans), `cache_pressure`, `connections_near_max` (with the clients holding most), `operations_queued`, `oplog_window_short`.
- **Probable cause:** `slow_collscan` and `connections_near_max` are application findings that chain to the client's own cause (a CronJob that started, a rollout); `no_primary` and `member_down` chain to the member's pod or container.

### Elasticsearch — after the launch, in the order users ask (ADR-162); catalog kept

Access: nothing with security off; otherwise an API key with the `monitor` privilege.

| Tab | Panels and sources |
|---|---|
| Overview | **S** status, nodes, JVM heap, unassigned shards, index rate, search latency · **L** heap per node with the 85 % line · **L** index and search rate · **T** nodes: role, heap, disk vs watermarks |
| Cluster and shards | **S** active, relocating, initializing, unassigned (`_cluster/health`) · **T** unassigned shards with the reason (`_cat/shards`, `_cluster/allocation/explain`) · **HB** shards per node · **G** disk vs low/high watermarks (`_cluster/settings`, defaults 85/90/95 %) |
| Indexing and search | **L** indexing rate · **H** search latency · **HB** busiest indices (`_nodes/stats`, `_stats`) |
| JVM and GC | **L** heap used · **L** GC time per minute, young and old · **G** heap per node |

- ⚑ **Search latency:** `_nodes/stats` and `_stats` keep only totals, so there is no p95 or histogram. Closest: the mean, and a per-index distribution of means.
- **Default rules:**
  - red (critical) or yellow for 10 min (warning);
  - heap > 85 % for 5 min (warning);
  - a node near the disk watermark (warning);
  - a node left (critical).

### Multi-user (ADR-140)

- **Roles:** Owner, Admin and Viewer in Community, with email invites. Without SMTP, the inviter copies the link.
- **What each role may do** is in ADR-140's table. Admins set integration credentials; nobody can read them back.
- **Tokens and MCP** act with their user's current role. Removing a user revokes their sessions and tokens.

**Accept when:**
- Redis, PostgreSQL, Nginx and RabbitMQ are each discovered, connected through the recommended path and shown with every tab, on a kind cluster and a Docker host.
- The demo's scripted failures each produce the right reason and alert:
  - a consumer OOM-killed while its queue grows;
  - PostgreSQL near `max_connections`;
  - 5xx behind the ingress.
- Claude Code, through MCP, explains each of those from WatchLog data alone.
- A Viewer can see everything and change nothing; a removed user's token stops at the next call.
- The collector stays within its budget with every integration on.
- **v0.5:** MySQL and MariaDB, MongoDB, Traefik and Kafka meet the same bar on a kind cluster and a Docker host, each with its default rules, reasons, MCP view, docs page and e2e script; the demo kit's failures for them name the right probable cause (ADR-171).

## 4.13 Probable cause ("Why is this broken?") — v0.4, All (shipped in 0.4.0)

(v0.10: an expired or mismatched certificate on the endpoint a failing edge or 5xx goes to, and a failed scheduled job in the workload an alert is about, are reasons: ADR-225.)

For every alert and every problem, WatchLog names the probable cause and shows the evidence, on Kubernetes clusters and Docker hosts alike (ADR-146 to ADR-160; the user page is `docs/site/probable-cause.md`).

- **Deterministic rules, no AI and no scores:** twelve rules in a fixed catalog (ADR-150), each with a Kubernetes and a Docker form (ADR-149), over the data already collected: the object's state and restarts, its events and change markers, the node or host under it, its CPU throttling, its edges on the service map and the findings of monitored applications. The walk follows failing, slow or slower-than-usual edges up to two hops (ADR-153, ADR-154).
- **In words:** Likely (one complete chain that began before or with the symptom), Possible (a lead), or No clear cause with "What we checked" (ADR-147). A cause always adds a fact the problem doesn't state (ADR-159).
- **Where:** the panel on the alert detail, pod, workload, Docker container and Compose service pages, the service map's edge panel and beside an application's finding; a line under each Needs-attention problem (§4.1; ADR-156); the "Likely cause:" line in Slack, Telegram and email and `likelyCause` in the webhook (§4.7; ADR-157); `GET /causes` and the optional `likelyCause` fields (§8.1); MCP `explain_problem`, `explain_alert`'s causes and `get_problems`' likely cause (§4.11; ADR-155).
- Anomaly correlation and root-cause hints across the map stay Enterprise (§4.8).


## 4.14 Egress watch ("What is my cluster talking to?") — v0.7, All (shipped in 0.7.0)

See every place a cluster or Docker fleet talks to on the internet, and know when something new starts talking (ADR-184 to ADR-193; the user page is `docs/site/egress.md`). Community, in every edition and plan.

- **Nothing new is read from traffic:** the inventory is built from the flow series the agent already sends (§6.4, ADR-106): connections, bytes and failures per edge, with external destinations named by the DNS answers the container received (ADR-104), else a `/24` (IPv6 `/48`) network, and "Internet" beyond the agent's cap per source. No payload, no TLS SNI, no HTTP host (ADR-102). The agent's budgets (§6.1) don't move; if the cap is measured to hide destinations, it is raised for named destinations only, with an ADR (ADR-184).
- **The inventory (ADR-185):** one row per source, destination and port with first and last seen, updated every minute by the alert worker; sources are workloads (Kubernetes) or Compose services, else containers on their host (Docker). Destinations in use at the upgrade get their first seen from the retained series. Rows are forgotten 90 days after they were last seen. Cluster addresses are never external (ADR-116, ADR-158).
- **The Egress page (ADR-188),** for a cluster and a Docker fleet: destination and port, the sources, first and last seen, bytes sent and received, connections, the failed share; badges **New** (first seen in 24 hours), **Raw IP** (a public address with no DNS name), **Failing** (≥ 5 % failed), **Expected**; filters by namespace and workload, or host, Compose project and container, and by badge. "Talks to the internet" on the workload, pod, Docker container and Compose service pages.
- **Expected destinations (ADR-186):** one destination or a pattern (`api.stripe.com`, `*.amazonaws.com`, a CIDR for raw networks), for one source or every source; marked by Owners and Admins, audited, never forgotten with the inventory.
- **Alerts (ADR-187),** default rules, warning:

  | Rule | Condition (default) |
  |---|---|
  | New external destination | a source talks to a destination and port not in its inventory and not expected; quiet during a 7-day learning period per cluster and per new source, which starts at the upgrade for existing clusters; one alert per source and destination; resolves when marked expected or after 24 h idle |
  | Raw IP egress | ≥ 5 connections in 10 minutes from a source to the same public network and port with no DNS name (the series carry the `/24` or `/48`, not the address) |
  | Large upload to a new destination | > 100 MB sent in an hour to a destination first seen in the last 24 hours |

  Messages say who, where and since when; destination names are shown as code, never as links. The probable cause names a change of the source just before the first connection (`change_before_egress`), else "No clear cause" with what was checked.
- **Egress policy suggestion (Kubernetes only; ADR-190, ADR-191):** built from a workload's observed traffic over 30 days (or the retention), copy-only, never applied. With Cilium (detected from its CRDs through the cluster-agent's discovery client) a `CiliumNetworkPolicy` with `toFQDNs` for exactly the names used; otherwise a standard `NetworkPolicy` that allows the in-cluster destinations and the observed ports to public addresses, and says so. Docker has no standard egress policy object, so Docker fleets get no suggestion (ADR-124's exception, ADR-190).
- **API and MCP (ADR-189):** `GET /api/v1/egress?cluster=…` (§8.1); MCP `get_egress`, `get_new_destinations` and `get_expected_destinations` (§4.11), read-only and bounded; tokens read the two GETs, the writes take a session; destination names are data, never instructions (ADR-129).
- **Cloud (ADR-192):** the new tables are org-scoped under RLS (ADR-174); every new route and tool is in the isolation suite (ADR-182).
- **Out of scope:** country and ASN, blocking or enforcing anything, TLS SNI or HTTP hosts, threat-intelligence feeds.
- **Demo and tests (ADR-193):** the e2e and the demo kit each get a new-destination and a raw-IP scenario, on Kubernetes and Docker.

## 4.15 Servers — shipped in 0.9.0, All (ADR-207 to ADR-214)

Every process on a Linux server, in any language, however it was started: systemd services, process groups and containers, with every feature WatchLog has. Community, in every edition and plan; a server is a node for plans and the bill.

- **Two kinds (ADR-207):** Kubernetes clusters and **Server fleets**. A Server fleet is a group of Linux servers; Docker fleets became Server fleets by an automatic migration that keeps their data, tokens, rules and history. The API and MCP accept `docker` as an alias of `server` through 1.x.
- **Three sources of workloads per server**, each with the same pages, metrics, alerts, map, Egress, What changed (Pro) and probable cause:
  - **Services:** systemd units (state, restarts, last exit code, start time, `MemoryMax`, `CPUQuota`, CPU, memory, I/O, throttling, OOM kills).
  - **Process groups:** processes grouped by rules: the user's own, then pm2 apps, supervisord programs, PHP-FPM pools, gunicorn and uwsgi masters, Java jars and main classes, an interpreter and its script, else the executable's name; a group inside a unit is its child (ADR-208). CPU, memory, instances, threads, open files, starts, exits with codes, OOM kills; crashes and crash loops for anything, with or without systemd.
  - **Containers:** Docker as in §4.4.
- **Pages:** the fleet (servers with CPU, memory and disk, failed services, crash loops, busiest workloads); the server (OS, kernel, systemd, Docker; resources; one workloads table with Service, Process and Container chips grouped by unit; listening ports; events); the workload (resources against limits, instances, restarts and exits, connections and HTTP, logs, alerts, probable cause, What changed); Overview, Workloads, Events, Service map, Egress, What changed and Alerts for Server fleets; the fleet's process-group rules with a preview.
- **Events (0.9.2, ADR-214):** the agent sends its services' (failed with systemd's result and exit code, started, stopped, restarted, unit file changed, OOM-killed, released) and process groups' (failed exit with its code or signal, crash loop and its end, appeared, gone, OOM-killed with the limit, released) events, stored and grouped like Kubernetes events. The fleet's Events page filters by server, workload, kind and reason, the Compose project within containers, with Hide system on by default; the server, workload and Overview pages read them.
- **Limits:** at most 50 process groups and 100 services a server, the rest counted; no PID, command line, argument, environment value or user name as a label or field; a group's name is derived and redacted on the server.
- **Install (ADR-209):** one command (signed release binaries, systemd units, user `watchlog`, the fewest capabilities, systemd hardening), deb and rpm, or `docker run --pid host`; upgrade and uninstall in the script. amd64 and arm64; systemd 239+ for services; without systemd, process groups only; cgroup v1 best effort; eBPF needs kernel 5.8+ with BTF, and without it everything but the map, Egress, HTTP and exit codes works.
- **Applications on servers:** discovery of host-native PostgreSQL, MySQL/MariaDB, Redis, MongoDB, RabbitMQ, Kafka, nginx, Traefik and PHP-FPM from listening sockets and the executable; the integrations collector runs natively; a PHP-FPM integration (§4.12's eight points).
- **Alerts (defaults):** a service failed; a service or process group crash-looping; an OOM kill; a process group gone (every instance exited); a unit at its CPU quota or memory limit; the server's CPU, memory, disk and inodes. Probable cause knows a new release (a unit's binary or a group's executable changed) and a limit.
- **Logs on demand:** a unit's journal, pm2's and supervisord's log files, Docker as before; redacted like container logs.
- **Right-sizing:** units with `MemoryMax` or `CPUQuota`, as for container limits.
- **Out of scope:** Windows and macOS, APM and tracing, JVM internals, an apt or yum repository.

## 4.16 Certificates and scheduled jobs — v0.10, All (ADR-221 to ADR-225)

Two things every server owner gets burned by, shown and alerted on with no setup, in Community and every Cloud plan, on Kubernetes and Servers: a TLS certificate that expires or stops renewing, and a scheduled job that fails, doesn't run, or runs far too long. Since 0.13.0 each has its own page in the sidebar's "Running here" group (`/certificates[/:certId]`, `/scheduled-jobs[/:jobId]`; 0.10's Applications tabs redirect there, query kept; ADR-230), and Applications is the services list alone.

- **Certificates (ADR-222):** what each TLS port presents, read on the server itself through a handshake to the ports the agent already knows, with the names of well-known certificate stores (directory names only) asked as SNI; STARTTLS where measured small. On Kubernetes, what Ingress hosts and TLS Services present, without reading Secrets. Kept: names, issuer, validity, fingerprint, who serves it, whether the chain is complete and the name matches, and every certificate seen per endpoint (renewals). Never a private key, never decrypted traffic.
- **Scheduled jobs (ADR-223):** systemd timers from systemd (schedule, last and next run, result, exit code, duration); cron from the crontabs on the server matched with the processes cron starts; Kubernetes CronJobs from their Jobs. States: Failed, Missed (told apart from the server or agent being down), Slow (after 5 runs), Working. Only a derived name leaves the server, never a command line, argument or environment value.
- **Storage (ADR-224):** bounded series for the rules (`cert.*`, `job.*`) and objects for the pages; the backend keeps each endpoint's certificates and each job's last 100 runs (30 days). "Renews itself" only after a renewal was seen; a renewal job WatchLog also sees is linked to its certificate.
- **Alerts and events (ADR-225):** see §4.7; events for renewed, expiring and expired certificates and for failed, missed and recovered jobs; probable-cause reasons.
- **Pages:** tiles, a table with problems first, filters, each certificate's page with its history, each job's page with its runs and the unit's journal on demand; the Overview's "Running here" row (§4.1) and the server page's counts; search with a status line; read-only API routes and MCP tools.
- **When they expire (0.13.0, ADR-230):** on the Certificates page under the tiles, every certificate as a dot on the day it expires, 30 d / 90 d (default) / 1 y, remembered per browser. Blue, amber under 14 days, red under 3; expired at the left edge ("expired 2 d ago"). Labels (on a fleet "api.acme.com · app-1 :443") on three lanes, problems and the soonest first, never overlapping (no room: no label, the dot still opens it), to the left of their dot near the right end; a label opens the certificate. "+N later than 90 days" at the end; the first 30 days shaded as the usual renewal window; ticks today, 14, 30, 60, 90 days (30 d: 7, 14, 21, 30; 1 y: 30, 90, 180, 365), fewer on a phone; a legend. Past about 15 in range, same-day certificates share a dot with a count that opens their list. A text equivalent, the range as named buttons, labels as links. One component; the Overview's strip is the same without labels.
- **Runs (0.13.0, ADR-230):** on the Scheduled jobs page, one lane per job (name and schedule in words, the strip, a summary: runs, failures, next run) over 6 h / 24 h (default) / 7 d, remembered per browser: 96 slots, the worst run of a slot wins (missed > failed > slow > exit code unknown > running > fine; a frequent job's slots from its hourly counts), a "now" line with the future shaded, the next runs dashed from the next time and the period. Green, red, amber, a red outline for missed, grey for a cron run without exit code. A mark's tooltip and accessible name say time, result, exit code and duration; a click opens the job at that run (`?run=`, highlighted). Problems first, then by next run; 12 lanes and "Show all N"; the table's filter and search apply. One request for all jobs: `GET /clusters/:id/scheduled-jobs/timeline?range=` (runs capped per answer).
- **One list (0.13.1, ADR-230 amended):** the Runs timeline and the table become one card, "Jobs and their runs": Job · Schedule (in words, systemd and cron alike; raw in monospace when it can't be said, always in the tooltip; the next run under it) · the run strip · Last run · Status, one link per row (≥ 44 px), the filters and search in its header, the range (default 24 h, a new stored key) on the right. One order: need attention, running, working, new; then next run. Jobs that don't run (disabled timers, cron lines with no cron daemon, suspended CronJobs) sit in one collapsed row with their reason and count in neither the rows nor "Need attention". The part of each strip before WatchLog first saw the job (`firstSeen`) is hatched; "WatchLog has watched this fleet for 5 hours" when the place is younger than a day (`watchedSince`). One next-run function in the backend (`nextRun`) serves the list, a job's page, the Overview and the strip: a reported time still ahead wins, else the period from the reported time or the last run ("about"); a relative timer is its last run plus its interval (agent 0.13.1 reports `OnUnitActiveSec`); a random delay gives the earliest time and a window.
- **Limits:** 50 ports probed, 100 certificates and 100 jobs per server or cluster, 30 runs a job in the agent; anacron, `at`, client certificates and certificate files no port serves are not covered unless ADR-223 says otherwise.

## 4.17 Network devices — v0.16 and v0.17, Pro and Enterprise (ADR-233, ADR-234)

The switches and routers the servers and nodes sit on: what's connected to what, which port each server or node is on, how busy each link is, and what broke. Cloud Pro, self-hosted Enterprise with a licence listing `network`, and the live demo; Cloud Free and Community see a teaser (a still picture of the map, three lines, "Available in Pro and Enterprise") and the API answers 404. Docs: `docs/site/network.md`.

- **Code:** in `ee/` (backend module, its migrations in `pgmigrations_ee`, web pages, the collector's Go package with the `ee` tag). The core has the sidebar item and teaser, the agents' network cards (`host_interfaces`), the unit count's hook (`usage_hourly.devices`) and the extension points (collector config sections, ingest routes, events, What changed's network changes, the `network_port` cause, module alert rules). The core builds and passes without `ee/`.
- **The poller:** the integrations collector (ADR-131) of a cluster, or of one server of a fleet, chosen per device. SNMP (v3 authPriv by default, v2c allowed with a clear-text note; GET, GETNEXT, GETBULK only) with vendor profiles as YAML data (generic, Cisco IOS, NX-OS, MikroTik); MikroTik's RouterOS over REST (HTTPS), else API-SSL, the plain API only when allowed, the certificate pinned on first contact. Health and counters every 60 s, inventory every 5 min; 2 requests in flight per device, 5 s, 2 retries, backoff after 3 failures to an hour.
- **Data:** devices, ports, links (CDP, LLDP, MNDP merged from both ends, or MAC tables), endpoints (MAC, IP, IEEE vendor, the port nearest them, the WatchLog server or node they are), credential profiles (AES-256-GCM, write-only, sent only to their devices' poller). Series `watchlog_net_*` labelled `device` (the id) and `ifname` only; ports only when up, described, linked or with a server behind them; under the collector's 20,000.
- **Linking:** a server's or node's page shows its switch port; port down/up, speed changes, errors starting, uplink errors and device reboots go to the Events of the places behind them, What changed's "Changed around then", and probable cause (`network_port`).
- **Pages:** Network → Overview (tiles, the map smaller, Needs attention, every device), Map (bands, status rings, badges, links by speed with traffic dashes, focus path, docked panel, layers, zoom/fit/search, endpoints grouped, a layout saved per org), Devices (filters), a device (front panel, port charts, hardware, SFPs, stacks, events, RouterOS version), Add devices (poller, credential profiles, seeds/range/neighbours, the found list, setup commands for IOS, NX-OS, RouterOS). Tabs are registered; Wireless and Storage (0.17) show only where the network has such devices.
- **Alerts (defaults, held per device under "unreachable"):** unreachable (3 polls), rebooted, uplink down (linked ports only), port errors, speed dropped, link busy (90%, 10 min), CPU, memory, temperature, fan or PSU, SFP optics, stack member lost, RouterOS certificate changed; thresholds in ADR-233.
- **Units and billing:** a device is one unit, like a node or a server, in the same p95 (Cloud) and licence count (Enterprise); controller-managed access points free; Cloud Free has none.
- **Wi-Fi (0.17, ADR-234):** MikroTik CAPsMAN on a RouterOS router, both generations (the `wifi` package's and the legacy `caps-man`), over the router's own read-only connection: access points (identity, model, address, version, state, uptime, radios with band, channel, frequency, tx power, noise, clients; their switch port from the MAC tables), clients as rows refreshed every minute (MAC and vendor, AP, SSID, band, signal, rates, uptime, bytes), counts per AP and SSID as series, mesh/WDS backhaul as dotted links. Access points are free. Network → Wireless: tiles, the APs with client sparklines, the traffic with its usual band, the clients table.
- **Storage (0.17):** a QNAP over SNMPv3 (NAS-MIB: disks with temperature and SMART, volumes, pools and RAID, LUNs, iSCSI targets; plus HOST-RESOURCES and IF-MIB). QTS gives no read-only way to its iSCSI sessions, so they are derived from the recorders' own view and the switch ports, and the page says "seen from the recorder and the network, not from the NAS". Network → Storage: a card per NAS, the iSCSI sessions (recorder → LUN, since, throughput, the switch path the map's iSCSI layer draws).
- **Recording (0.17):** Dahua recorders over their HTTP API (digest, a dedicated user, GET only, a fixed list of calls, the event attach stream with reconnect and backoff). "Recording" is judged from three signals, each shown: the recorder's own state and events, its iSCSI disk present and healthy, its write throughput toward the NAS inside its usual band (What changed's baseline, `EeHost.baseline`). Any one failing for 5 minutes is "not recording", naming it; a camera going offline is a camera alert. A Recording card per recorder (cameras, the disk and LUN, days left at the current rate, today's rate against usual), a camera list, and the Overview's Recording card.
- **UPSes (0.17):** RFC 1628 UPS-MIB and APC PowerNet-MIB: status, charge, runtime, load, voltages, temperature, replace flag; a UPS card on Storage, its own map icon; "feeds" a WatchLog server or node, whose Events then show it going on battery.
- **Alerts (0.17 defaults, thresholds in ADR-234):** AP disconnected, AP with no clients when it usually has them, many weak clients, 2.4 GHz overlap; NAS disk SMART, disk hot, RAID degraded or rebuilding, volume or LUN over 90%, iSCSI session lost; recorder not recording, iSCSI disk lost, storage full soon, cameras offline (grouped per recorder); UPS on battery, runtime under 10 minutes, battery to replace, overload. NAS and recorder unreachable are the device's unreachable.

# 5. System architecture

## 5.1 Components

| Component | Language / tech | Runs where | Responsibility |
|---|---|---|---|
| `agent` | Go | DaemonSet on every K8s node, or one container per Docker host | Node, container and eBPF network metrics; push to ingest |
| `cluster-agent` | Go (same binary, `--mode=cluster`) | Deployment, 1 replica per K8s cluster | Watch the Kubernetes API: objects, events, state metrics |
| `backend` | Node.js 24 LTS, TypeScript, Fastify | Server / Cloud | Auth, REST API, ingest gateway, metadata, alert rules, query proxy |
| `integrations` | Go (third binary of the agent module, ADR-131) | Deployment, 1 per K8s cluster; one container per Docker host with monitored services | Read monitored services (Redis, PostgreSQL, Nginx, …) with read-only access; push metrics and status (§4.12) |
| `alert-worker` | Node.js (same codebase, separate process) | Server / Cloud | Evaluate rules every 30 s, manage state, send notifications |
| `anomaly-worker` | Node.js (same codebase, separate process; 0.8.0, ADR-197) | Cloud and the live demo only, never Community | Baselines and anomaly scoring for Pro orgs (§4.8) |
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

## 5.4 Multi-tenancy (Cloud) — Cloud (shipped in 0.6.0; ADR-174, ADR-177, ADR-182)

- **The switch:** `WATCHLOG_EDITION=cloud` turns on every Cloud-only path. Unset, the product is Community and behaves exactly as 0.5.0: one default org, no limits, no signup, no billing; the Cloud routes answer 404 (ADR-173).
- **PostgreSQL:** every tenant table has `org_id` (cluster-keyed tables gain it, backfilled), with Row-Level Security policies on `watchlog.org_id` as a second layer. In Cloud the request path connects as `watchlog_app`, a role that can't bypass RLS, and the org is set on every connection checkout from the request's context; an allow-listed `systemDb` (the owner role) handles the lookups that come before the org is known and the cross-org jobs. Community keeps connecting as the owner, so RLS doesn't change it (ADR-174).
- **VictoriaMetrics:** `cluster_id` is injected from the token at ingest (ADR-026) and on every query (ADR-028). One guard authorises a cluster against the org before any query, SSE stream, MCP tool or export. Move to VictoriaMetrics cluster with native `accountID` tenants when > 2,000 nodes.
- **Retention per plan:** separate VictoriaMetrics instances per retention tier, `vm-3d` and `vm-30d`. Ingest writes to the org's tier; after a plan change, queries read both until the old tier's retention runs out (ADR-177).
- **Rate limits and ingest quotas** per org in Redis (Community keeps in-memory buckets).
- **Proof:** the cross-org isolation suite calls every REST route, MCP tool, curated query key, ingest path and SSE stream as another org, in CI on every push (ADR-182).

## 5.5 Cloud production hosting — Cloud (shipped in 0.6.0; ADR-180)

WatchLog Cloud starts on **the current production server** (36 GB), beside the site, the waitlist and the live demo, as its **own Docker Compose project**. It is enough for the first ~1,000 monitored nodes.

- **Where:** the Compose kit lives in the private Cloud repository (`deploy/cloud/`), with the billing service; it runs the public release's images. Its own network, volumes and data directory; every port on 127.0.0.1; memory and CPU limits on every container.
- **Services:** `backend` (API + ingest), `alert-worker`, `web`, `vm-3d`, `vm-30d`, `postgres`, `billing`, and `anomaly-worker` from 0.8.0 (with its own memory and CPU limits, its budget measured at 1,000 nodes, ADR-197); `redis` once the per-org rate-limit buckets use it (ADR-180 "As built").
- **Proxy:** the host's existing nginx (it owns 80/443), with new vhost files for `cloud.watchlog.io` (dashboard and API) and `ingest.watchlog.io` (agents only), behind Cloudflare. No Caddy. `app.watchlog.io` stays the v1 app.
- **Status page:** `status.watchlog.io` is an external uptime service's page, so it stays up when the server doesn't.
- **Backups:** nightly `pg_dump` + WAL archiving and VictoriaMetrics snapshots, encrypted on the server before they leave it, shipped to S3-compatible storage; a restore test runs monthly by script.
- **Deploy:** GitHub Actions builds and pushes images to GHCR; the owner pulls tagged images on the server with the kit's update script. Database migrations run before the new backend starts (ADR-107).
- **Monitoring:** a WatchLog Docker agent reports the Cloud project to a staff org in Cloud (dogfooding), plus an external uptime check.
- **Sharing the server:** nothing existing is touched (the v1 app, pm2, other vhosts, system packages, the firewall). The demo's privileged Docker host (ADR-170) is turned off or moved before the first customers are invited.
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
| Server | `agent` | `--mode=server` (`--mode=docker` is an alias, ADR-207) | systemd unit (install script, deb, rpm) or `docker run --pid host` on each server | Host metrics, systemd services, process groups, containers via the Docker socket (read-only), eBPF flows, exits and OOM kills (ADR-208, ADR-210) |

Only the cluster-agent links client-go (it adds ~21 MB to the binary and ~11 MB idle RSS, measured), so node and Docker agents keep a small footprint.

## 6.3 Collectors (node / docker mode)

| Collector | Source | Key metrics (all prefixed `watchlog_`) |
|---|---|---|
| host | `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/diskstats`, `/proc/net/dev`, `statfs` | `node_cpu_seconds_total{mode}`, `node_memory_bytes{state}`, `node_load1/5/15`, `node_disk_io_bytes_total{dev,dir}`, `node_filesystem_bytes{mount,state}`, `node_network_bytes_total{iface,dir}` |
| containers | cgroups v2 (`cpu.stat`, `memory.current`, `memory.stat`, `io.stat`), v1 fallback | `container_cpu_seconds_total`, `container_cpu_throttled_seconds_total`, `container_memory_working_set_bytes`, `container_memory_limit_bytes`, `container_cpu_limit_cores`, `container_fs_bytes` (writable layer), `container_fs_io_bytes_total{dir}` (block I/O), `container_network_bytes_total{dir}` |
| runtime | Kubernetes: pod UID and container ID from cgroup paths, names and workload from the cluster-agent's node-scoped pod map (no CRI socket, ADR-049); Docker: Docker socket | container ↔ pod/namespace mapping, image, state, restart count, health: `container_state{state}`, `container_health{status}`, `container_restarts_total`, `container_oom_events_total`, `container_start_time_seconds`, `container_memory_reservation_bytes` (Docker, from inspect, when set; v0.5, ADR-168), `docker_info{docker_version,kernel,os,arch}` |
| kubelet | `/stats/summary` (node-local, authenticated with ServiceAccount; TLS `auto`/`verify`/`skip`, ADR-051) | ephemeral storage, volume (PVC) usage, pod network |
| network (eBPF) | §6.4 | `flow_connections_total`, `flow_connect_failed_total`, `flow_connect_latency_seconds` (histogram), `flow_bytes_total{dir}`, `flow_retransmits_total`, `dns_requests_total{rcode}`; HTTP/1.x (ADR-139): `http_requests_total{code,class}`, `http_requests_by_method_total{method}`, `http_request_duration_seconds` (histogram) per edge, and the same as `http_server_*` per server workload and `port` |

**Nodes that are containers** (kind, k3d, LXC; ADR-121): `agent.nodeMetricsScope` is `host`, `cgroup` or `auto` (default). In cgroup scope the host collector reads the node container's own cgroup: CPU count from `cpu.max`, memory total from `memory.max`, CPU and memory use from `cpu.stat` and `memory.stat`, disk I/O from `io.stat` as `dev="all"`, the node container's start as boot time; no load average and no filesystem sizes, so nothing of the machine underneath appears. The backend then takes the node's capacity from the agent, not from the Node object.

Labels on container series: `cluster_id` (server-injected), `node`, `namespace`, `pod`, `container`, `workload_kind`, `workload`. Docker mode: `host`, `container`, `image`, `compose_project`, `compose_service`.

**Cardinality rules (MUST):** no pod UID, no container ID, no IPs, no ports above the well-known range as labels except on flow series where the destination is aggregated (see §6.4). Agent hard cap: 20,000 active series per node; beyond that, drop lowest-priority collectors and emit `watchlog_agent_series_dropped_total`.

## 6.4 eBPF network collection

- Library: `github.com/cilium/ebpf` with CO-RE; programs compiled at build time via `bpf2go`.
- Hooks: `tcp_connect` / `inet_sock_set_state` tracepoint (connection lifecycle, latency, failures), `tcp_retransmit_skb`, `tcp_sendmsg` / `tcp_cleanup_rbuf` (bytes), UDP 53 kprobes or socket filter for DNS rcode.
- **Pod filter** (Kubernetes mode, default on, ADR-121): the kernel records a connection or DNS query only when the task's cgroup is below one of the node's kubepods cgroups; anything else on the same kernel (host daemons, plain containers, another cluster's pods) is only counted. User space still drops flows of unknown cgroups as a second line.
- Per-connection state is aggregated **in user space every 15 s** into edges keyed by `(src_workload, dst_workload | dst_external, dst_port)`.
- IP → workload resolution uses the pod/service cache received from the cluster-agent (node agents subscribe to a lightweight endpoint on the cluster-agent, not to the API server directly, to protect the API server at scale).
- External destinations are aggregated by DNS name when known (from the DNS collector), otherwise by `/24` network + port, and collapsed into "Internet" beyond 50 distinct externals per workload. v0.7 measured how often the cap hides named destinations: only past 50, which no real source came near, so the cap stays at 50 (ADR-184, as built).
- eBPF is **opt-out** (`agent.networkFlows.enabled=true` by default, ADR-107). If disabled or unsupported, everything else still works, and the service map says why and shows the fix.

## 6.5 Cluster-agent

- Uses client-go informers for: Nodes, Namespaces, Pods, Deployments, ReplicaSets (owner resolution), StatefulSets, DaemonSets, Jobs, CronJobs, PVCs, HPAs, Events (Phase 2, ADR-052); Services, Endpoints/EndpointSlices, Ingresses and PVs are added with the service map (Phase 4).
- Sends object **snapshots** (on start and every 10 min) and **deltas** (on change) to `POST /ingest/v1/objects` — trimmed to the fields the UI needs (no `managedFields`, no annotations except an allow-list, **never** env values or Secrets).
- Emits state metrics (`kube_pod_status_phase`, `kube_deployment_replicas{state}`, `kube_node_condition`, `kube_pod_container_restarts_total`, `kube_pod_container_last_termination_reason`, etc.; list and cap in ADR-056). Resource requests and limits stay on the objects, not as series.
- Ships events to `POST /ingest/v1/events` in batches.
- Serves node agents a node-scoped pod map (pod UID → namespace, pod, workload; container ID → container name) over in-cluster HTTPS, authenticated with the node agent's ServiceAccount token via TokenReview; each node gets only its own pods (ADR-066). Phase 4 adds the IP→workload map to the same endpoint.
- Node agents never depend on the cluster-agent for node-level metrics; they keep the last pod map on disk, hold unmapped container series up to 60 s, then drop and count them (ADR-049).

## 6.6 Security and RBAC

- Cluster-agent ClusterRole is **read-only**: `get, list, watch` on the resources in §6.5, plus `create` on `tokenreviews` (pod map authentication); a namespaced Role for its leader-election Lease. Node agent ClusterRole: `get` on `nodes/stats` only. **No access to Secrets, ConfigMaps or `nodes/proxy`** (ADR-049, ADR-060). `get` on `pods/log` while logs on demand are on (`logs.enabled`, default on from v0.5; ADR-167).
- Node agent runs with `hostNetwork: false`, `hostPID` only where measured necessary, as a non-root user, read-only root filesystem, all capabilities dropped and none added until eBPF (Phase 4: `BPF`, `PERFMON`, `SYS_RESOURCE`, `SYS_PTRACE` for `/proc/<pid>` of other containers, `NET_ADMIN` only if required by the chosen hook). The release namespace is labelled `pod-security.kubernetes.io/enforce: privileged` because the agent needs read-only hostPath mounts of `/proc` and `/sys`. Document every capability and exception in `docs/security.md`.
- Server mode (ADR-209): installed natively it runs as the user `watchlog` with only the capabilities measured to be needed (listed in ADR-209 and `docs/security.md`) and systemd hardening; it reads `/proc` of every process but never an environment, and sends no PID, command line or argument. With Docker present it joins the `docker` group (root-equivalent; `--no-docker` opts out).
- Docker (and server) mode mounts `/var/run/docker.sock` **read-only** and only calls list/inspect/stats/events endpoints, and the container logs endpoint while logs on demand are on (`WATCHLOG_LOGS`, ADR-167).
- Transport: HTTPS with TLS 1.2+; cluster token in `Authorization: Bearer`. Tokens are per cluster, revocable, 256-bit random values stored as a SHA-256 hash in the backend (a slow hash adds cost without security for high-entropy tokens; argon2id is used for passwords; ADR-025).
- Certificates (v0.10, ADR-222): the agent opens TLS handshakes to the server's own listening ports and reads the presented chain; it lists the directory names of certificate stores, never their files, and never reads a private key. The cluster-agent reads Ingresses' hosts, never their Secrets. Crontabs are parsed on the server; only a job's derived name leaves it (ADR-223).
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
  enabled: true                             # logs on demand (ADR-167); false removes pods/log
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
| `invites` | org_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at | v0.3 (ADR-140): 7-day links, SHA-256 token |
| `clusters` | org_id, name, kind (`kubernetes`/`docker`), status, first_seen_at, last_seen_at, agent_version, k8s_version, node_count | |
| `cluster_tokens` | cluster_id, token_hash, prefix (first 8 chars shown in UI), revoked_at | |
| `agent_instances` | cluster_id, node, mode, agent_version, capabilities (jsonb), last_seen_at | One row per agent (node / Docker host), updated by heartbeats (ADR-029) |
| `objects` | cluster_id, source (`kubernetes`/`docker`), kind, namespace, name, uid, node, spec_summary (jsonb), status_summary (jsonb), deleted_at | Upsert by (cluster_id, uid). Kubernetes objects and Docker hosts/containers (ADR-029) |
| `k8s_events` | cluster_id, day, involved_key, namespace, involved_kind, involved_name, involved_uid, type, reason, message, count, event_counts (jsonb), first_ts, last_ts, reporting_controller | Partitioned by day (UTC); key (cluster_id, day, involved_key, reason), no id column; retention job (ADR-061) |
| `change_markers` | cluster_id, kind (`rollout`/`image`/`scale`/`node`), target, namespace, details (jsonb), ts | |
| `alert_rules` | org_id, cluster_id (nullable = all), name, type (`default`/`threshold`/`anomaly`), rule_key (default rules), metric, scope (jsonb), condition (jsonb), for_seconds, severity, renotify_seconds, enabled, channel_ids, eval_error | |
| `alert_channels` | org_id, type (`slack`/`telegram`/`email`/`webhook`), name, config (jsonb, secrets encrypted with AES-GCM), verified_at | |
| `alert_states` | org_id, rule_id, cluster_id, fingerprint, state (`pending`/`firing`/`resolved`), severity, labels (jsonb), details (jsonb), started_at, fired_at, resolved_at, last_notified_at, silenced, flapping, held, rule_snapshot (jsonb), cause (jsonb), cause_at, version | One open row per (rule, cluster, fingerprint); held = state unknown (ADR-094); rule_snapshot = the rule as the alert was evaluated (ADR-098); cause = its probable cause when it fired (ADR-157) |
| `alert_worker_heartbeats` | worker_id, version, started_at, lock_pid, buckets, last_cycle_at, last_error | One row per running worker (ADR-088) |
| `alerting_periods` | started_at, ended_at | When alerting ran; gaps explain late alerts (ADR-098) |
| `server_settings` | key (`general`/`smtp`/`telegram`), value (jsonb), secret (encrypted) | Settings made in the UI; environment overrides (ADR-093) |
| `secret_key_check` | canary | Proves the secret key can decrypt stored secrets (ADR-079) |
| `telegram_verifications` | channel_id, code_hash, expires_at | Telegram deep-link connection |
| `notifications` | org_id, channel_id, kind (`firing`/`resolved`/`renotify`/`escalated`/`flapping`/`test`), payload (jsonb), status (`pending`/`sending`/`sent`/`failed`/`dropped`), attempts, next_attempt_at, dedupe_key, error, sent_at | The outbox: one row per channel and message (ADR-074); `notification_alerts` links a message to the alerts it covers |
| `silences` | org_id, matchers (jsonb), starts_at, ends_at, created_by, comment | |
| `anomaly_orgs` (v0.8) | org_id, learning_since, entitled_at | When an org started learning What changed (ADR-204); RLS |
| `anomaly_baselines` (v0.8) | org_id, cluster_id, series_hash, metric, subject (jsonb), medians, mads (`real[168]`), minutes (`smallint[168]`), first_seen, last_seen | One row per scored series, 168 UTC hour-of-week buckets over 14 days, fillfactor 70 (ADR-198); RLS |
| `anomaly_learning` (0.9.4) | org_id, cluster_id, hours (`integer[168]`), looked_at (`timestamptz[168]`), looks (`smallint[168]`), ready_at, resumed_at, series, series_learning, learning_until, first_seen, breakdown (jsonb), updated_at | One row per cluster, written with each hourly recompute: the coverage the worker's scoring and the learning page both read (ADR-216, ADR-217); RLS |
| `anomaly_ready_emails` (0.9.4) | org_id, cluster_id, user_id, created_at, sent_at | A member's "email me when it's ready" for one cluster; sent once (ADR-216); RLS |
| `anomaly_periods` (v0.8) | org_id, cluster_id, series_hash, metric, subject, started_at, ended_at, bucket, median, usual_low, usual_high, peak_score, peak_value, peak_at, last_value, last_at | Unusual periods, one open per series, kept for the org's retention (ADR-198); RLS |
| `anomaly_feedback` (v0.8) | org_id, cluster_id, series_hash, metric, subject, bucket, answer (`useful`/`normal`), alert_id, value, median, min_spread, created_by, undone_at | "Was this worth an alert?" (ADR-200); RLS |
| `discovered_services` | org_id, cluster_id, type, target (jsonb: workload / Compose service / container / host:port), image, ports, confidence, ignored_at, ignored_image | From images, ports and flows (ADR-132) |
| `integrations` | org_id, cluster_id, type, name, target (jsonb), version, status, status_details (jsonb: per-tab permission states, last error), settings (jsonb: query text on/off), collector (host for Docker), created_by, monitored_since | One row per monitored service instance (§4.12) |
| `integration_credentials` | integration_id, method (`generated`/`entered`/`reference`), username, secret (AES-256-GCM, bound to the row), reference (jsonb: Secret name/key or file path), set_by, set_at, verified_at | Write-only (ADR-133) |
| `integration_events` | integration_id, actor_id, action, ip, ts, details (jsonb, never a secret) | Credential and settings changes (ADR-133) |
| `integration_texts` | integration_id, fingerprint, text (normalised, ≤ 1 KB), first_seen, last_seen | Statement and slow-log texts; deleted when query text is turned off (ADR-138) |
| `egress_destinations` (v0.7) | org_id, cluster_id, source, destination, dst_kind, port, first_seen, last_seen, approved_by, approved_at, pattern | The egress inventory, updated every minute, forgotten 90 days after last seen (ADR-185); RLS (ADR-192) |
| `egress_sources` (v0.7) | org_id, cluster_id, source, first_seen | Starts each source's learning period (ADR-185, ADR-187) |
| `egress_expected` (v0.7) | org_id, cluster_id, pattern, port, source (null = all), created_by, comment | Expected destinations and patterns, kept until removed (ADR-186) |
| `funnel_events` | user_id, org_id, name, props (jsonb), ts | §10.4 |
| `subscriptions` (Cloud repo) | org_id, plan, stripe_subscription_id, nodes_billed_p95, period_start, period_end, status | Private Cloud repository; source of truth is Stripe, synced via webhooks |
| `audit_log` (E) | org_id, actor_id, action, target, diff (jsonb), ip, ts | `ee/` |

Migrations: `node-pg-migrate` (or Drizzle migrations — decide in Phase 0), forward-only, one file per change.

# 8. API

REST + JSON, base path `/api/v1`. Auth: HTTP-only secure session cookie for the web app; `Authorization: Bearer wl_pat_...` for personal API tokens (read scope, ADR-125; never both on one request). The MCP server is `POST /mcp` with the same tokens (§4.11, ADR-127). Errors follow RFC 9457 (`application/problem+json`). OpenAPI 3.1 spec generated from Fastify schemas; `/api/v1/openapi.json` serves its public part (ADR-126), and `packages/api-types/openapi.json` holds the full spec for the dashboard.

## 8.1 Public API (excerpt)

| Method & path | Purpose |
|---|---|
| `POST /auth/signup` · `POST /auth/login` · `POST /auth/logout` | Email + password |
| `GET /auth/oauth/github` · `/google` | OAuth login (P0 GitHub, P1 Google) |
| `POST /auth/verify-email` · `POST /auth/forgot` · `POST /auth/reset` | |
| `GET /me` · `PATCH /me` | Profile, locale; `GET /me` also names the API token a request came with (null with a session) |
| `GET/POST /orgs` · `GET/PATCH /orgs/:id` · `POST /orgs/:id/invites` | |
| `GET/POST /clusters` · `GET/PATCH/DELETE /clusters/:id` | Create returns install commands + token (shown once) |
| `POST /clusters/:id/tokens` · `DELETE /clusters/:id/tokens/:tid` | Rotate / revoke |
| `GET /clusters/:id/onboarding-status` | Server-sent events: `agent_seen`, `cluster_agent_seen`, `first_metrics`, `ebpf_status`, `service_map_ready` |
| `GET /clusters/:id/overview` | Data for §4.1; each of the first 20 problems carries `likelyCause` when one cause is likely (ADR-148, ADR-155), and `causeState` (`likely`, `possible`, `none`) with up to two `possibleCauses` (`{rule, code, facts, since, where}`, `where` the step where it starts: `{code, facts, name}`) for the Needs-attention line (ADR-156, ADR-157) |
| `GET /clusters/:id/nodes` · `/nodes/:name` | |
| `GET /clusters/:id/workloads` · `/pods` · `/pods/:ns/:name` | |
| `GET /clusters/:id/docker/hosts` · `/docker/containers` | |
| `GET /clusters/:id/service-map?from&to&namespace` | Graph JSON: `{nodes:[], edges:[]}` |
| `GET /clusters/:id/events` | Paged, filterable |
| `GET /causes?cluster=<id>&subject=<kind>:<ref>` | Probable cause (ADR-146 to ADR-148): `state` (likely, possible, none), a `headline`, up to 3 ranked `causes` with their evidence `chain`, the `checks` made and the nodes with network flows off; every sentence a code with facts. Subjects: `alert:<id>`, `pod:<ns>/<pod>`, `workload:<ns>/<Kind>/<name>` (or `<ns>/<name>`), `container:<host>/<name>` (or `<name>`), `compose_service:<project>/<service>`, `edge:<map edge id>`, `application:<id or name>`. Kept 15 s per subject |
| `likelyCause` (optional) | On a Needs-attention problem (`/overview`), the alert detail (`GET /alerts/:id`) and an application with a finding (`GET /applications`, `/applications/:id`): `{rule, code, facts, since, headline, subject}`, the top cause of `GET /causes` when it is likely, left out when causes are only possible, none is clear, or the answer took longer than 2 s; `subject` asks `GET /causes` for the chain and the checks. Lists explain at most 20 subjects, 4 at a time, from the same 15 s cache (ADR-155) |
| `GET /clusters/:id/pods/:namespace/:name/logs?container&lines&previous&follow` | Logs on demand (ADR-167): the last `lines` (1–1,000, default 200) of a container, redacted, never stored; `previous` reads the container's last run; `follow=true` with `Accept: text/event-stream` streams new lines for up to 5 minutes. JSON `{lines:[{ts, text}], redacted, truncated}`. 504 when no agent picked the request up in 10 s; 403 when the setting doesn't allow the caller's role |
| `GET /clusters/:id/docker/hosts/:host/containers/:name/logs?lines&follow` | The same for a Docker container; each line also carries its `stream` (stdout, stderr) |
| `GET /clusters/:id/right-sizing?namespace&kind&workload&host&container&project&service&system` | Right-sizing hints (ADR-168): per container `{object, container, resource (cpu, memory), code, facts, suggestion, giveBack, basedOn {windowHours, from, to, samples, hours}}`, OOM risk first; `notEnoughHistory` rows for containers with less than 24 hours; `summary` (objects, giveBackObjects, giveBack {cores, bytes}, oomRisk). The use is kept an hour per cluster, requests and limits read on each request |
| `GET /clusters/:id/search?q&limit` | The ⌘K palette's object search (ADR-169): workloads, pods, nodes (Kubernetes); hosts, containers, Compose projects (Docker); applications (also by type). Letters in order, one typo as a fallback; exact and prefix matches first. At most 8 per kind, 40 in all |
| MCP tools added in v0.5 (shipped in 0.5.0) | `get_container_logs` (the logs routes above, at most 200 lines) and `get_right_sizing` (§4.11). The new integrations need no new tool: `list_applications` and `get_application` cover every type |
| `GET /egress?cluster=<id>&from&to&namespace&kind&workload&host&project&service&container&badge&q&firstSeenAfter` (v0.7, public) | Egress watch (ADR-189): learning state, summary counts, rows `{destination, port, kind, private, sources, firstSeen, lastSeen, sent, received, connections, failedRatio, badges, expected, alertId}`, at most 500 |
| `GET/POST /egress/expected` · `DELETE /egress/expected/:id` (v0.7; the GET public) | Expected destinations and patterns (ADR-186); writes by Owners and Admins with a session |
| `GET /egress/policy?cluster=<id>&workload=<ns>/<Kind>/<name>&flavour` (v0.7, public) | The suggested egress policy, Kubernetes only (ADR-190): `cilium`, `window`, `counts` and `policies` `[{flavour, yaml, notes}]`, the detected flavour first; 404 with a reason on Docker fleets, 409 when no pod of the workload runs |
| `GET /what-changed?cluster=<id>&from&to&alert&sort` (0.8.0, public; Pro only) | What changed (ADR-202): the window, the learning state, rows `{since, until, subject, object, peer, key, unit, usualLow, usualHigh, value, peakScore, peakAt}` (at most 50, `truncated`, `total`), the unusual-activity chart, the probable cause's short form; at most 24 hours; 403 `pro-feature` for Cloud Free, 404 in Community. Read tokens call it; the anomaly alert's page and feedback are session-only |
| `GET /what-changed/learning?cluster=<id>` (0.9.4; Pro only, session) | The learning state alone, as `GET /what-changed`'s `learning` (ADR-216): `{learning, since, until, day, hoursLearned, hoursTotal, week, resumedAt, series: {total, learning, readyAt, breakdown}, emailWhenReady}`, by the worker's own rule (ADR-217); single-row reads |
| `PUT /what-changed/ready-email` (0.9.4; Pro only, session, every role) | `{cluster, enabled}`: the signed-in member's own "email me when it's ready"; 409 once the cluster has finished learning, or while the address is unverified |
| `POST /query/range` | Curated metric query: `{clusterId, metric, scope?: {host?, container?, composeProject?}, agg?, step?, from, to}` (unix seconds); `metric` is one of the catalog keys in `backend/src/modules/query/catalog.ts` (16 in Phase 1) → backend builds MetricsQL with tenant filter. Raw MetricsQL only for P1 advanced mode. |
| `GET/POST/PATCH/DELETE /alert-rules` | |
| `GET/POST/PATCH/DELETE /alert-channels` · `POST /alert-channels/:id/test` | |
| `GET /alerts` (firing & history) · `POST /silences` | `GET /alerts/:id` lists the messages sent for the alert; each carries `withCause: true` when it had the likely cause line (ADR-157) |
| `POST /funnel` | Client-side funnel events (§10.4) |
| `GET/POST /api-tokens` · `DELETE /api-tokens/:id` | Personal API tokens (§4.11): list, create (value shown once), revoke; session only, never with a token |
| `POST /mcp` | MCP server, Streamable HTTP (§4.11); read token. 401 with `WWW-Authenticate: Bearer` without one; `GET` and `DELETE` (2025 session operations) answer 405 |
| `POST /demo/session` | Demo mode only (ADR-122): a passwordless, read-only viewer session (a signed cookie, no row); 404 otherwise |

## 8.2 Ingest API (agent → backend)

| Method & path | Body | Notes |
|---|---|---|
| `POST /ingest/v1/write` | Prometheus remote_write (protobuf + snappy) | Backend validates token, injects `cluster_id`/`tenant_id`, enforces series limits, forwards to VictoriaMetrics |
| `POST /ingest/v1/heartbeat` | `{agent_version, mode, node, capabilities:{ebpf, cgroup}, series}` | Updates `clusters.last_seen_at`; triggers onboarding SSE |
| `POST /ingest/v1/objects` | `{snapshot|delta, objects:[...]}` (JSON, gzip) | |
| `POST /ingest/v1/events` | `{events:[{uid, namespace, involved:{kind, namespace, name, uid}, type, reason, message, count, first_ts, last_ts, reporting_controller}]}` (≤ 1,000 per request, JSON, gzip) | ADR-061 |
| `GET /ingest/v1/logs/requests?wait=25` | — | Logs on demand (ADR-167): the cluster-agent's leader or a Docker host's agent long-polls for log requests; answered at once when one arrives, `204` after `wait` |
| `POST /ingest/v1/logs/:requestId` | `{lines:[{ts, stream?, text}], done, error?}` (redacted in the agent) | Relayed to the waiting reader and dropped; `410` when the reader left, which ends a follow |

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
- Site analytics: Microsoft Clarity on the marketing site only, loaded only after the visitor accepts, form fields masked, never on token pages; never in the product (ADR-119). UTM parameters captured into `users.signup_source` on signup.

# 10. Signup and onboarding — Cloud (shipped in 0.6.0; ADR-175, ADR-176, ADR-179)

The onboarding flow is the most important part of the product. Every step has a target time. Signup, the sample link, the first-week checklist, funnel events and lifecycle emails are Cloud only; the live connection checklist (step 4) also helps Community's "Add cluster" (ADR-176).

## 10.1 Signup — target ≤ 60 s

- Fields: email, password (min 10 chars; a checklist under the field ticks as you type: the length, and not in known leaked passwords, checked with k-anonymity). Or **Continue with GitHub** / **Continue with Google** (both in 0.6.0).
- No company name, no phone, no credit card. Email verification link is sent but **does not block** onboarding (verify within 7 days to keep the account).
- Cloudflare Turnstile on signup, password sign-in and reset; signups limited per IP and email domain; disposable domains refused.
- Optional TOTP 2FA with recovery codes, required for Owners of paid orgs (ADR-175).
- After signup → straight to "Add your first cluster". The signup creates an org (renamable) on the Free plan; a user may belong to several orgs.

## 10.2 Add cluster wizard — target ≤ 3 min

1. **What do you want to monitor?** Two large cards: *Kubernetes cluster* · *Docker host(s)*.
2. **Name it** (pre-filled `my-cluster`).
3. **Install** — the screen shows the exact command with the token already embedded and a copy button. Tabs: Helm · kubectl manifest (`kubectl apply -f https://.../install.yaml?code=wl_ic_...`: a separate install code valid 24 hours, never the cluster token in a URL, ADR-176) · Docker run · Docker Compose snippet.
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

**While waiting:** "Look around a sample organisation" opens the read-only live demo in a new tab (no demo data is copied into Cloud). **After the first data:** a first-week checklist on the overview (connect a channel, invite a teammate, connect an application, try MCP, see your first explained problem), each step a funnel event (ADR-176).

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
| `email_verified`, `second_cluster_added`, `teammate_invited`, `application_connected`, `mcp_first_call`, `sample_opened`, `pro_started` | As named (ADR-179) |

An internal admin page (`/admin/funnel` in the Cloud admin, which grows from the waitlist's admin panel) shows conversion between steps per week; the product exposes it through an internal admin API on the Compose network only (ADR-179).

**Lifecycle emails (Cloud):** plain text from the founder, one-click unsubscribe, at most one a day: welcome; 1 h after signup without heartbeat → "Need help installing?" with the troubleshooting link; the first alert explained; day 3 with data → tips; near a Free limit; the beta-to-billing notice 14 days ahead (ADR-179).

# 11. Design system: dark and light

The marketing site is dark only (§9). The dashboard has a dark and a light theme (0.12.0, ADR-228): each user picks **System** (the default: it follows the computer's setting, live), **Light** or **Dark** in the account menu, never in the sidebar. The choice is saved on the user and kept in the browser, so the first paint is already in the right theme. Dark looks exactly as before 0.12.0. All colours come from CSS custom properties (tokens), so the light theme is a second block of values in `tokens.css` (`:root[data-theme='light']`), not a second set of components.

## 11.1 Colour tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0E0F11` | `#F6F7F9` | Page background |
| `--surface-1` | `#15171A` | `#FFFFFF` | Cards, panels |
| `--surface-2` | `#1B1E22` | `#F1F3F5` | Hover, nested panels, table header |
| `--surface-3` | `#22252A` | `#E6E9ED` | Inputs, active rows |
| `--border` | `#2A2E34` | `#E2E5E9` | Borders, dividers |
| `--border-strong` | `#3A3F46` | `#C4CAD1` | Focused inputs, separators |
| `--text` | `#E8EAED` | `#111418` | Primary text |
| `--text-muted` | `#9BA1A9` | `#5B6470` | Secondary text, labels |
| `--text-subtle` | `#6B7179` | `#6B7480` | Placeholders, disabled |
| `--primary` | `#22C55E` | `#15803D` | Brand green: primary buttons, active nav, focus ring |
| `--primary-hover` | `#16A34A` | `#166534` | Primary hover / pressed |
| `--primary-soft` | `rgba(34,197,94,0.12)` | `rgba(21,128,61,0.10)` | Selected backgrounds, badges |
| `--primary-glow` | `rgba(34,197,94,0.35)` | `rgba(21,128,61,0.28)` | Hero glow (site only), focus halo |
| `--primary-border` | `rgba(34,197,94,0.40)` | `rgba(21,128,61,0.35)` | Borders in the brand colour |
| `--on-primary` | `#04140A` | `#FFFFFF` | Text on green buttons |
| `--on-critical` | `#E8EAED` | `#FFFFFF` | Text on the red (danger) button |
| `--ok` | `#22C55E` | `#16A34A` | Healthy status: dots, bars, borders, chart fills |
| `--warning` | `#F5A524` | `#D97706` | Warning (fills) |
| `--critical` | `#F04438` | `#DC2626` | Critical / error (fills) |
| `--info` | `#3B9EFF` | `#2563EB` | Informational (fills) |
| `--ok-text` | `#22C55E` | `#15803D` | Healthy status as text |
| `--warning-text` | `#F5A524` | `#92400E` | Warning as text |
| `--critical-text` | `#F04438` | `#B91C1C` | Critical / error as text |
| `--info-text` | `#3B9EFF` | `#1D4ED8` | Informational as text |
| `--link` | `#22C55E` | `#15803D` | Links and other text in the brand colour |
| `--shadow` | faint | faint | The selected segment of a segmented control |
| `--shadow-lg` | soft | soft | Menus and popovers |

**Text vs fill (ADR-228):** the status colours are bright enough for text on a dark surface but not on white, so text uses the `*-text` tokens and `--link` (WCAG AA, 4.5:1 on `--bg` and `--surface-1` in both themes; `packages/design-tokens/test/tokens.test.ts` checks every pair), and dots, bars, borders and chart series keep the base tokens. In dark both are the same value.

**Status vs brand:** because the brand colour is green and "healthy" is green, status MUST never rely on colour alone — always pair with an icon and label (✓ Healthy, ▲ Warning, ✕ Critical).

**Chart palette** (series order, tested on `--surface-1`): dark `#22C55E`, `#3B9EFF`, `#F5A524`, `#A78BFA`, `#2DD4BF`, `#F472B6`, `#FB923C`, `#94A3B8`; light `#16A34A`, `#2563EB`, `#D97706`, `#7C3AED`, `#0D9488`, `#DB2777`, `#EA580C`, `#64748B`. Grid lines `--border`, axis labels `--text-muted`. Charts and the service map read the tokens when they draw and draw again when the theme changes.

## 11.2 Typography

- UI: **Inter** (variable), 14 px base in the app, 16 px on the site.
- Code and metric values: **JetBrains Mono**, tabular numbers (`font-variant-numeric: tabular-nums`) everywhere numbers update.
- Scale: 12 / 13 / 14 / 16 / 20 / 24 / 32 / 48 / 64 px. Headings 600 weight, body 400.
- 11 px is a step for two uses only: uppercase micro-labels (section labels with letter-spacing, e.g. filter headings) and chart axis labels. Everything else uses 12 px or more (ADR-115).

## 11.3 Layout and components

- App shell: left sidebar (240 px, collapsible to 64 px) with cluster switcher at top; top bar with time range, namespace filter, search (the ⌘K command palette).
- **Navigation (0.13.0, ADR-230):** All clusters and fleets, Overview, Nodes (Servers), Workloads with no label; then **Running here** (Applications, Certificates, Scheduled jobs) and **Investigate** (Events, What changed, Service map, Egress), each under a micro-label; Alerts and Settings after a divider. Certificates and Scheduled jobs carry a badge with the number of items that need a look and an accessible name: amber for certificates expiring within 14 days; red for an expired one, one under 3 days, a certificate problem, or a job failing, missed or slow. The collapsed rail shows a dot; the phone drawer shows the same groups.
- **⌘K command palette (v0.5, shipped in 0.5.0; ADR-169):** ⌘K / Ctrl+K, `/` outside a field (on list pages `/` focuses the page's filter), or the top bar's search button. Finds pages, clusters and Docker fleets, and the selected cluster's workloads, pods and nodes (Kubernetes), hosts, containers and Compose projects (Docker), applications, certificates and scheduled jobs (0.10; from 0.13.0 with their icon and a status line: "expires in 9 days · Ingress shop/api", "Failing · every hour at :40") (`GET /clusters/:id/search`: letters in order, one typo as a fallback, exact and prefix matches first, 8 per kind; groups ordered by their best match). The last five picks show before typing. A modal dialog with an ARIA combobox and a grouped listbox (Reka UI): ↑ ↓, Enter, Esc returns focus; the result count in a live region; full screen on phones, 44 px targets. Read-only navigation.
- Phones and tablets (ADR-120): below 1024 px the sidebar is an off-canvas drawer and the cluster switcher sits in the top bar; below 768 px the cluster, filters and time range share one sheet, wide tables become cards and pickers open as sheets. Touch targets are at least 44 px; no page scrolls sideways.
- Radius: 6 px (inputs, buttons), 10 px (cards). Spacing scale 4 px base.
- Components (built in `web/src/components/ui`, Tailwind-based, no heavy UI kit): Button (primary / secondary / ghost / danger), Input, Select, Combobox, Tabs, Table (virtualised for > 500 rows), Card, StatTile, Badge/StatusPill, Tooltip, Drawer, Modal, Toast, EmptyState, CodeBlock with copy, TimeRangePicker, Sparkline, TimeSeriesChart (ECharts), ServiceMapGraph (ECharts graph or Cytoscape.js — decide in Phase 4).
- Empty states always explain what to do next, never just "No data".
- Accessibility: WCAG AA contrast on all text tokens, visible focus ring (`2px solid var(--primary)`; no glow in the app), full keyboard navigation.

## 11.4 Tailwind configuration

Tailwind theme maps directly to the tokens (`colors.bg = 'var(--bg)'`, etc.). Shared token file `packages/design-tokens/tokens.css` is imported by `web/` and copied into the marketing site at build time (§9); the site sets no `data-theme`, so it stays dark.

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

## Phase 5 — Cloud and launch (≈ 3-4 weeks) — Cloud beta in 0.6.0, before the launch (shipped in 0.6.0; ADR-173)

Brought forward on 2026-11-13: the Cloud opens as a beta by invite from the waitlist (Free, and Pro free during the beta), released as 0.6.0. Billing is built and tested but stays off until the payment entity exists. Decisions: ADR-173 (scope, the `WATCHLOG_EDITION` switch), ADR-174 (tenancy), ADR-175 (accounts), ADR-176 (onboarding), ADR-177 (plans and limits), ADR-178 (billing), ADR-179 (funnel, emails, admin, support mode), ADR-180 (hosting on the current server), ADR-181 (security baseline), ADR-182 (the isolation suite).


- Multi-tenancy (§5.4), signup / login / GitHub OAuth, orgs, invites, onboarding wizard with live checklist (§10), funnel tracking and admin funnel page, lifecycle emails.
- The marketing site on `watchlog.io` (landing, pricing, docs, blog), in its private repository (§9).
- Plan limits (Free: 1 cluster, 5 nodes, 3 d). Stripe billing (per node with a minimum, p95 node count, Customer Portal; the amounts are §3.3's) in the private Cloud repository.
- Production deployment on the current server with Docker Compose behind the host's nginx (§5.5), backups, monitoring by WatchLog itself.
- Security: RLS, the SSRF egress policy, 2FA, Turnstile, data export and deletion, an audited support mode, an independent review against OWASP ASVS L2 (ADR-181).
- Trust pages on the site: terms, privacy, DPA, subprocessors, security, status (drafts for a lawyer's review).

**Accept when:** a new user goes from landing page to data on a kind cluster in under 5 minutes without reading docs (test with 5 real people, record times); funnel page shows every step; the isolation suite passes in CI on every push; gross margin ≥ 70 % at $1/node, measured.

## Phase 6 — Pro features (≈ 4 weeks)

- Multi-cluster overview, 30-day retention tier, SLO reports, basic anomaly detection (§4.8). The multi-cluster overview shipped in 0.11.0 as All clusters and fleets (ADR-226). Basic anomaly detection comes first, alone, as What changed in 0.8.0 (the owner's choice on 2026-11-15, ADR-195). Roles came in v0.3 (Community, ADR-140); right-sizing hints and logs on demand in v0.5 (Community, ADR-167, ADR-168).

## Phase 7 — Enterprise (as demand appears)

- `ee/`: SSO (OIDC/SAML), LDAP, fine-grained RBAC, audit log, offline license keys, air-gapped install guide, HA Helm values, advanced anomaly correlation. **Offline licence keys: done in 0.15.0** (ADR-232): `wl1.` keys signed with Ed25519 and checked offline against built-in public keys, Settings → License or `WATCHLOG_LICENSE`, every Pro feature self-hosted, `ee/` loading and the "core without ee" CI job. Network devices (the first real `ee/` module) come next.

# 14. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Overview page loads < 1.5 s (p95) for a 100-node cluster; chart queries < 500 ms (p95) for 24 h range |
| Scale (Cloud v2.0) | 2,000 nodes total, 500 nodes per cluster |
| Availability (Cloud) | 99.5 % monthly for UI/API; ingest buffered by agents so short outages lose no data |
| Security | OWASP ASVS L1 (Cloud: L2, ADR-181); argon2id password hashing; CSRF protection on cookie auth; rate limits on auth endpoints; channel secrets encrypted at rest; dependency scanning (Dependabot, `govulncheck`, `pnpm audit`) in CI; signed container images (cosign) |
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
