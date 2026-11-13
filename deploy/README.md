# deploy/

| Path                      | Contents                                                          | Phase    |
| ------------------------- | ----------------------------------------------------------------- | -------- |
| `docker/compose.dev.yaml` | Local dev infrastructure: PostgreSQL 16, VictoriaMetrics, Redis 7 | 0 (done) |
| `docker/compose.yaml`     | Self-hosted Community stack for Docker hosts (SPEC §5.3)          | 1        |
| `helm/watchlog/`          | Full self-hosted Helm chart (SPEC §5.3)                           | 2        |
| `helm/watchlog-agent/`    | Agent-only Helm chart for WatchLog Cloud                          | 2        |

WatchLog Cloud runs these same images. Its production Compose kit is kept privately with the billing service (SPEC §5.5, ADR-180); everything the product itself needs, Cloud mode included, is in this repository.
