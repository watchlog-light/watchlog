---
title: Nginx
description: Monitor Nginx and ingress-nginx on Kubernetes and Docker with WatchLog: requests, 5xx, latency and upstreams from eBPF with nothing to set up, ingress-nginx's own metrics, and connections from stub_status.
---

# Nginx

WatchLog finds Nginx, OpenResty and ingress-nginx from the images and ports your agents
already see, on Kubernetes clusters and Docker hosts. Open **Applications** and press
**Monitor**: Nginx needs no user or password.

## What it needs

- **Requests, 5xx and latency: nothing.** The node agents see each plain-HTTP request and
  response on the wire with eBPF (the first 16 bytes of each message: the method and the
  status line, never a path, header or body). That works for any Nginx, any version, with
  no configuration. HTTPS is never decrypted, so a server that only speaks TLS shows its
  connections, not its requests.
- **ingress-nginx: its metrics.** The controller serves them on port 10254 only with
  `--enable-metrics`, which its Helm chart turns on with `controller.metrics.enabled`. When
  they're off, WatchLog says so on the page and gives the command for your install:

  ```bash
  helm upgrade <release> ingress-nginx/ingress-nginx -n <namespace> --reuse-values \
    --set controller.metrics.enabled=true
  ```

  or, for an install from the static manifests, a `kubectl patch` that adds the flag. The
  controller pods restart. Until then, requests, errors and latency come from eBPF. The
  controller drops request metrics for hosts no Ingress names; WatchLog reads what it
  serves.

- **Connections (plain Nginx): stub_status.** Add this to the configuration and reload:

  ```nginx
  server {
      listen 8080;
      location = /stub_status {
          stub_status;
          allow 10.0.0.0/8;
          allow 172.16.0.0/12;
          allow 192.168.0.0/16;
          allow 127.0.0.1;
          deny all;
      }
  }
  ```

  WatchLog looks for `/stub_status` and `/nginx_status` on port 8080 and on the service's
  own port. While it is missing it looks again every minute for the first 10 minutes, then every 10 minutes; that's the only request it
  makes to Nginx, and the page shows the snippet.

## What you see

| Tab         | What it shows                                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | Requests per second and their peak, the 5xx share over 15 minutes, p95 (and p50), active and waiting connections, upstreams ready out of all, bandwidth out (ingress-nginx); requests by status class; p50, p95 and p99; the busiest upstreams |
| Errors      | 5xx per second by upstream; the status codes of the last hour; error bursts: periods where an upstream answered 5 % 5xx or more, marked "during rollout" when its workload had just been rolled out                                            |
| Latency     | The request duration histogram; the slowest upstreams by p95; p95 by upstream over time                                                                                                                                                        |
| Connections | Waiting, reading and writing connections; accepted and dropped connections per second                                                                                                                                                          |

**Upstreams** are the backend Services of your Ingresses (ingress-nginx), or the workloads
and containers Nginx connects to (eBPF). An upstream is ready when its Service has a ready
endpoint (Kubernetes), or when connections to it don't all fail (Docker).

## What WatchLog tells you

The 5xx share, with the upstream that sends most of them and when it was last rolled out;
an upstream with no ready endpoint; a high p95; dropped connections (`worker_connections`
reached); a certificate that expires within 14 days (ingress-nginx); and the setup hints
above.

## Default alerts

Created when you start monitoring; the drawer's ticks decide which start on.

- More than 5 % of requests answer 5xx for 5 minutes (critical)
- p95 above 1 s for 5 minutes (warning)
- An upstream without a healthy endpoint (critical)
- A certificate expires within 14 days (warning, ingress-nginx)
- The service unreachable, or slow to connect (every service has these)

## Not available

- **Request paths:** WatchLog never reads them (only the method and the status line).
- **499:** Nginx logs it when a client gives up, but never sends it. ingress-nginx's
  metrics have it; eBPF sees only codes on the wire.
- **`$request_time` for plain Nginx:** eBPF measures from the request to the first byte
  of the response.
- **Upstream health checks:** an NGINX Plus API. WatchLog uses the Service's ready
  endpoints and connect failures instead.
- **Certificates of plain Nginx:** TLS ends inside Nginx and WatchLog doesn't read its
  files, so there is no expiry alert for it.
