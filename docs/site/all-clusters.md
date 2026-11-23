---
title: All clusters and fleets
description: Every Kubernetes cluster and Linux server fleet on one page in WatchLog Pro. One list of what needs attention anywhere, the same problem in staging and production shown once, What changed across all of them, and old agents and broken alert channels in one place.
---

# All clusters and fleets

One WatchLog holds as many Kubernetes clusters and Server fleets as you run. **All clusters and
fleets** shows every one of them on one page, so you see at a glance whether anything needs
attention anywhere, without opening each one.

**It is part of Pro** in [WatchLog Cloud](cloud.md), with [What changed](what-changed.md), and
on a self-hosted install with an [Enterprise licence](license.md). The live demo has it too. Cloud Free and the self-hosted Community edition see the page's layout
with example data under an upgrade card; the cluster switcher keeps working on every plan.

Open it from the first item in the sidebar, or from the top of the cluster switcher. When your
organization has two or more clusters and fleets, Pro opens on this page after you sign in.

## What it shows

From the top, each section follows the filter (**All**, **Kubernetes** or **Server fleets**)
and the time range (1 hour to 30 days, within your plan's history):

- **The status:** one sentence, such as "3 clusters and fleets need attention", and what stands
  out: a problem two clusters share, a server that went silent, or the worst problem. When
  everything is fine it says so, with how many nodes and servers are reporting.
- **Six numbers:** clusters and fleets by status, nodes and servers (and how many aren't
  reporting), open problems by severity, alerts sent in the range by channel, with the failed
  ones named, and (since 0.13) **certificates expiring within 14 days** (expired ones included),
  with how many in each cluster or fleet, and **scheduled jobs failing**, named. See
  [Certificates and scheduled jobs](certificates-and-jobs.md).
- **Needs attention, everywhere:** every open problem from every cluster and fleet in one list,
  critical first, then the most recent. Each row has the same probable-cause line the cluster's
  own Overview shows, a chip for each cluster or fleet it is in, and how long it has been open.
  A chip opens the problem in that cluster or fleet.
- **Clusters and fleets:** one row each, worst first. Kubernetes rows show the version and the
  nodes; Server fleet rows show the servers and what runs there (the applications WatchLog
  monitors, or how many systemd services, process groups and containers). Then the status, the
  agents reporting ("12 / 12", red when one is silent), CPU over the range, memory now, open
  problems, certificates ("12 · 1 expiring") and scheduled jobs ("9 · 1 failing"), each opening
  that page, What changed in the last 24 hours and alerts sent. A row opens that cluster's or
  fleet's Overview.
- **What changed, across all of them:** the furthest-out entries of [What changed](what-changed.md)
  from every cluster and fleet in the last 24 hours, ranked together, each with where it is.
  During a cluster's first week, the page says which ones are still learning.
- **Housekeeping:** agents older than your WatchLog, alert channels whose last delivery failed
  (and which ones still deliver), clusters and fleets with no alert channel, and nodes or
  servers where eBPF is off, with the reason. Each links to where it's fixed.

## The same problem in two places

A bad release often breaks staging and production the same way. When two clusters or fleets
have the same problem, it is **one row with two chips**, so you see it's one cause. Two problems
are the same when all of these hold:

- they come from the same alert rule;
- they are about the same workload name: on Kubernetes the same Deployment, StatefulSet or
  other workload (the namespace may differ); on servers the same systemd unit, process group or
  container (its Compose service when it has one);
- both are open, and they started within 30 minutes of each other.

Nothing fuzzier: similar names stay apart, a node or a silent server is never merged, and two
problems inside one cluster are never merged here (its own Overview already groups them).

## API and AI assistants

The page is one call, for scripts and dashboards:

```bash
curl -H "Authorization: Bearer $WATCHLOG_TOKEN" \
  "https://<your WatchLog>/api/v1/overview/all?range=86400&kind=all"
```

`range` is 3600, 21600, 86400 (the default), 604800 or 2592000 seconds; `kind` is `all`,
`kubernetes` or `server`. On Cloud Free it answers 403 `pro-feature`; a self-hosted Community
install answers 404, and one whose licence ended 403 `license-ended`. See the [API](api.md).

The answer carries the same certificate and job counts: `certificatesExpiring` and
`jobsFailing` in the summary, `certificates` and `jobs` on each cluster.

AI assistants get the same summary through the MCP tool `get_all_clusters`: ask "Is anything
wrong in any of our clusters?". See [MCP](mcp.md).
