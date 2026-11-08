---
title: REST API
description: Read WatchLog from scripts with a personal API token, for Kubernetes clusters and Docker fleets.
---

# REST API

Everything the dashboard shows about your clusters, you can read from a script: pods,
containers, nodes, hosts, events, the service map, alerts and metrics. You authenticate with a
personal API token. It is read only and can't change anything.

The API covers both kinds of cluster WatchLog watches: **Kubernetes clusters** and **Docker
fleets** (one or more Docker hosts). The examples below show both.

## Get a token

1. In WatchLog, open **Settings → API tokens** and choose **Create token**.
2. Give it a name that says where you use it (for example "nightly report"), and pick when it expires.
3. Copy the token. It starts with `wl_pat_` and is shown only once.

Send it in the `Authorization` header:

```bash
export WATCHLOG=https://watchlog.example.com
export TOKEN=wl_pat_...

curl -H "Authorization: Bearer $TOKEN" $WATCHLOG/api/v1/me
```

`GET /api/v1/me` answers with your user and the token you used (its name, prefix, scope and
expiry), which is a quick way to check that a token works.

A token reads as you: it sees the clusters you can see, nothing more. Revoke it in
Settings → API tokens and the next request fails. You get an email 7 days before a token
expires when WatchLog can send email.

## Find a cluster

Every cluster has an id and a `kind`, `kubernetes` or `docker`:

```bash
curl -H "Authorization: Bearer $TOKEN" $WATCHLOG/api/v1/clusters
```

```json
{
  "clusters": [
    {
      "id": "01a191fb-b18c-75a0-be51-47fcaa9eadde",
      "name": "prod-eu",
      "kind": "kubernetes",
      "status": "active",
      "nodeCount": 3,
      "lastSeenAt": "2026-11-08T14:02:31.000Z"
    },
    {
      "id": "01a18f2a-22a8-7457-94af-5a66bca41e97",
      "name": "docker-fleet",
      "kind": "docker",
      "status": "active",
      "nodeCount": 2,
      "lastSeenAt": "2026-11-08T14:02:29.000Z"
    }
  ]
}
```

(Shortened: responses carry more fields than shown on this page. The spec lists them all.)

The examples below use `$CLUSTER` for a Kubernetes cluster's id and `$FLEET` for a Docker
fleet's id.

## Kubernetes clusters

```bash
H="Authorization: Bearer $TOKEN"

# Pods, optionally in some namespaces: phase, readiness, restarts, the last termination
curl -H "$H" "$WATCHLOG/api/v1/clusters/$CLUSTER/pods?namespaces=shop"

# One pod, with its containers and why it is failing, if it is
curl -H "$H" $WATCHLOG/api/v1/clusters/$CLUSTER/pods/shop/cart-6488c85554-ws5tm

# Workloads (Deployments, StatefulSets, DaemonSets, Jobs) over the last hour
curl -H "$H" "$WATCHLOG/api/v1/clusters/$CLUSTER/workloads?range=3600"

# Nodes and one node
curl -H "$H" $WATCHLOG/api/v1/clusters/$CLUSTER/nodes
curl -H "$H" $WATCHLOG/api/v1/clusters/$CLUSTER/nodes/worker-1

# Namespaces
curl -H "$H" $WATCHLOG/api/v1/clusters/$CLUSTER/namespaces

# Warning events, newest first
curl -H "$H" "$WATCHLOG/api/v1/clusters/$CLUSTER/events?type=Warning&limit=20"
```

A pod in the list looks like this:

```json
{
  "namespace": "shop",
  "name": "cart-6488c85554-ws5tm",
  "node": "worker-2",
  "phase": "Running",
  "ready": true,
  "restarts": 0,
  "workloadKind": "Deployment",
  "workload": "cart",
  "lastTermination": null,
  "failing": null
}
```

## Docker fleets

```bash
H="Authorization: Bearer $TOKEN"

# Hosts: Docker version, container counts, CPU, memory and disk
curl -H "$H" $WATCHLOG/api/v1/clusters/$FLEET/docker/hosts

# Containers on every host, or on one, with state, health, restarts and the OOM flag
curl -H "$H" $WATCHLOG/api/v1/clusters/$FLEET/docker/containers
curl -H "$H" "$WATCHLOG/api/v1/clusters/$FLEET/docker/containers?host=docker-01"

# Events (container starts, stops, OOM kills, health changes) on one host
curl -H "$H" "$WATCHLOG/api/v1/clusters/$FLEET/events?hosts=docker-01&limit=20"
```

A container looks like this:

```json
{
  "name": "storefront-api-1",
  "host": "docker-01",
  "image": "ghcr.io/example/storefront-api:1.4.2",
  "state": "running",
  "health": "healthy",
  "restartCount": 2,
  "oomKilled": false,
  "composeProject": "storefront",
  "composeService": "api",
  "problem": null
}
```

The Kubernetes routes (pods, workloads, nodes, namespaces) answer with empty lists for a
Docker fleet, and the Docker routes with empty lists for a Kubernetes cluster.

## For both kinds

