# WatchLog

**Open-source monitoring for Kubernetes and Docker.** Install one agent and see every node, pod and container, and the network between your services, in about five minutes. No PromQL, no dashboards to build.

![The service map: workloads and their live connections, grouped by namespace](docs/images/service-map.png)

## What you get

- **One install.** A Helm chart for Kubernetes, or one `docker run` per Docker host.
- **Ready-made views.** Cluster overview, nodes, workloads, pods with restart and OOM reasons, events, and Docker hosts and containers.
- **A service map without code changes.** eBPF shows who connects to whom, failed connections, connect latency, bytes and DNS errors. External services are named by DNS.
- **Alerts that work on day one.** Crash loops, OOM kills, node pressure, failing connections and more, sent to Slack, Telegram, email or webhooks.
- **A small, read-only agent.** Under 64 MB of memory and 1 % of a core. It never reads Secrets, ConfigMaps, environment values or payloads; see [what it can access](docs/site/security.md).
- **Self-hosted and free** for one cluster, under AGPL-3.0.

![The cluster overview: health from firing alerts, what needs attention, recent warnings](docs/images/overview.png)

## Install in five minutes

### Kubernetes

```bash
helm install watchlog oci://ghcr.io/watchlog-light/charts/watchlog --version 0.1.1 \
  --namespace watchlog --create-namespace
kubectl -n watchlog port-forward svc/watchlog-web 8080
```

Open http://localhost:8080 and enter the setup code from `kubectl -n watchlog logs deploy/watchlog-backend -c backend | grep "setup code"`. The cluster appears within a minute.

### Docker hosts

```bash
mkdir watchlog && cd watchlog
curl -fsSLO https://raw.githubusercontent.com/watchlog-light/watchlog/v0.1.1/deploy/docker/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/watchlog-light/watchlog/v0.1.1/deploy/docker/.env.example
# set WATCHLOG_DB_PASSWORD, WATCHLOG_SECRET_KEY (openssl rand -base64 32), WATCHLOG_PUBLIC_URL in .env
docker compose up -d && docker compose logs backend | grep "setup code"
```

Then add your hosts from **Settings → Clusters**: it shows the `docker run` command for each host.

The [install guide](docs/site/install.md) covers requirements, PodSecurity, more clusters, upgrades (never with manual steps) and uninstalling.

## Documentation

- [Install](docs/site/install.md) · [Configuration](docs/site/configuration.md) · [Security: what the agent can access](docs/site/security.md) · [FAQ](docs/site/faq.md)
- [Specification](docs/SPEC.md) and [architecture decisions](docs/DECISIONS.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

## Repository layout

| Path                      | What                                                    |
| ------------------------- | ------------------------------------------------------- |
| `agent/`                  | Go agent (node, cluster and Docker modes) and eBPF code |
| `backend/`                | Node.js 24 + TypeScript + Fastify API and alert worker  |
| `web/`                    | Vue 3 + Vite dashboard                                  |
| `packages/design-tokens/` | Colour tokens, Tailwind theme, logo                     |
| `packages/api-types/`     | API types shared with the dashboard                     |
| `ee/`                     | Enterprise modules (commercial licence)                 |
| `deploy/`                 | Docker Compose files, Helm charts and end-to-end tests  |
| `docs/`                   | Spec, decisions, security, user docs and release notes  |

## Development

Prerequisites: Node.js 24 (`.nvmrc`), corepack (`corepack enable` provides the pinned pnpm), Go 1.27, Docker, GNU Make.

```bash
pnpm i                # install JS dependencies
pnpm infra:up         # PostgreSQL 16, VictoriaMetrics, Redis 7 (waits until healthy)
pnpm dev              # backend (watch) on :4080 and dashboard on http://localhost:4088
make agent            # build the agent into bin/ and print its version
```

`pnpm dev` applies database migrations first, so run `pnpm infra:up` before it. On a fresh database the backend prints a one-time **setup code** in its log; open http://localhost:4088, enter the code and create the admin account. For headless installs, set `WATCHLOG_ADMIN_EMAIL` and `WATCHLOG_ADMIN_PASSWORD` instead.

| Service          | Local address                                           |
| ---------------- | ------------------------------------------------------- |
| Dashboard (Vite) | http://localhost:4088 (`WATCHLOG_WEB_PORT`)             |
| Backend API      | http://127.0.0.1:4080/api/v1/health                     |
| PostgreSQL       | `postgres://watchlog:watchlog@127.0.0.1:54320/watchlog` |
| VictoriaMetrics  | http://127.0.0.1:8428                                   |
| Redis            | `redis://127.0.0.1:63790`                               |

Infrastructure host ports can be changed with `WATCHLOG_PG_PORT`, `WATCHLOG_VM_PORT` and `WATCHLOG_REDIS_PORT`.

### Demo environment

Real data for the dev stack: one [Lima](https://lima-vm.io) VM with a kind cluster (`kind-demo`: the demo app in namespace `shop`, failing pods in `wl-test`) and a Docker host (containers that are unhealthy, exited, OOM-killed, crash-looping and CPU-limited, plus a small Compose app). Their agents are built from your checkout and report to `pnpm dev`.

```bash
mkdir -p ~/.config/watchlog && touch ~/.config/watchlog/demo.env && chmod 600 ~/.config/watchlog/demo.env
# In ~/.config/watchlog/demo.env, tokens from Settings → Clusters (a Kubernetes cluster and a Docker fleet):
#   WATCHLOG_DEMO_KUBE_TOKEN=wl_ct_…
#   WATCHLOG_DEMO_DOCKER_TOKEN=wl_ct_…
pnpm dev                          # in another terminal
deploy/test/demo-up.sh            # creates or updates the VM watchlog-demo; run it again any time
deploy/test/demo-down.sh          # removes the demo (add --vm to delete the VM too)
```

`VM=<name>` uses another Lima VM. Once installed, the agents keep their tokens, so the file can be removed. `GOPROXY` works as for `make images`.

### Checks

```bash
pnpm lint             # ESLint + type checks for all TS packages
pnpm test             # Vitest in every package (backend tests need `pnpm infra:up`)
pnpm api-types:generate  # regenerate packages/api-types after changing a route schema
pnpm format:check     # Prettier
pnpm check:license    # SPDX headers
make agent-lint agent-test
make images           # build agent, backend and web images locally (never pushed)
bash deploy/test/helm/upgrade-test.sh   # upgrades from older chart values
bash deploy/test/k8s/e2e.sh             # kind cluster: helm install and the acceptance checks
```

The agent image is built `FROM scratch` (ADR-020). If `gcr.io` is unreachable from your network, override the backend's distroless runtime image:
`make images BACKEND_RUNTIME_IMAGE=node:24-bookworm-slim`.
If `proxy.golang.org` is blocked, fetch the agent's Go modules through another proxy:
`GOPROXY=https://goproxy.io,direct make images` (the e2e script `deploy/test/k8s/e2e.sh` honours `GOPROXY` too).
CI keeps Go's default proxy. The eBPF objects are committed; regenerate them with `make bpf` after changing `agent/internal/ebpf/bpf/`.

## License

Everything outside `ee/` is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). The eBPF programs in `agent/internal/ebpf/bpf/` are dual-licensed `GPL-2.0-only OR MIT`, as the kernel requires a GPL-compatible licence. Code in `ee/` is under a separate commercial licence. Contributors sign the [CLA](CLA.md).

The WatchLog name and logo are trademarks and aren't covered by these licences. Forks you distribute need their own name and logo; saying "works with WatchLog" or "based on WatchLog" is fine. See [TRADEMARKS.md](TRADEMARKS.md).
