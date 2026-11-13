---
title: Configuration
description: Helm values, Docker Compose settings and agent options for WatchLog.
---

# Configuration

Defaults work for most installs. This page lists what you can change.

## Helm chart `watchlog` (server and agents)

| Value                                                                                              | Default                                 | What it does                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicUrl`                                                                                        | `''`                                    | The URL people use to open WatchLog, used in alert links and install commands.                                                                                                                          |
| `admin.email`, `admin.password`                                                                    | `''`                                    | Create the admin at install time instead of using the setup code.                                                                                                                                       |
| `secretKey`                                                                                        | generated                               | Key for stored secrets (32 bytes, base64). Set it only to restore a backup or rotate.                                                                                                                   |
| `secretKeyPrevious`                                                                                | empty                                   | The key before a rotation, while servers restart.                                                                                                                                                       |
| `clusterName`                                                                                      | `kubernetes`                            | Name of this cluster in WatchLog.                                                                                                                                                                       |
| `demoMode`                                                                                         | `false`                                 | A read-only public demo: visitors enter as a viewer without a password, and every change is refused, even for admins. Secrets, tokens and channel targets are never shown. Not for a real installation. |
| `mcp.enabled`                                                                                      | `true`                                  | The MCP server at `/mcp`, so AI assistants (Claude, Cursor) can read your clusters with a personal API token. It needs a token anyway; `false` turns it off, and tokens still read the REST API.        |
| `seed`                                                                                             | `{}`                                    | Alert rules created at every backend start, once each, matched by name and never overwritten; services to monitor once they're found; and a demo's public MCP token. See [Seed file](#seed-file).       |
| `cookieSecure`                                                                                     | `auto`                                  | The session cookie's Secure attribute: `auto` when the request came over https, or `always` or `never`. See [Behind a reverse proxy](#behind-a-reverse-proxy).                                          |
| `image.registry`, `image.tag`                                                                      | `ghcr.io/watchlog-light`, chart version | Where WatchLog images come from: use a mirror for air-gapped installs.                                                                                                                                  |
| `backend.replicas`, `backend.resources`                                                            | 1, 192Mi–512Mi                          | API server.                                                                                                                                                                                             |
| `backend.eventsRetentionDays`                                                                      | 15                                      | How long Kubernetes events are kept.                                                                                                                                                                    |
| `backend.clientIpHeader`                                                                           | `''`                                    | A header your proxy sets to the visitor's address (nginx: `X-Real-IP`), so rate limits count each visitor. Set it only if the proxy always sets that header.                                            |
| `backend.clientCountryHeader`                                                                      | `''`                                    | A header your proxy sets to the visitor's country (Cloudflare: `CF-IPCountry`), shown with an API token's last use. Unset: no country.                                                                  |
| `backend.trustedProxies`                                                                           | loopback and private ranges             | The proxies whose client-IP header and `X-Forwarded-Proto` are believed, as CIDRs.                                                                                                                      |
| `alertWorker.replicas`                                                                             | 1                                       | Evaluates rules and sends notifications; replicas share the work.                                                                                                                                       |
| `alerting.smtpUrl`, `alerting.smtpFrom`                                                            | `''`                                    | SMTP server for email alerts, e.g. `smtp://user:pass@smtp.example.com:587`.                                                                                                                             |
| `alerting.telegramApiUrl`                                                                          | Telegram's                              | Telegram Bot API mirror, where api.telegram.org is blocked.                                                                                                                                             |
| `alerting.httpsProxy`, `alerting.noProxy`                                                          | `''`                                    | Outbound proxy for Slack, Telegram and webhook alerts.                                                                                                                                                  |
| `web.service.type`, `web.service.port`                                                             | `ClusterIP`, 8080                       | The UI's Service.                                                                                                                                                                                       |
| `ingress.enabled`, `ingress.host`, `ingress.className`, `ingress.tlsSecret`, `ingress.annotations` | off                                     | Expose the UI through an Ingress.                                                                                                                                                                       |
| `postgresql.storage`, `postgresql.storageClass`                                                    | 8Gi                                     | Database volume.                                                                                                                                                                                        |
| `victoriametrics.retention`, `victoriametrics.storage`                                             | `15d`, 20Gi                             | Metrics retention and volume.                                                                                                                                                                           |
| `victoriametrics.extraArgs`                                                                        | unset                                   | More VictoriaMetrics flags, as a list (`[-search.maxQueryDuration=10s]`) or a map.                                                                                                                      |
| `watchlog-agent.enabled`                                                                           | `true`                                  | Install the agents for this cluster.                                                                                                                                                                    |
| `watchlog-agent.*`                                                                                 | see below                               | Agent settings, prefixed with `watchlog-agent.`. For example `watchlog-agent.logs.enabled: false` turns [logs on demand](logs.md) off.                                                                  |