```bash
H="Authorization: Bearer $TOKEN"

# The overview: health, problems, top consumers, recent changes and events
curl -H "$H" $WATCHLOG/api/v1/clusters/$CLUSTER/overview
curl -H "$H" $WATCHLOG/api/v1/clusters/$FLEET/overview

# The service map: who talks to whom, with failures and latency (eBPF)
curl -H "$H" "$WATCHLOG/api/v1/clusters/$CLUSTER/service-map?range=3600"
curl -H "$H" "$WATCHLOG/api/v1/clusters/$FLEET/service-map?range=3600"

# Event counts over time, and change markers (deploys, restarts) between two times
curl -H "$H" $WATCHLOG/api/v1/clusters/$CLUSTER/events/summary
curl -H "$H" "$WATCHLOG/api/v1/clusters/$FLEET/change-markers?from=1794150000&to=1794153600"

# Firing alerts on every cluster, one alert, and its chart
curl -H "$H" "$WATCHLOG/api/v1/alerts?view=firing"
curl -H "$H" $WATCHLOG/api/v1/alerts/$ALERT
curl -H "$H" $WATCHLOG/api/v1/alerts/$ALERT/chart

# Alert rules and silences
curl -H "$H" $WATCHLOG/api/v1/alert-rules
curl -H "$H" $WATCHLOG/api/v1/silences
```

### Metrics

`POST /api/v1/query/range` returns a metric's series between two times (Unix seconds). It
takes the metric names from WatchLog's catalog, not free-form queries:

```bash
# CPU of the cart Deployment on a Kubernetes cluster, the last hour
curl -H "$H" -H "Content-Type: application/json" $WATCHLOG/api/v1/query/range -d '{
  "clusterId": "'$CLUSTER'",
  "metric": "workload.cpu.usage",
  "scope": { "namespace": "shop", "workloadKind": "Deployment", "workload": "cart" },
  "from": '$(($(date +%s) - 3600))', "to": '$(date +%s)'
}'

# Memory of one container on a Docker host
curl -H "$H" -H "Content-Type: application/json" $WATCHLOG/api/v1/query/range -d '{
  "clusterId": "'$FLEET'",
  "metric": "container.memory.working_set",
  "scope": { "host": "docker-01", "container": "storefront-api-1" },
  "from": '$(($(date +%s) - 3600))', "to": '$(date +%s)'
}'
```

```json
{
  "metric": "container.memory.working_set",
  "unit": "bytes",
  "step": 60,
  "series": [{ "labels": { "container": "storefront-api-1" }, "points": [[1794150000, 182452224]] }]
}
```

The spec lists every metric name and scope field. A query covers at most 31 days; WatchLog
picks the step (the seconds between points) for the range unless you send `step`.

## What a token can't read

The API is for reading your clusters. A token can't:

- change anything: create, edit or delete clusters, rules, silences, channels or settings;
- read settings, alert channel targets, email or Telegram details, cluster tokens or other
  API tokens;
- read the error text of a failed alert delivery, which can name your mail server or part of
  a webhook address.

WatchLog never collects Kubernetes Secrets, ConfigMap data or container environment
variables, so no token can read them either.

## Errors

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problems, sent as
`application/problem+json`:

```json
{
  "type": "urn:watchlog:problem:token-scope",
  "title": "Forbidden",
  "status": 403,
  "detail": "API tokens are read-only and cannot use this endpoint"
}
```

| Status | When                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | A parameter is invalid. Also `urn:watchlog:problem:token-with-session` when a request carries both a token and a browser session: send only the token.  |
| 401    | The token is wrong, expired or revoked. `WWW-Authenticate: Bearer error="invalid_token"`.                                                               |
| 403    | `urn:watchlog:problem:token-scope`: the route is not in the public API, or it changes something. `WWW-Authenticate: Bearer error="insufficient_scope"`. |
| 404    | No such cluster, pod, node, container or alert, or not one you can see.                                                                                 |
| 429    | More than 300 requests in a minute with this token. `Retry-After` says how many seconds to wait.                                                        |

## Limits

- **300 requests a minute per token.** Use one token per script, so a busy script doesn't slow
  down another.
- **Ranges:** `range`, in seconds, goes from 5 minutes to 7 days, as in the dashboard. A metrics
  query covers at most 31 days.

## Stability

The routes on this page and in the spec are the public API. They are stable:

- **Additions can come in any release:** new routes, new optional parameters, new fields in
  responses, and new values in fields that name a status or a kind. Ignore fields you don't know,
  and handle values you don't recognise.
- **Breaking changes come only with a new version (`/api/v2`),** or after the old behaviour
  has been marked deprecated for two minor versions. A breaking change is removing a route or a
  field, making a field optional or nullable, changing a type, or requiring a new parameter.
  Release notes say when something is deprecated.

Other routes under `/api/v1` are the dashboard's own. They can change in any release, and
tokens can't call them.

## The spec

The API is described in OpenAPI 3.1 at `/api/v1/openapi.json`, on your own WatchLog. It
lists only the public routes, and needs no token:

```bash
curl $WATCHLOG/api/v1/openapi.json -o watchlog-openapi.json
```

Load it into any OpenAPI tool to browse the routes or generate a client.
