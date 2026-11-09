# Security: what the WatchLog agent can access

Status: Docker mode (Phase 1) and Kubernetes (Phase 2, in progress) are implemented as described below.
This document MUST be updated in the same change whenever the agent's access changes (SPEC §15.1).
The public `/security` page on the site is generated from the same facts.

## Principles (SPEC §6.6, §14)

- Read-only. The agent never executes remote commands and never writes to the cluster.
- Never collected, never sent: environment variable values, Secrets, ConfigMap data, request payloads, TLS contents.
- Agents push over HTTPS (TLS 1.2+); the backend never connects into customer clusters.

## Kubernetes — Phase 2

Two binaries (ADR-048): the **cluster-agent** (one replica, leader election) reads the Kubernetes API; the **node agent** (DaemonSet) reads its own node. Installed with the Helm chart `deploy/helm/watchlog-agent` (or as part of `deploy/helm/watchlog`); the test manifests `deploy/test/k8s/agents.yaml` use the same settings.

### Cluster-agent RBAC (ADR-052, ADR-060)

| Resource                                                      | Verbs               | Why                                                  |
| ------------------------------------------------------------- | ------------------- | ---------------------------------------------------- |
| nodes, namespaces, pods, persistentvolumeclaims               | get, list, watch    | Inventory, node and pod views                        |
| deployments, replicasets, statefulsets, daemonsets            | get, list, watch    | Workload views, change markers (ReplicaSets: owners) |
| jobs, cronjobs, horizontalpodautoscalers                      | get, list, watch    | Workload views                                       |
| events (`events.k8s.io`)                                      | get, list, watch    | Kubernetes events (SPEC §4.6)                        |
| services, endpointslices (`discovery.k8s.io`)                 | get, list, watch    | Service map: cluster IPs and the pods behind them    |
| tokenreviews (`authentication.k8s.io`)                        | create              | Authenticate node agents asking for their pod map    |
| leases (`coordination.k8s.io`), **own namespace only** (Role) | get, create, update | Leader election                                      |

No access to Secrets, ConfigMaps, `nodes/proxy`, Ingresses or PersistentVolumes. Services keep only type, cluster IPs, port numbers and names, selector and external name; EndpointSlices only addresses, readiness, node and the pod they point to (ADR-101). The cluster-wide IP map (`GET /v1/ipmap`, pod IPs → workloads, cluster IPs → Services, node IPs) is served only to node agents, authenticated like the pod map (ADR-066). Before caching, objects are trimmed (ADR-053): no `managedFields`, environment variables, `envFrom`, commands, args, probe or lifecycle commands, container termination messages or node image lists; annotations only from an allow-list (`deployment.kubernetes.io/revision`, `kubernetes.io/change-cause`, `kubernetes.io/config.mirror`).

### Node agent RBAC

| Resource      | Verbs | Why                                               |
| ------------- | ----- | ------------------------------------------------- |
| `nodes/stats` | get   | The node's own kubelet `/stats/summary` (ADR-049) |

The node agent never talks to the API server. It does not use the container runtime's CRI socket (read-write) or `nodes/proxy` (allows exec through the kubelet). Container names come from the cluster-agent's pod map.

### Node agent pod settings (ADR-060)

