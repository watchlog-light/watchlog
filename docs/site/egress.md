---
title: Egress watch
description: Every external destination your Kubernetes workloads and Docker containers talk to, since when, and alerts when something new starts talking. From connections only.
---

# Egress watch

"What is my cluster talking to on the internet, and since when?" Egress watch answers it for
a Kubernetes cluster and for a Docker fleet. WatchLog keeps a record of every external
destination each workload or container has used, with its first and last connection, and
tells you when something starts talking to a destination it never used before.

It is built from what the agent already sends for the service map, so there is nothing to
install or turn on. It is in every edition, Community included, and in every Cloud plan.

## What WatchLog learns, and what it never reads

For each source, destination and port, the agent counts **connections, bytes sent and
received, and failed connections**, the same flow series the service map uses
([what eBPF reads](security.md#network-flows-ebpf)). That is all.

- **Names come from DNS answers.** When a container resolves `api.stripe.com` and then
  connects to the address it got back, the connection is named `api.stripe.com:443`. The
  agent reads the question and the A, AAAA and CNAME records of the DNS responses the
  container receives, keeps them in memory for their TTL, and sends a name only as that
  connection's destination.
- **Without a name, a network.** A connection to an address no DNS answer explained shows as
  its network: `203.0.113.0/24` for IPv4, a `/48` for IPv6.
- **Never read:** payloads, TLS SNI, HTTP hosts or paths, certificates. HTTPS isn't
  decrypted. A process that resolves names over DNS-over-HTTPS, DNS-over-TLS or DNS over TCP
  shows its destinations as networks, since WatchLog never sees those answers.
- **Names are data.** Anyone can register a domain name, so WatchLog shows destinations as
  text, never as links, and sets them as code in Slack and Telegram messages.

Addresses inside the cluster are never external: pods, Services and nodes stay on the service
map. Network flows must be on (they are by default); without them the Egress page has nothing
to show.

### Kubernetes

A source is a **workload**: its namespace, kind and name (`shop/Deployment/orders`). A pod's
connections count for its workload, because flows are recorded per workload, not per pod. A
CronJob is one source across all its runs; a bare pod is `Pod/<name>`.

### Docker

A source is a **Compose service** (`storefront/api`) when the container belongs to one, so a
re-created container keeps its history. Any other container is its name on its host
(`docker-01/redis`).

## The Egress page

**Egress** is in the navigation of every cluster and fleet, between Service Map and Alerts,
with "N new" beside it when destinations were first seen in the last 24 hours.

The page starts with "What acme-prod talks to on the internet", how many days of traffic it
has learned from (or "Learning until …", below), and four counts: destinations and the
sources talking to them, new in 24 hours, raw IP, and failing. Choose a range of 1 hour,
24 hours (the default), 7 days or 30 days.

Each row is one destination and port, with:

- every source that talks to it, each a link to its page (a new one says "new");
- first seen and last seen;
- bytes sent and received, connections and the failed share over the range;
- the actions: **Mark expected** or **Undo**, and **View alert** when an egress alert is open
  for it.

**Filters:** the badges (All, New, Raw IP, Failing, Not marked expected), a search over
destinations and sources, and:

- on Kubernetes, the namespace and the workload;
- on Docker, the host, the Compose project and the container.

Every filter is kept in the URL, so a filtered view can be shared. Below 768 px the table
becomes one card per destination.

### Badges and labels

| Badge or label                      | Means                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **New**                             | A source first used this destination in the last 24 hours. Only names and public networks are ever New. |
| **Raw IP**                          | A public network dialled directly: no DNS name was behind the address.                                  |
| **Failing**                         | At least 5 % of its connections failed in the range, out of at least 3.                                 |
| **Expected** (`Expected · *.x.io`)  | Every source's use of it is covered by an expectation; the pattern shows when it isn't the name itself. |
| Private network                     | A raw network in a private, shared, loopback or link-local range (10/8, 192.168/16, fc00::/7 …).        |
| Local name                          | A name of one label (`api`, `db`), such as a Compose service or a host on the local network.            |
| Other destinations · Names not kept | A source's destinations past the agent's cap of 50 (see [Limits](#limits)).                             |

Private networks and local names are listed and can be marked expected, but they are never
New and never raise an alert: on real clusters they are mostly cluster or host addresses the
agent saw from outside, and they come and go with every pod restart.

### On a workload, pod, container or Compose service page

**Talks to the internet** shows the same rows for one source over the last 30 days: since
when, today's connections, the failed share and Expected, with **Mark expected** and a link to
the Egress page filtered to it.

- **Kubernetes:** the workload page and the pod page. The pod page says the rows are its
  workload's.
- **Docker:** the container page and the Compose service page. A container that belongs to a
  Compose service shows its service's destinations, with its own traffic.

## Expected destinations

A cluster that calls its cloud provider will meet a new `*.amazonaws.com` name every week.
Mark it expected once, and "New external destination" stays quiet for it.

**Mark expected** on a row (or on an alert, or in "Talks to the internet") asks:

- **For:** only this source, or every workload (Kubernetes) / every container and Compose
  service (Docker);
- **What:** this destination, or a pattern;
- **Port:** this port, or any port.

A pattern is one of:

- an exact name: `api.stripe.com`;
- `*.` and a suffix of at least two labels: `*.amazonaws.com` covers any name under it, at
  any depth, but not `amazonaws.com` itself (`*.com` is refused);
- for raw networks, a CIDR of at least /8 (IPv4) or /32 (IPv6): `203.0.113.0/24`. A bare
  address is refused with the network to write instead.

Names compare lower-cased. Anything else is refused with the reason.

What an expectation does:

- the rows it covers show **Expected**, with who marked them and when;
- "New external destination" doesn't fire for them, and an open alert resolves at the next
  check, about a minute later;
- "Raw IP egress" and "Large upload to a new destination" still fire: an expected name doesn't
  make a raw address or a large upload expected;
- it is kept until someone removes it, even after the destination is forgotten, and covers
  names not seen yet.

**Expected destinations**, under the table, lists them with what each covers now, who added it,
**Remove**, and a field to add a pattern for every source. **Undo** on a row removes the
expectations that cover it; its next new use alerts again.

Owners and Admins mark and remove expectations; Viewers see them. Each change is in Users ›
Recent changes. A cluster or fleet holds at most 1,000.

## Alerts

Three default rules, severity warning, on for every cluster and fleet. Like every rule, each
can be edited, sent to the channels you pick, or turned off ([alerts](alerts.md)).

| Rule                                  | Fires when                                                                                                        | Resolves                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **New external destination**          | a source starts talking to a name or public network it never used, not marked expected, after its learning period | when marked expected, or after 24 hours without traffic to it |
| **Raw IP egress**                     | a source opens at least **5 connections in 10 minutes** to the same public network and port                       | after 10 minutes below that                                   |
| **Large upload to a new destination** | a source sends more than **100 MiB in an hour** to a destination it first used in the last 24 hours               | when the hour's total drops below it                          |

One alert per source, destination and port. A destination used again after its alert resolved
is no longer new, and stays quiet. "Other destinations" never raises "New", since it names
nothing. Raw IP counts per network (`/24` or `/48`), the finest unit the agent sends.

### The learning period

"New external destination" waits **7 days** while WatchLog learns what a cluster normally talks
to, and 7 days for each new source too (a workload or Compose service seen for the first
time). During that time destinations are recorded, and nothing first used then is ever new.
The Egress page says "Learning until <date>". The other two rules don't wait.

- **After an upgrade** to WatchLog 0.7, the learning period starts at the upgrade for every
  cluster and fleet that already exists, and the destinations already in use get their first
  seen from the flow series still retained. An upgrade doesn't raise one alert per destination.
- **A cluster added later** starts learning when it first reports.

Change the length (0 to 90 days, fractions allowed) with the Helm value
`alerting.egressLearningDays` or, for the Docker Compose server, `WATCHLOG_EGRESS_LEARNING_DAYS`
in `.env` ([configuration](configuration.md)). `0.25` is 6 hours, as on the live demo.

### What a message says

```text
🟠 WARNING · orders started talking to cdn-update-check.xyz:443

first connection at 08:12 UTC · nothing else in the cluster talks to it
shop/orders (Deployment) · cluster acme-prod · since 08:12 UTC (3 min)
Likely cause: Started 7 minutes after orders was changed to image shop/orders:3.8.2.
https://watchlog.example.com/egress?cluster=…&namespace=shop&kind=Deployment&workload=orders&q=cdn-update-check.xyz
```

On Docker the same alerts name the Compose service or the container and its host:

```text
storefront/api started talking to example.org:443
first connection at 08:12 UTC · 2 other containers talk to it

redis connects to 8.8.8.0/24:53 by IP address
6 connections in 10 min · no DNS name behind it · docker-01/redis
```

The link opens the Egress page filtered to the source, with the destination as the search. The
webhook carries the destination as data in `labels` (`destination`, `port`).

**Probable cause:** a rollout or image change of the workload in the 60 minutes before its
first connection makes the cause Likely ("Started 7 minutes after orders was changed to image
shop/orders:3.8.2."); on Docker, a re-created container, an image or a Compose change. Without
one the answer is No clear cause, with what was checked ([probable cause](probable-cause.md)).

The alert's page adds **Where it talks**: the destination, its first connection, connections
and bytes from the source, the other sources using it, **Mark expected** and **Open in
Egress**.

## API and MCP

Reading needs a token or a session; marking expected needs an Owner's or Admin's browser
session, so a token can never change anything ([API](api.md)).

```bash
# A cluster's destinations, or one workload's (Kubernetes)
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/egress?cluster=$CLUSTER"
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/egress?cluster=$CLUSTER&namespace=shop&kind=Deployment&workload=orders"
# A fleet's, one Compose service's or one container's (Docker), new ones only
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/egress?cluster=$FLEET&project=storefront&service=api&badge=new"
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/egress?cluster=$FLEET&host=docker-01&container=redis"
# Only the sources that started since a time (Unix seconds)
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/egress?cluster=$CLUSTER&firstSeenAfter=1794150000"
# The expectations, and how many rows each covers
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/egress/expected?cluster=$CLUSTER"
```

`GET /api/v1/egress` takes the page's filters (`badge` is `new`, `raw_ip`, `failing`,
`expected` or `not_expected`; `q` searches) and `from` and `to` in Unix seconds: 24 hours by
default, at most 30 days, at most 500 rows with `truncated` and `total`. Each row has the
destination and port, its class, its sources in the cluster's own words, first and last seen,
bytes, connections, the failed share, its badges, its expectation and `alertId`.

Three MCP tools, read-only ([MCP](mcp.md)):

| Tool                        | Answers                                                                      | Example question                                                    |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `get_egress`                | a cluster's or one source's destinations with their badges (at most 50 rows) | "What does shop/orders talk to outside the cluster?"                |
| `get_new_destinations`      | destinations first used in the last hours, up to 7 days (at most 30 rows)    | "Did anything in storefront start talking somewhere new this week?" |
| `get_expected_destinations` | the expectations, who added them and what they cover                         | "Who marked \*.amazonaws.com as expected?"                          |

On Kubernetes they take `namespace` and `workload`; on Docker `host`, `composeService`
(`project/service`) and `container`. Destination names come back only in their own fields,
as data your assistant should never follow.

## A suggested NetworkPolicy (Kubernetes only)

On a workload's page, under "Talks to the internet", **Suggested egress policy** writes a
policy from what the workload actually reached in the last 30 days (or the metrics retention,
if shorter; the window is printed with it). **WatchLog never applies it:** copy it, review it,
and try it in staging first.

- **With Cilium** (detected from its CRDs by the cluster agent): a `CiliumNetworkPolicy` whose
  `toFQDNs` lists exactly the names used, with their ports, plus the DNS rule that turns on
  Cilium's DNS proxy, which `toFQDNs` needs.
- **Standard `NetworkPolicy`**, for any network plugin that enforces policies. It can only match
  addresses, not names, so it allows the names' ports to any public address and says so; raw
  networks seen go in as their CIDR.

Both are offered as tabs, the one that fits the cluster first. Both allow DNS to kube-dns and
the in-cluster destinations seen, selecting their pods by labels. A destination reached
through a Service is allowed on every port, because the agent sees the Service's port, not
the pod's. Expectations for the workload or every workload are added too (`*.` patterns
become `matchPattern` in Cilium). A Job or CronJob between runs has no pod to read labels
from: its policy can be suggested while a pod runs.

The same YAML is in the API:

```bash
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/egress/policy?cluster=$CLUSTER&workload=shop/Deployment/orders"
```

**Why Docker has none:** Docker has no standard egress policy object. Its controls are a
network created with `internal: true`, which cuts off all egress, or host firewall rules (the
`DOCKER-USER` chain in iptables or nftables), which no Docker API exposes and which differ per
host. The container and Compose service pages say so, and the policy route answers 404 for a
fleet.

## Limits

- **50 destinations per source.** The agent keeps at most 50 destinations per source, per
  node, per hour. Beyond that they arrive together as **Other destinations · Names not kept**,
  which is listed but never new. Real sources rarely come near it.
- **Short-lived processes:** a pod or container that connects and exits within about
  15 seconds, before the agent's next read, isn't attributed to any source. Its connections
  are only counted in `watchlog_agent_flow_unattributed_connections_total`.
- **Forgotten after 90 days:** a destination last seen more than 90 days ago is dropped from
  the record, in every edition and plan. If it comes back, it is new again. Expectations are
  kept.
- **Traffic numbers follow your metrics retention** (15 days by default); first and last seen
  outlive it. A destination already in use before the oldest retained sample shows "before"
  that date.
- **No country, owner or reputation** of destinations, and nothing is ever blocked.