## Helm chart `watchlog-agent` (agents only)

| Value                                                                       | Default                                 | What it does                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchlog.endpoint`                                                         | required                                | The WatchLog URL the agents push to.                                                                                                                                                                                              |
| `watchlog.clusterToken` or `watchlog.existingSecret`                        | required                                | The cluster token from Settings → Clusters, or a Secret that holds it (`existingSecretKey`, default `token`).                                                                                                                     |
| `agent.networkFlows.enabled`                                                | `true`                                  | eBPF network flows for the service map. When on, the node agent runs as uid 0 with only the `BPF` and `PERFMON` capabilities; when off, as uid 65532 with none. See [security](security.md).                                      |
| `agent.networkFlows.podFilter`                                              | `true`                                  | The kernel records only connections and DNS lookups of this node's pods. Processes outside the cluster on the same kernel are never recorded, only counted. See [nodes that are containers](#nodes-that-are-containers-kind-k3d). |
| `agent.networkFlows.http`                                                   | `true`                                  | HTTP/1.x requests, status codes and response times on service-map edges and for servers (Nginx and the like), from the first 16 bytes of each message. TLS is never decrypted. See [security](security.md).                       |
| `agent.nodeMetricsScope`                                                    | `auto`                                  | Where node metrics come from: `host`, `cgroup` or `auto`. See [nodes that are containers](#nodes-that-are-containers-kind-k3d).                                                                                                   |
| `agent.interval`                                                            | `15s`                                   | Collection interval.                                                                                                                                                                                                              |
| `agent.kubeletTLS`                                                          | `auto`                                  | Kubelet certificate check: `auto` verifies against the cluster CA and falls back if that fails, `verify` never falls back, `skip` never verifies.                                                                                 |
| `agent.resources`                                                           | 48Mi request, 128Mi limit               | Node agent resources. It stays within 64 MB of memory and 1 % of a core.                                                                                                                                                          |
| `agent.tolerations`, `agent.nodeSelector`, `agent.priorityClassName`        | every node                              | Where the node agent runs.                                                                                                                                                                                                        |
| `clusterAgent.enabled`, `clusterAgent.resources`, `clusterAgent.goMemLimit` | on, 128Mi–512Mi, 400MiB                 | The cluster-agent that watches the Kubernetes API.                                                                                                                                                                                |
| `integrations.enabled`, `integrations.resources`, `integrations.goMemLimit` | on, 48Mi–128Mi, 100MiB                  | The integrations collector: reads the services you monitor on the Applications page (Redis, PostgreSQL, Nginx, RabbitMQ) with read-only access. Idle until a service is monitored; no ClusterRole and no Secrets.                 |
| `logs.enabled`                                                              | `true`                                  | [Logs on demand](logs.md): a container's last lines when someone asks. `false` removes the cluster-agent's `pods/log` permission and the agent refuses every request.                                                             |
| `image.registry`, `image.tag`, `image.pullPolicy`                           | `ghcr.io/watchlog-light`, chart version | Agent images.                                                                                                                                                                                                                     |

## Docker Compose server (`.env`)

| Variable                                             | Default    | What it does                                                                        |
| ---------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `WATCHLOG_DB_PASSWORD`                               | required   | PostgreSQL password.                                                                |
| `WATCHLOG_SECRET_KEY`                                | required   | Key for stored secrets: `openssl rand -base64 32`. Back it up with the database.    |
| `WATCHLOG_SECRET_KEY_PREVIOUS`                       |            | The key before a rotation; still decrypts until every server runs with the new one. |
| `WATCHLOG_PUBLIC_URL`                                | `''`       | How agents and browsers reach the server.                                           |
| `WATCHLOG_VERSION`                                   | `latest`   | Image version; pin it, e.g. `0.5.0`.                                                |
| `WATCHLOG_PORT`                                      | 8080       | The only published port.                                                            |
| `WATCHLOG_RETENTION`                                 | `15d`      | Metrics retention.                                                                  |
| `WATCHLOG_SMTP_URL`, `WATCHLOG_SMTP_FROM`            | unset      | Email alerts.                                                                       |
| `HTTPS_PROXY`, `NO_PROXY`                            | unset      | Outbound proxy for alert deliveries.                                                |
| `WATCHLOG_TELEGRAM_API_URL`                          | Telegram's | Telegram Bot API mirror.                                                            |
| `WATCHLOG_ADMIN_EMAIL`, `WATCHLOG_ADMIN_PASSWORD`    | unset      | Create the admin at startup instead of the setup code.                              |
| `WATCHLOG_DEMO_MODE`                                 | unset      | `true` makes the server a read-only public demo, like the Helm value `demoMode`.    |
| `WATCHLOG_MCP_ENABLED`                               | `true`     | `false` turns the MCP server off, like the Helm value `mcp.enabled`.                |
| `WATCHLOG_CLIENT_IP_HEADER`                          | unset      | Like the Helm value `backend.clientIpHeader`.                                       |
| `WATCHLOG_CLIENT_COUNTRY_HEADER`                     | unset      | Like the Helm value `backend.clientCountryHeader`.                                  |
| `WATCHLOG_TRUSTED_PROXIES`, `WATCHLOG_COOKIE_SECURE` | unset      | Like the Helm values `backend.trustedProxies` and `cookieSecure`.                   |

## Cloud mode (`WATCHLOG_EDITION=cloud`)

WatchLog Cloud runs the same backend with `WATCHLOG_EDITION=cloud`: many organizations with sign-up, Row-Level Security between them, and the account features below. Without it (the default, `community`) none of this exists and these variables are ignored.

| Variable                                                     | Default                    | What it does                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WATCHLOG_EDITION`                                           | `community`                | `cloud` turns on sign-up, organizations and the Cloud-only API. Anything else stops the start.                                                                                                                                                                                                                                                                                                         |
| `DATABASE_SYSTEM_URL`                                        | required in Cloud          | The database owner, for migrations and the few lookups made before an organization is known. `DATABASE_URL` is then the `watchlog_app` role, which can't bypass Row-Level Security; the backend refuses the same URL in both.                                                                                                                                                                          |
| `WATCHLOG_COOKIE_SECURE`                                     | `always` in Cloud          | In Cloud the session cookie is always Secure; any other value stops the start. Browsers accept Secure cookies on `http://localhost`, so local development works.                                                                                                                                                                                                                                       |
| `TURNSTILE_SECRET_KEY`                                       | unset                      | Cloudflare Turnstile's secret: sign-up, "Forgot your password?" and "Resend the verification email" then need a passing widget, checked by the server. Unset: no check (development, tests).                                                                                                                                                                                                           |
| `TURNSTILE_SITE_KEY`                                         | unset                      | Turnstile's site key, which the sign-up and sign-in pages load the widget with. Given to the pages only when the secret key is set too.                                                                                                                                                                                                                                                                |
| `WATCHLOG_GITHUB_CLIENT_ID`, `WATCHLOG_GITHUB_CLIENT_SECRET` | unset                      | A GitHub OAuth app for "Continue with GitHub". Its callback URL is `<public URL>/api/v1/auth/oauth/github/callback`. Set both or neither; unset, the button is hidden.                                                                                                                                                                                                                                 |
| `WATCHLOG_GOOGLE_CLIENT_ID`, `WATCHLOG_GOOGLE_CLIENT_SECRET` | unset                      | A Google OAuth client (web application) for "Continue with Google". Its redirect URI is `<public URL>/api/v1/auth/oauth/google/callback`. Set both or neither; unset, the button is hidden.                                                                                                                                                                                                            |
| `WATCHLOG_DISPOSABLE_DOMAINS_FILE`                           | unset                      | A file of more disposable email domains to refuse at sign-up, one per line (`#` starts a comment), on top of the built-in list. A domain also covers its subdomains. Read at start.                                                                                                                                                                                                                    |
| `WATCHLOG_SMTP_URL`, `WATCHLOG_SMTP_FROM`                    | unset                      | In Cloud also the verification, password reset and invite emails. Without them those emails aren't sent (sign-up still works).                                                                                                                                                                                                                                                                         |
| `WATCHLOG_PUBLIC_URL`                                        | the request origin         | The address in email links and the OAuth callback URLs. Set it in Cloud.                                                                                                                                                                                                                                                                                                                               |
| `WATCHLOG_INGEST_URL`                                        | the public URL             | The address agents push to, written into every install command (Helm, the kubectl manifest, `docker run`, Compose), e.g. `https://ingest.watchlog.io`. The kubectl command fetches `<ingest URL>/install.yaml?code=wl_ic_…`, so that host must send `/install.yaml` to the backend as well as `/ingest/`, and should log the path without the query string (the backend masks `code=` in its own log). |
| `WATCHLOG_SUPPORT_EMAIL`                                     | `support@watchlog.io`      | Where the wizard's "Get help installing" writes, with the cluster's id in the message.                                                                                                                                                                                                                                                                                                                 |
| `WATCHLOG_SAMPLE_URL`                                        | `https://demo.watchlog.io` | The read-only live demo that "Look around a sample organisation" opens in a new tab.                                                                                                                                                                                                                                                                                                                   |
| `WATCHLOG_INTERNAL_TOKEN`                                    | unset                      | The internal API's bearer token (at least 32 characters, e.g. `openssl rand -hex 32`): the billing service and staff set an organization's plan and read its usage with it. Unset, the internal API is off. Compared in constant time.                                                                                                                                                                 |
| `WATCHLOG_INTERNAL_TOKEN_PREVIOUS`                           | unset                      | The token before a rotation, still accepted until you remove it: set the new token here and in the callers, then drop the old one.                                                                                                                                                                                                                                                                     |
| `WATCHLOG_INTERNAL_PORT`, `WATCHLOG_INTERNAL_HOST`           | `4082`, `HOST`             | The internal API's own listener. Keep it on the private network (the Compose network); never publish it or proxy it. The public port has no `/internal` routes at all.                                                                                                                                                                                                                                 |
| `VICTORIAMETRICS_URL_3D`, `VICTORIAMETRICS_URL_30D`          | unset                      | Two VictoriaMetrics instances, one with 3 days of retention (Free) and one with 30 (Pro). Set both or neither; unset, everything uses `VICTORIAMETRICS_URL`.                                                                                                                                                                                                                                           |