- `hostNetwork: false`, **`hostPID: false`**, runs as uid/gid 65532, `runAsNonRoot`, read-only root filesystem, `allowPrivilegeEscalation: false`, **all capabilities dropped, none added** (with eBPF: uid 0 with `BPF` and `PERFMON` only, see below), seccomp `RuntimeDefault`.
- Read-only hostPath mounts: `/proc` → `/host/proc` (host CPU, memory, disk and network counters), `/sys` → `/host/sys` (cgroups of the node's pods), `/` → `/host/root` (filesystem usage of local mounts). Because baseline PodSecurity forbids hostPath, the agent's namespace needs `pod-security.kubernetes.io/enforce: privileged` where PodSecurity admission enforces a stricter level (kind, k3s and kubeadm enforce nothing by default). The chart itself does not label the namespace (Helm's `--create-namespace` cannot); the install command shown in Settings creates the `watchlog` namespace and labels it `pod-security.kubernetes.io/enforce=privileged` in plain sight before `helm install`, and the chart's notes print the label command for installs without it (ADR-070). The agent itself needs no other privilege.
- Measured on kind: without `hostPID`, `cgroup.procs` of other pods shows no PIDs (the kernel translates PIDs into the reader's namespace), so sandboxes are recognised through the pod map instead of the process name; `hostPID` is not needed.
- emptyDir at `/var/lib/watchlog-agent` for the buffer and the cached pod map.

### Pod map (ADR-066)

- Served by the cluster-agent at `https://<release>-cluster-agent.<namespace>.svc:8443/v1/podmap`, TLS 1.2+. The chart generates a CA and the service certificate once (kept on upgrades) in the Secret `<release>-podmap-tls`; the cluster-agent mounts it, node agents mount only its `ca.crt` key. Neither agent has RBAC on Secrets: the kubelet mounts them.
- Node agents present a projected ServiceAccount token with audience `watchlog-cluster-agent` (1 h, rotated by the kubelet). The cluster-agent checks it with a TokenReview, requires the node agents' ServiceAccount, finds the node from the token's bound pod (or the `node-name` claim on 1.32+) and answers only with that node's pods: namespace, name, workload and container IDs → names. Reviews are cached 5 minutes (refusals 30 s).
- Pod UIDs and container IDs are used only to join; they are never metric labels.

### Kubelet connection (ADR-051)

`https://$HOST_IP:10250/stats/summary` with the node agent's ServiceAccount token, only to the node's own kubelet. `kubelet.tls: auto` (default) verifies against the cluster CA and falls back to an unverified connection only if verification fails; the heartbeat reports `kubelet_tls: verified | unverified`. Measured: k3s verifies; kind and kubeadm serve self-signed kubelet certificates (unverified). `verify` never falls back; `skip` never verifies.

### Data sent from Kubernetes

- Cluster-agent: object summaries (`POST /ingest/v1/objects`), events (`POST /ingest/v1/events`: involved object, reason, message, count, times), `watchlog_kube_*` state series (labels `namespace`, `pod`, `container`, `node`, `workload_kind`, `workload`, `qos_class`, condition/phase/reason/state; never UIDs, IPs or images). Pod IPs appear only in object summaries.
- Node agent: host series (`node` label), container series from cgroups and pod series from the kubelet summary (network, ephemeral storage, writable layer, PVC usage where the volume plugin reports it), with the labels above; `watchlog_agent_unmapped_containers_total` counts containers and pods it could not name.

## Linux capabilities (node agent) — Phase 4 (eBPF, ADR-099, ADR-105)

With `agent.networkFlows.enabled` (the default; ADR-107) the node agent container runs as **uid 0 with every capability dropped except `BPF` and `PERFMON`**, no privilege escalation (`no_new_privs`), a read-only root filesystem, seccomp `RuntimeDefault`, no hostPID and no hostNetwork. With eBPF disabled it runs as uid 65532 with no capabilities, as in Phase 2.

| Capability     | Why                                                                                      | Status                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BPF`          | Create the flow maps and load the programs (`bpf()`)                                     | **used** with eBPF                                                                       |
| `PERFMON`      | Load tracing programs (BTF raw tracepoints, fentry/fexit) that read kernel socket fields | **used** with eBPF                                                                       |
| `SYS_RESOURCE` | Raise the memlock limit for maps on kernels before 5.11                                  | not used: measured unnecessary on 6.8 (maps are charged to the memory cgroup since 5.11) |
| `SYS_PTRACE`   | —                                                                                        | not used: connections are attributed by cgroup id, not by `/proc/<pid>` (ADR-099)        |
| `NET_ADMIN`    | —                                                                                        | not used: no socket filter or tc program                                                 |

**Why uid 0:** Linux gives capabilities added to a non-root process only through ambient capabilities, which Kubernetes cannot set. File capabilities on the binary would need `allowPrivilegeEscalation: true`. Measured on kernel 6.8: as uid 65532 with `BPF` and `PERFMON` added, the effective set is empty and map creation fails with EPERM; as uid 0 with only those two, the programs load and attach under the runtime's default seccomp profile. Mounts stay read-only, and without `DAC_OVERRIDE` root still cannot write host files.

**What the programs read:**

- **TCP:** the socket's destination address and port, its local port and state (to adopt connections open before the agent started, ADR-108), its state changes, retransmits and the byte counts passed to `tcp_sendmsg` and `tcp_cleanup_rbuf`. Never TCP payloads. Counters are aggregated in the kernel per (cgroup, destination, port) and drained every 15 s; there is no per-connection event stream.
- **DNS (UDP port 53):** the 12-byte header of each response for the outcome (NOERROR, NXDOMAIN, SERVFAIL, timeout).
- **DNS answers (ADR-104):** a successful response with answers is copied, at most 512 bytes of the DNS message, to the agent. The agent reads only the question name and the A, AAAA and CNAME answer records, to name the external destinations that container then connects to. The names stay in agent memory, capped at 10,000 entries, for the record's TTL (at least 60 s, and while connections to that address continue). They are never written to disk and never sent except as an external edge's destination label, such as `api.stripe.com:443`. The message bytes are dropped after parsing; other record types are only skipped.
- **DNS search-path misses (ADR-113):** an NXDOMAIN response is copied up to the end of its question, at most 272 bytes. The agent reads only the question name, checks whether it ends in one of the search domains from the agent's own `/etc/resolv.conf`, and counts it. The name is not kept.
- **Never:** HTTP or other application payloads, and no TLS inspection, ever.

The BPF programs are licensed `GPL-2.0-only OR MIT` and declare "Dual MIT/GPL": the kernel requires a GPL-compatible licence for the helpers they use, and the MIT side keeps the object compatible with the agent's AGPL-3.0 licence (ADR-105).

## Docker mode — Phase 1, eBPF in Phase 4

The install command shown in Settings → Clusters (`backend/src/modules/clusters/install.ts`, ADR-023, ADR-105):

```bash
docker run -d --name watchlog-agent --restart unless-stopped \
  --pid host \
  --user 0:65532 --cap-drop ALL --cap-add BPF --cap-add PERFMON \
  --security-opt no-new-privileges \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro,rslave \
  -v watchlog-agent-state:/var/lib/watchlog-agent \
  -e WATCHLOG_TOKEN=<token> -e WATCHLOG_ENDPOINT=<endpoint> \
  ghcr.io/watchlog-light/agent:<version> --mode=docker
```

| Setting                                                         | Why                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--user 0:65532 --cap-drop ALL --cap-add BPF --cap-add PERFMON` | eBPF network flows need BPF and PERFMON, which Linux makes effective only for uid 0 (ADR-105). Every other capability, including Docker's default set, is dropped; no `--privileged`. Group 65532 owns the data volume (mode 0770); uid 0 owns the Docker socket |
| `--security-opt no-new-privileges`                              | No privilege gain through setuid binaries or file capabilities                                                                                                                                                                                                   |
| `docker.sock:ro`                                                | Only `/_ping`, `/version`, container list/inspect/stats and `/events` are called (ADR-024)                                                                                                                                                                       |
| `/proc`, `/sys` read-only                                       | Host and container metrics                                                                                                                                                                                                                                       |
| `/` → `/host/root` read-only                                    | `statfs` of host filesystems and the host's `/etc/hostname` (inside the container `/proc/sys/kernel/hostname` is the container's own name); files readable without `DAC_OVERRIDE` only                                                                           |
| `--pid host`                                                    | Required: without it the mounted `/proc` shows only the container's processes, and `/host/proc/1/net/dev` and `/host/proc/1/mountinfo` would describe the container, not the host                                                                                |
| named volume `watchlog-agent-state`                             | On-disk buffer when the backend is unreachable (ADR-022)                                                                                                                                                                                                         |

Measured on Ubuntu 24.04 (Lima VM, kernel 6.8, cgroup v2) by running the exact generated command (Phase 4): eBPF flows enabled with byte counts, the buffer volume writable, container metrics from the Docker socket; every mount above is used. Without BPF and PERFMON the agent reports `ebpf: unsupported` with the reason and everything else works. An install made before Phase 4 used the volume `watchlog-agent-data` (mode 0755, which uid 0 without `DAC_OVERRIDE` cannot write); the command uses a new volume, so re-running it is the whole upgrade (ADR-107). Docker socket reads are verified with the Docker client in slice 6.

## Integrations collector — v0.3 (ADR-131, ADR-133, ADR-134)

A third binary and image, `integrations`, reads the services monitored on the Applications page. The node agent and the cluster-agent are unchanged: no database clients, no Secrets.

- **What it runs:** for each kind of service, a fixed list of read-only statements or commands in the code (`agent/internal/integrations/`). The backend sends targets (addresses and, where needed, a credential), never statements. PostgreSQL sessions are opened with `default_transaction_read_only` and short statement and lock timeouts. One connection per member, 5 s per call; heavy views every 30 s.
- **Kubernetes** (`templates/integrations.yaml`): one Deployment, uid 65532, `runAsNonRoot`, every capability dropped, read-only root filesystem, an emptyDir buffer. Its ServiceAccount has no binding by default. For a password kept in the user's own Secret in the release namespace, WatchLog shows a Role with `get` on that one Secret (`--resource-name`) and its RoleBinding; the collector reads it through the API with its ServiceAccount token.
- **Docker:** one container per host that runs a monitored service: `--network host` to reach the containers' bridge addresses; `--user 0:0` with `--cap-drop ALL` to read root-owned `0600` files under `/etc/watchlog/secrets/` (mounted read-only); `--read-only`, a tmpfs buffer, `no-new-privileges`. No Docker socket.
- **Credentials:** generated or entered passwords are AES-256-GCM encrypted with `WATCHLOG_SECRET_KEY` (ADR-079), bound to their row with associated data (the service's or probe's id), write-only in the API. They are sent only to the collector of the service's cluster and host, over the config endpoint (`Cache-Control: no-store`), kept in memory (`Credential` and `Auth` print as `redacted`), never logged. Changes are recorded in `integration_events` (who, when, IP) without the value; Viewers see the log without IPs.
- **Connection tests (probes):** the connect drawer stores a probe (`integration_probes`) with the access to try, sealed the same way. The collector tries it every 5 s for 15 minutes, or at once on "Check now", and posts the outcome to `/ingest/v1/integrations/probes` (error text, version, a few facts, privileges beyond what's needed); only its own pending probes are updated. When the service is monitored, the sealed password is re-encrypted for the service's row and the probe is deleted.
- **Secret and file references:** on Kubernetes the collector's namespace and ServiceAccount come from the downward API (`WATCHLOG_POD_NAMESPACE`, `WATCHLOG_SERVICE_ACCOUNT`) and are reported in its status, so the Role commands name them. It reads `GET /api/v1/namespaces/<ns>/secrets/<name>` with its token, without client-go; 403 and 404 come back as the fix to run. On Docker, a password file must be a plain name directly under `/etc/watchlog/secrets` (no path, no dot file). Read passwords are kept in memory for a minute.
- **Starting it on Docker:** the service page shows the `docker run` command for a host without a collector. It takes `WATCHLOG_TOKEN` from the host's `watchlog-agent` container with `docker inspect`, so no token is shown or stored.
- **Network:** push only, like the agents (config long-poll, remote_write, status). The backend never connects into a cluster.

## Agent tokens

- Format `wl_ct_` + 256 random bits; the backend stores only SHA-256 and an 8-character prefix (ADR-025). The value is shown once.
- Rotation: issue a new token, update agents, revoke the old one (ADR-040). Revoked tokens are rejected immediately on the revoking backend.
- Tokens are passed to the agent as an environment variable; the agent never logs them.

## Data sent to the backend

Every 15 s, over HTTPS with `Authorization: Bearer <cluster token>`:

- `POST /ingest/v1/write` (remote_write, snappy): host metrics `watchlog_node_*` (CPU time by mode, CPU count, memory, load, disk I/O bytes per whole disk, network bytes per physical interface, filesystem size/free/avail per local mount) and the agent's own `watchlog_agent_*` metrics. Every series carries a `host` label (the host's `/etc/hostname`). No process names, command lines, environment variables, file contents or IP addresses.
- `POST /ingest/v1/heartbeat` (JSON): `agent_version`, `mode`, `node` (host name), `capabilities` (`ebpf`; when not enabled or partly enabled, `ebpf_reason` and the code `ebpf_cause`; `cgroup`; the Helm release and chart names the chart passes in, and a Docker agent's own container ID, so the UI can show the exact fix, ADR-107), `series` (count).
- Request header `X-WatchLog-Agent: <host name>` (rate-limit key, ADR-027).

- Container metrics (`watchlog_container_*`): state, health status, restart count, OOM events, start time, CPU seconds (and throttling, CPU limit), memory working set and limit, writable-layer size, block I/O bytes, network bytes, plus `watchlog_docker_info` (Docker version, kernel, OS, architecture). Labels: `host`, `container` (name), `image`, `compose_project`, `compose_service`. Never container IDs, IPs or ports as labels.
- `POST /ingest/v1/objects` (gzipped JSON, when it changes or every 10 minutes, and as a delta of one container right after a `die`, `oom` or `health_status` event): Docker version, OS, kernel and architecture of the host; for each container its ID, name, image, state and status text, health, restart count, exit code, OOM flag, daemon error message (`State.Error`), creation, start and finish time, published ports, Compose project/service and writable-layer size. For containers with a health check: status, failing streak, the last five probes (start, end, exit code, output) and the check configuration (command, interval, timeout, start period, retries). **Never** the container's command line (`Config.Cmd`, `Path`, `Args`), environment variables, labels other than the two Compose labels, mounts or network settings.

### Health check commands and probe output (ADR-047)

The health check command and probe output are written by the image or Compose author and can contain credentials (`curl -u user:pass`, `Authorization:` headers, `?token=`). Before they leave the host, the agent:

- redacts passwords in `user:pass@` URLs and `-u`/`--user` values, `--password`/`--token`/`--secret`-style flags, `password=`/`token=`/`api_key=`-style pairs (query strings, `PGPASSWORD=…`), `mysql -p…` and `redis-cli -a …`, `Authorization`, `X-Api-Key` and `Cookie` header values, AWS access keys, GitHub and Slack tokens and JWTs (`agent/internal/redact`, table-driven tests). User names and shell variable references (`$DB_PASSWORD`) are kept;
- folds each probe output and the command onto one line and truncates it to 512 bytes; the daemon error message gets the same treatment.

Redaction is pattern-based and cannot recognise every secret. `WATCHLOG_HEALTH_OUTPUT=false` (or `--health-output=false`) sends probe exit codes and times only, never output; the check command is still sent, redacted. Docker's own `exec_create`/`exec_start` events contain the full health check command; the agent does not subscribe to them (the daemon filters them out).

### Docker socket use

Only these GET requests are possible; the client refuses anything else before sending (ADR-024, tested): `/_ping`, `/version`, `/containers/json` (every interval; with sizes every 10 minutes), `/containers/{id}/json` (only for new containers, after an event for that container, every minute while a container is unhealthy, or every 5 minutes), `/containers/{id}/stats` (not used yet) and `/events` (filtered by the daemon to start, die, oom, restart, destroy and health_status).

The inspect response (`/containers/{id}/json`) contains the container's environment variables; Docker has no way to omit them. The agent decodes only the fields it needs (restart count; `State`: status, PID, exit code, OOM flag, error, start and finish time, health; `Config.Healthcheck`); `Config.Env`, `Config.Cmd`, `Path` and `Args` are never decoded, stored, logged or sent. Inspect is called as rarely as possible for this reason.

## Network

- Outbound: HTTPS 443 to the ingest endpoint only.
- Inbound: `:8080/healthz` and `:8080/metrics` on the pod IP (Phase 1+). Nothing else.

## Alert channel secrets and the secret key (ADR-079)

- Slack webhook URLs, Telegram bot tokens and webhook signing secrets are stored encrypted with AES-256-GCM under `WATCHLOG_SECRET_KEY` (32 bytes). The API never returns them; it shows only that a secret is set.
- The same key encrypts the SMTP password and integration credentials (ADR-133).
- **Rotation:** run `node dist/rotate-secret-key.js` from the backend image with `WATCHLOG_SECRET_KEY_PREVIOUS` (the current key) and `WATCHLOG_SECRET_KEY` (the new one). It re-encrypts alert channel, SMTP, integration and probe secrets and the key check in one transaction, and refuses an old key that isn't this database's. Keep `WATCHLOG_SECRET_KEY_PREVIOUS` set until every backend and worker runs with the new key: they still decrypt with it meanwhile.
- **Back up this key together with the database.** Without it the stored channel secrets cannot be read. The backend and the alert-worker refuse to start when the key is missing or malformed, or when it cannot decrypt what is stored; they never generate a key themselves.
- Compose: set `WATCHLOG_SECRET_KEY` in `.env` (`openssl rand -base64 32`). Helm: the chart generates it once into Secret `<release>-secret-key`, keeps it across upgrades and on `helm uninstall` (`helm.sh/resource-policy: keep`); print it with `kubectl get secret <release>-secret-key -o jsonpath='{.data.key}' | base64 -d`, restore it with `--set secretKey=<key>`.
- The alert-worker (Compose service `alert-worker`, Helm Deployment `<release>-alert-worker`) runs from the backend image as the same non-root user, publishes no port (its `/livez` and `/readyz` on 4081 are for the healthcheck and the probes only) and is the only component that sends alert messages; the backend sends only "send test" messages and calls Telegram's `getMe`. Its outbound connections go to the configured channels: Slack, `api.telegram.org` (or `WATCHLOG_TELEGRAM_API_URL`), the SMTP server and webhook URLs.
- Outbound alert deliveries (Slack, Telegram, webhooks) honour `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`; the Telegram API base URL can be changed with `WATCHLOG_TELEGRAM_API_URL`. Webhook payloads are signed: `X-WatchLog-Signature: t=<unix>,v1=<HMAC-SHA256 of "<unix>.<body>">`, and `X-WatchLog-Delivery` is an idempotency key (a delivery can repeat after a crash, ADR-074).

## Community server (deploy/docker/compose.yaml)

- Only the web service publishes a port (8080 by default). Caddy in the web image serves the dashboard and forwards `/api/*` to the backend and `/ingest/*` (request bodies capped at 8 MB) for agents. PostgreSQL, VictoriaMetrics and the backend are reachable only on the internal Compose network.
- The PostgreSQL password and the secret key must be set in `.env`; there are no defaults. The first admin is created with a one-time setup code printed in the backend log (or `WATCHLOG_ADMIN_EMAIL`/`WATCHLOG_ADMIN_PASSWORD`).
- Plain HTTP by default: put a TLS-terminating proxy in front for anything beyond a trusted network (session cookies become `Secure` automatically behind HTTPS with `X-Forwarded-Proto`).

## Community server on Kubernetes (deploy/helm/watchlog)

- Backend, web, PostgreSQL (`postgres:16-alpine`) and VictoriaMetrics (official images, ADR-059), plus the agents. Only the web Service is meant to be exposed (port-forward, a LoadBalancer or the optional Ingress); PostgreSQL, VictoriaMetrics and the backend are ClusterIP Services.
- All pods run as non-root with seccomp `RuntimeDefault`, all capabilities dropped and no privilege escalation; backend, web and VictoriaMetrics also with a read-only root filesystem. Backend and web do not mount a ServiceAccount token.
- Generated once and kept on upgrades: the PostgreSQL password (Secret `<release>-postgresql`), the secret key for alert channels (Secret `<release>-secret-key`, also kept on uninstall) and the cluster token of this cluster's agents (Secret `<release>-cluster-token`). The backend stores only the token's SHA-256 hash and registers it after setup (ADR-069); the agents read it from the Secret through the kubelet.
- In-cluster agents push to the backend Service over plain HTTP inside the cluster network; agents of other clusters use the public URL.

## Container images

- Agent: `scratch` with only the static binary, CA certificates and a nonroot user entry; runs as uid 65532 (ADR-020). Backend: distroless Node.js 24, non-root. Web: Caddy, non-root.
- Signing with cosign and dependency scanning (Dependabot, govulncheck, pnpm audit) per SPEC §14. govulncheck, pnpm audit and gitleaks (full history) run in CI; the release workflow signs every image and chart with cosign, keyless (`.github/workflows/release.yml`).
