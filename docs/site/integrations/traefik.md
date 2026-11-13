---
title: Traefik
description: Monitor Traefik on Kubernetes (k3s's default ingress) and Docker with WatchLog: requests, 5xx and latency per entrypoint and service, TLS included, the backends with no server up, certificates and reloads, from Traefik's own metrics.
---

# Traefik

WatchLog finds Traefik from the images your agents already see: the official image, and
k3s's bundled one (`rancher/mirrored-library-traefik`), on Kubernetes clusters and Docker
hosts. Open **Applications** and press **Monitor**: Traefik needs no user or password.
Traefik 2.10 and later, and 3.x.

## What it needs

- **Traefik's Prometheus metrics.** WatchLog reads them where Traefik serves them:
  `:9100/metrics` (the `metrics` entrypoint of Traefik's Helm chart and of k3s's bundled
  Traefik, on by default), `:8080/metrics` (the default `traefik` entrypoint) or
  `:8082/metrics`. Nothing else is requested, apart from `/api/version` on `:8080` for the
  version when the API answers.
- **When they're off,** requests, errors and latency come from the node agents' eBPF (plain
  HTTP only), and the page gives the setting for your install:
  - k3s: a `HelmChartConfig` for the bundled chart:

    ```yaml
    apiVersion: helm.cattle.io/v1
    kind: HelmChartConfig
    metadata:
      name: traefik
      namespace: kube-system
    spec:
      valuesContent: |-
        metrics:
          prometheus:
            entryPoint: metrics
    ```

  - Helm: `helm upgrade <release> traefik/traefik -n <namespace> --reuse-values --set metrics.prometheus.entryPoint=metrics`
  - Docker and anything else, three flags:

    ```bash
    --entrypoints.metrics.address=:9100 --metrics.prometheus=true --metrics.prometheus.entrypoint=metrics
    ```

  WatchLog looks again every minute for the first 10 minutes, then every 10 minutes.

- **Docker 29 needs Traefik 3.6.1 or later.** Older versions' Docker provider speaks API
  1.24, which Docker 29 refuses, so Traefik routes nothing; WatchLog can't fix that.
- **Optional:** `--metrics.prometheus.addRoutersLabels=true` adds per-router numbers;
  health checks on a service (`loadbalancer.healthcheck.path`) add its servers up and down.

## What you see

| Tab                 | What it shows                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview            | Requests per second and their peak, the 5xx share over 15 minutes, p95 (and p50), open connections, services with a server up out of all, the soonest certificate expiry; requests by status class; p50, p95 and p99; the busiest services |
| Services            | Each service with its backend (workload or container), requests per second, 5xx share, p95, servers up and retries; 5xx by service over time; the slowest services by p95                                                                  |
| Entrypoints and TLS | Requests by entrypoint (`web`, `websecure`; which carry TLS), open connections by entrypoint, your certificates and when each expires, configuration reloads                                                                               |

**Backends.** Traefik names its services after where they come from. WatchLog maps them
back: `<namespace>-<service>-<port>@kubernetes` (an Ingress) is that Service and its
workload; `<namespace>-<route>-<hash>@kubernetescrd` (an IngressRoute) carries a hash in
place of the Service, so it is shown as the IngressRoute; on Docker,
`<service>-<project>@docker` is that Compose service's container, and a name set by a label
(`traefik.http.services.<name>…`) is matched to a container or Compose service of that
name.

## On the service map

The map's HTTP numbers come from eBPF on plain-HTTP connections. Traefik adds what eBPF
can't see, and never counts a request twice:

- **An edge from Traefik to a backend with no eBPF HTTP numbers** (TLS or HTTP/2 to the
  backend) gets Traefik's, marked "from Traefik".
- **Requests Traefik answered itself** because the backend has no server up ("no available
  server", 503) are shown on the edge to that backend: "12/s answered by Traefik: no server
  up". No connection is made, so nothing else sees them.
- **The Traefik node** shows each entrypoint's requests, 5xx and TLS requests, which no
  edge carries when clients come from outside the cluster.

## What WatchLog tells you

A service with no server up, with its backend linked (probable cause follows it to the
backend's own cause: scaled to 0, crashing, out of memory); the 5xx share, with the service
that sends most of them and its workload's last rollout; a high p95; a certificate that
expires within 14 days; a failed configuration reload (Traefik 2); and the metrics setting
above.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- More than 5 % of requests answer 5xx for 5 minutes (critical)
- p95 above 1 s for 5 minutes (warning)
- A service with no server up for a minute (critical)
- A certificate expires within 14 days (warning)
- The last configuration reload failed (warning, Traefik 2)
- The service unreachable, or slow to connect (every service has these)

## Not available

- **Request paths and hosts:** WatchLog never collects them.
- **Routers,** unless Traefik exports them (`addRoutersLabels`, off by default): services
  are the closest.
- **Servers up and down,** unless the service has a health check: WatchLog uses the
  Service's ready endpoints (Kubernetes) and the container's state (Docker) instead.
- **A failed reload on Traefik 3:** it no longer reports failures, only the last success.
- **A Docker container that stopped:** Traefik's Docker provider removes its route, so
  requests get a 404 from another route or none; WatchLog shows the container stopped, not
  a service with no server up.
