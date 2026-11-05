# deploy/

| Path                      | Contents                                                          | Phase    |
| ------------------------- | ----------------------------------------------------------------- | -------- |
| `docker/compose.dev.yaml` | Local dev infrastructure: PostgreSQL 16, VictoriaMetrics, Redis 7 | 0 (done) |
| `docker/compose.yaml`     | Self-hosted Community stack for Docker hosts (SPEC §5.3)          | 1        |
| `helm/watchlog/`          | Full self-hosted Helm chart (SPEC §5.3)                           | 2        |
| `helm/watchlog-agent/`    | Agent-only Helm chart for WatchLog Cloud                          | 2        |
| `cloud/compose.yaml`      | Cloud production stack on one Ubuntu server (SPEC §5.5)           | 5        |