**Install codes.** In Cloud, a Kubernetes cluster's kubectl command names its manifest by an install code, never by the cluster token: `kubectl apply -f '<ingest URL>/install.yaml?code=wl_ic_…'`. A code is valid for 24 hours, stands for one cluster token, and stops working when that cluster's tokens rotate (a token issued or revoked). The manifest is the `watchlog-agent` chart rendered once (`scripts/render-install-manifest.sh`) into the `watchlog` namespace, with a new pod map certificate for each download.

**Plans and limits.** Each organization has entitlements: Free is 1 cluster or Docker fleet, 5 nodes, 3 days of data and 1 user; Pro is unlimited clusters and nodes, 30 days and up to 10 users. A cluster or an invite over the plan answers `409` with the problem type `urn:watchlog:problem:plan-limit`. A node counts when its agent (a Kubernetes node's or a Docker host's) sent data in the last 24 hours; a new one over the limit gets `402` at ingest and its data isn't stored, while the nodes already sending never do. After a downgrade, everything already sending keeps sending for 14 days; then the newest nodes beyond the plan get `402`. The Owners get one email per limit and day. The alert worker records the sending nodes and Docker hosts every hour; the bill uses the 95th percentile of those counts. Plan changes come only through the internal API.

Sign-up checks every new password against [Have I Been Pwned](https://haveibeenpwned.com/API/v3#PwnedPasswords) without sending it: only the first 5 characters of its SHA-1 leave the server. When the service doesn't answer within 2 seconds, sign-up goes on and the skipped check is logged. The backend needs outbound HTTPS to `api.pwnedpasswords.com`, `challenges.cloudflare.com` (with Turnstile), and GitHub's and Google's OAuth endpoints (with those providers). Two-factor secrets are encrypted with `WATCHLOG_SECRET_KEY`, so a [key rotation](#rotating-the-secret-key) re-encrypts them too.

## A locked-out Owner

When nobody can sign in as the Owner and email isn't set up, print a reset link inside the backend container:

```bash
# Kubernetes
kubectl exec -n watchlog deploy/watchlog-backend -- watchlog admin reset-password
# Docker Compose
docker exec watchlog-backend-1 watchlog admin reset-password
```

It prints a link that works once and for one hour. Without `--email` it resets the Owner; `--email you@example.com` resets another account. The link uses the Public URL setting; if that isn't set, add `--url https://your-watchlog-address`. Every use is logged on Settings → Users. With email set up, "Forgot your password?" on the sign-in page sends the link instead.

## Rotating the secret key

`WATCHLOG_SECRET_KEY` encrypts alert channel secrets, the email server password, service credentials and, in Cloud mode, two-factor secrets. To replace it without downtime:

1. Generate a new key: `openssl rand -base64 32`.
2. Re-encrypt everything with both keys set, from the backend image:

   ```bash
   # Docker Compose
   docker compose run --rm -e WATCHLOG_SECRET_KEY_PREVIOUS=<old> -e WATCHLOG_SECRET_KEY=<new> backend dist/rotate-secret-key.js
   # Kubernetes
   kubectl -n watchlog exec deploy/watchlog-backend -- env WATCHLOG_SECRET_KEY_PREVIOUS=<old> WATCHLOG_SECRET_KEY=<new> node dist/rotate-secret-key.js
   ```

   It changes every secret in one transaction, and refuses an old key that isn't this installation's.

3. Set the new key and keep the old one as `WATCHLOG_SECRET_KEY_PREVIOUS` (Compose: `WATCHLOG_SECRET_KEY` and `WATCHLOG_SECRET_KEY_PREVIOUS` in `.env`; Helm: `--set secretKey=<new> --set secretKeyPrevious=<old>`), then restart. Servers still on the old key keep working during the restart.
4. Once every backend and alert-worker runs with the new key, remove `WATCHLOG_SECRET_KEY_PREVIOUS`.

## Behind a reverse proxy

WatchLog's web container (Caddy) serves the dashboard and passes `/api` and `/ingest` to the backend. When nginx, an ingress or Cloudflare terminates TLS in front of it:

- **The session cookie is marked Secure when the visitor came over https.** The backend knows this from the TLS connection, or from `X-Forwarded-Proto: https` sent by a trusted proxy. Have your proxy set that header (nginx: `proxy_set_header X-Forwarded-Proto $scheme;`). Plain http, such as a LAN install or local development, keeps a cookie that works over http. `cookieSecure: always` (`WATCHLOG_COOKIE_SECURE=always`) forces Secure; `never` turns it off.
- **Rate limits count each visitor only if the backend learns the visitor's address.** By default every request seems to come from the web container. Have the proxy set a header to the visitor's address (nginx: `proxy_set_header X-Real-IP $remote_addr;`; behind Cloudflare, use `CF-Connecting-IP` when it's set, else `$remote_addr`) and name it in `backend.clientIpHeader` (`WATCHLOG_CLIENT_IP_HEADER`). Set it only if your proxy always overwrites that header.
- **API tokens can show the country of their last use.** Behind Cloudflare, name `CF-IPCountry` in `backend.clientCountryHeader` (`WATCHLOG_CLIENT_COUNTRY_HEADER`). Without it no country is shown; WatchLog does no GeoIP lookup.
- **Only trusted proxies are believed.** The backend takes these headers only from a peer in `backend.trustedProxies` (`WATCHLOG_TRUSTED_PROXIES`, comma-separated CIDRs). The default is loopback and the private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), where the web container connects from in Docker and Kubernetes. A request from anywhere else is judged by its own connection. The web container likewise trusts proxies on private networks, so the backend still receives the `X-Forwarded-Proto` your proxy sent.

## Seed file

`WATCHLOG_SEED_FILE` (the Helm value `seed` sets it) names a JSON file of alert rules the backend creates when it starts. This is how a read-only demo gets its rules, since demo mode refuses every change through the API. Each rule is created once: a rule with the same name is never changed, even after you edit it, so a changed rule in the file needs a new name. A rule that can't be created (an unknown metric or cluster) is logged and skipped. If the file is unreadable or invalid, the backend doesn't start and logs the path and the problem.

```json
{
  "alertRules": [
    {
      "name": "Node memory above 75%",
      "metric": "node.memory.utilization",
      "clusterId": null,
      "scope": {},
      "condition": { "op": ">", "value": 0.75, "critical": 0.9 },
      "forSeconds": 300,
      "severity": "warning"
    }
  ]
}
```

The fields are those of a custom rule in the API. `clusterId` is `null` for every cluster, or a cluster's name or id. `enabled` and `renotifySeconds` are optional. A seed file can't hold channels, so it never holds secrets.

It can also list services to monitor. Each is monitored as soon as an agent reports it, once per cluster: if you stop monitoring one, it isn't added back. A password is only ever referenced, from a Secret in the collector's namespace or a file under `/etc/watchlog/secrets` on the Docker host, never written in the file:

```json
{
  "services": [
    { "clusterKind": "kubernetes", "type": "redis", "name": "shop/redis" },
    {
      "clusterKind": "kubernetes",
      "type": "postgres",
      "name": "shop/postgres",
      "access": {
        "username": "watchlog",
        "secret": { "name": "shop-postgres-watchlog", "key": "password" }
      },
      "defaultAlerts": ["postgres_connections_high"]
    },
    {
      "clusterKind": "docker",
      "type": "postgres",
      "name": "storefront/db",
      "access": { "username": "watchlog", "file": "storefront-db" }
    }
  ]
}
```

`name` is the service as the Applications page lists it. `cluster` (a name or id) limits it to one cluster. The collector still needs the Role and RoleBinding for that Secret, as the connect drawer shows them. A service already monitored keeps its access, unless it has none.

It can also register a Docker fleet (or another cluster) whose agents run outside the Helm chart, such as a demo's Docker host. The file holds only the cluster token's SHA-256 and its prefix (the 8 characters after `wl_ct_`), never the token, which only the agents have:

```json
{
  "clusters": [
    {
      "name": "demo-docker",
      "kind": "docker",
      "tokenSha256": "<sha256 of the token, 64 hex characters>",
      "tokenPrefix": "<the token's characters 7 to 14>"
    }
  ]
}
```

Make the token yourself, `wl_ct_` and 43 letters, digits, `-` or `_` (for example `printf 'wl_ct_%s' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 43)"`), and give it to the agents as `WATCHLOG_TOKEN`. The cluster is created at the backend's next start, with its name and kind, and a seeded rule may name it. A token you revoke, or whose cluster you delete, isn't brought back. A cluster of that name but another kind is left alone and the backend logs why.

A public demo can also publish a read-only MCP token, which only works in demo mode (`demoMode: true`). Its value is public on purpose:

```json
{
  "demoMcp": {
    "token": "wl_pat_…",
    "visitorCallsPerMinute": 30,
    "totalCallsPerMinute": 600
  }
}
```

`token` is any value of an API token's shape: `wl_pat_` and 43 letters, digits, `-` or `_`. The limits are optional, and these are their defaults. Settings → API tokens shows the token to the demo's visitors, and they leave no trace in WatchLog: no last use, no address, no call log.

## Agent options

Set as environment variables, or as flags in the `docker run` command. The install commands set the required ones.

| Variable                         | Flag                      | Default                          | What it does                                                                                                                                                |
| -------------------------------- | ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WATCHLOG_ENDPOINT`              | `--endpoint`              | required                         | The WatchLog URL.                                                                                                                                           |
| `WATCHLOG_TOKEN`                 | —                         | required                         | The cluster token.                                                                                                                                          |
| `WATCHLOG_EBPF`                  | `--ebpf`                  | `true`                           | Network flows. `false` turns them off; the service map then says so for this agent.                                                                         |
| `WATCHLOG_EBPF_POD_FILTER`       | `--ebpf-pod-filter`       | `true`                           | Kubernetes: record only this node's pods in the kernel. `false` records every process and drops the others in the agent.                                    |
| `WATCHLOG_EBPF_CONTAINER_FILTER` | `--ebpf-container-filter` | `false`                          | Docker: record only the containers of the Docker daemon the agent reads, in the kernel. For a Docker host inside a container (Docker in Docker): see below. |
| `WATCHLOG_EBPF_HTTP`             | `--ebpf-http`             | `true`                           | HTTP/1.x stats on edges. `false` keeps flows and DNS and turns only these off.                                                                              |
| `WATCHLOG_NODE_METRICS_SCOPE`    | `--node-metrics-scope`    | `auto`                           | `host`, `cgroup` or `auto` (Kubernetes detects; Docker hosts use `host`).                                                                                   |
| `WATCHLOG_HEALTH_OUTPUT`         | `--health-output`         | `true`                           | Docker: send health check output (redacted, one line, at most 512 bytes). `false` sends exit codes only.                                                    |
| `WATCHLOG_LOGS`                  | —                         | `true`                           | [Logs on demand](logs.md): a container's last lines when someone asks. `false` refuses every request.                                                       |
| `WATCHLOG_HOSTNAME`              | `--hostname`              | the host's                       | The name the host appears under.                                                                                                                            |
| `WATCHLOG_DOCKER_SOCKET`         | `--docker-socket`         | `/var/run/docker.sock`           | Docker socket, used read-only.                                                                                                                              |
| `WATCHLOG_BUFFER_DIR`            | `--buffer-dir`            | `/var/lib/watchlog-agent/buffer` | On-disk buffer while the server is unreachable: up to 200 MB or 15 minutes.                                                                                 |

## A Docker host inside a container (Docker in Docker)

A Docker daemon that runs in a container (`docker:dind`) shares the kernel of the machine around it, and so do its eBPF hooks. Run its agent with `WATCHLOG_EBPF_CONTAINER_FILTER=true` and `WATCHLOG_NODE_METRICS_SCOPE=cgroup`:

- **Network flows.** The agent gives the kernel the cgroups of the containers the inner daemon runs, and the kernel records only connections and DNS lookups made inside them. With Docker's `cgroupfs` driver (Docker in Docker uses it) that is their common `docker` cgroup, so a new container is recorded from its first connection; with the `systemd` driver it is each container's scope, picked up within one interval (15 s). Anything else on the machine, the inner daemon's own processes included, is only counted in `watchlog_agent_flow_filtered_connections_total` and `watchlog_agent_dns_filtered_queries_total`. The kernel holds 16 roots: with more `systemd` scopes than that the filter turns off and the agent logs it, and flows of other processes are dropped in the agent, as they are without the option.
- **Host metrics.** `cgroup` scope reads CPU and memory from the Docker-in-Docker container's own cgroup (its limits), not the machine's, as for [nodes that are containers](#nodes-that-are-containers-kind-k3d).

Off by default: on an ordinary Docker host the agent already drops flows it can't attribute to one of the host's containers.

## Nodes that are containers (kind, k3d)

With kind or k3d, each Kubernetes node is a container, and the nodes share the kernel of the
machine they run on, often next to other containers and sites. WatchLog keeps that machine out
of what it shows:

- **Network flows.** The node agent gives the kernel the node's pod cgroups, and the kernel
  records only connections and DNS lookups made inside them. Connections of anything else on
  the machine (its own processes, plain Docker containers, the pods of other nodes) are never
  recorded, only counted in `watchlog_agent_flow_filtered_connections_total` and
  `watchlog_agent_dns_filtered_queries_total`. The agent also drops any flow it cannot attribute
  to a pod on its node, so nothing from outside the cluster appears on the service map. Turn the
  kernel filter off with `agent.networkFlows.podFilter=false`.
- **Node metrics.** `agent.nodeMetricsScope` says where they come from:

| Scope    | CPU                                                                                                               | Memory                                                                                                              | Load average | Disks and filesystems                                                          | Network                      | Boot time                       |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ | ---------------------------- | ------------------------------- |
| `host`   | the kernel's CPUs and time (`/proc/stat`)                                                                         | the kernel's (`/proc/meminfo`)                                                                                      | yes          | every disk's I/O and every local filesystem's size and free space              | the node's network namespace | the kernel's boot               |
| `cgroup` | the node container's limit (`cpu.max`, else its cpuset) and its usage (`cpu.stat`); idle is the rest of the limit | the node container's limit (`memory.max`; the machine's total only when unlimited, and the agent logs it) and usage | not reported | the node's block I/O summed over devices, no device names; no filesystem sizes | the node's network namespace | when the node container started |

`auto` (the default) picks `cgroup` when the node looks like a container: `/.dockerenv`,
`/run/.containerenv` or `/kind` in its root filesystem, or a cgroup root with `cpu.max` or
`memory.max`, which only a container's cgroup has. Otherwise it picks `host`. In `cgroup` scope
the nodes list, the node page and the overview show the node container's CPUs and memory as the
node's capacity, not what Kubernetes reports (the machine's). Without filesystem sizes, the disk
usage column and the disk usage alert stay empty for these nodes; give the node containers their
own volumes and watch those on the machine if you need them.
