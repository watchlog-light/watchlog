---
title: Right-sizing hints
description: How WatchLog compares CPU and memory requests and limits with seven days of real use, on Kubernetes and Docker, and what each hint means.
---

# Right-sizing hints

Teams ask for more CPU and memory than their pods use because they don't know what the pods
use, and set limits too tight until the OOM killer tells them. WatchLog already measures every
container's CPU, memory, throttling and OOM kills, so it compares them with what you asked for
and says it in a sentence:

> web asks for 500m CPU; its busiest pod used at most 60m (p95) over 7 days. About 80m would
> cover it and give back 840m CPU in all.

**No scores.** There is no "efficiency" percentage, no grade and no money. Each hint says what
was set, what was used, over how long, and what would cover it. Hints are not alerts: nothing
is sent anywhere.

## Where to find them

- **Kubernetes:** the **Right-sizing** card on a workload's page (Workloads → a Deployment,
  StatefulSet or DaemonSet), one line per hint, with the container when the pod has several.
- **Docker:** the same card on a container's page and on a Compose service's page.
- **Overview:** a card with how many workloads (or containers) could give CPU or memory back
  and how much in all, how many are close to their memory limit, and the first three hints, OOM
  risk first. **Show all** opens the whole list; each line opens its workload or container.
  The namespace filter applies.
- **API and MCP:** see [below](#api-and-mcp).

## What is compared

WatchLog reads the last **7 days** at **5-minute** resolution: CPU at its 95th percentile (the
busiest 5 % of the time left out, so a single spike doesn't count), memory at its highest
working set (memory spikes do kill), and the share of the time a container was throttled at its
CPU limit. On Kubernetes each container of a workload is judged on its **busiest pod**.

A container needs **24 hours** of history before it is judged. Until then its card says
"Not enough history yet: 5 of 24 hours". With shorter metrics retention the window is what
exists, and each hint says how long it is based on ("over 3 days").

Jobs and CronJobs are left out (their runs are short). System namespaces and WatchLog's own
containers are left out of the overview, as everywhere else; their own pages still show hints.

### Kubernetes

| Hint                       | When                                                                                  | Suggestion          |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------- |
| OOM-killed at the limit    | an OOM kill at the memory limit in the window                                         | a limit with room   |
| Close to the memory limit  | the highest working set reached 90 % of the limit                                     | peak × 1.25         |
| Held back by the CPU limit | throttled at least 10 % of the time (p95)                                             | raise or remove it  |
| Memory request too low     | the working set's p95 is above the request: under node memory pressure, evicted first | peak × 1.25         |
| CPU request too low        | CPU p95 above the request: the scheduler places the pod as if it needed less          | p95 × 1.25          |
| CPU request too high       | the request is at least 2 × the p95 and at least 100m would be given back             | p95 × 1.25          |
| Memory request too high    | the request is at least 2 × the peak and at least 128 MiB would be given back         | peak × 1.25         |
| Not set                    | no CPU request, no memory request or no memory limit (one sentence with what it used) | what it used × 1.25 |

A request left out while a limit is set counts as the limit, as Kubernetes does. "Give back"
counts every running replica: a Deployment of three pods that asks for 400m too much gives back
1.2 CPU.

### Docker

A Docker limit reserves nothing on the host, so a limit far above use costs nothing and gets no
hint. A Docker container gets:

- **OOM-killed at the limit** or **close to the memory limit**, as above;
- **held back by the CPU limit**, as above;
- a **memory reservation** (`mem_reservation`, `--memory-reservation`) too low or too high, judged
  as a Kubernetes memory request is: when the host runs short of memory, a container above its
  reservation is squeezed back toward it first;
- **no memory limit** only when the container used more than a quarter of its host's memory.

The memory reservation is reported by WatchLog agent 0.5.0 and newer.

### Rounding

Suggestions round up: CPU to the next 10m, memory to the next 16 MiB, after adding a quarter for
headroom. They are a starting point; a workload with a weekly peak outside the window needs
your own judgement.

## Probable cause

An OOM kill at the limit and CPU throttling are also [probable causes](probable-cause.md)
(`oom_limit`, `cpu_throttled`): when one explains a crash or a slowdown, the workload's page shows
it in the Likely cause panel, and the hint links there.

## API and MCP

```bash
# Every hint of a cluster, OOM risk first; containers without 24 hours of history apart
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/clusters/$CLUSTER/right-sizing"
# One workload, or one Docker container or Compose service
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/clusters/$CLUSTER/right-sizing?namespace=shop&workload=web"
curl -H "Authorization: Bearer $TOKEN" "$WATCHLOG/api/v1/clusters/$FLEET/right-sizing?project=storefront&service=web"
```

Each hint is a `code` with `facts` (cores and bytes), the `suggestion`, `giveBack` and `basedOn`
(the window and the hours of history). `summary` counts the workloads or containers with a hint,
those that could give back and how much, and those at OOM risk. `system=true` includes system
namespaces and WatchLog's own containers.

The MCP tool `get_right_sizing` returns the same, at most 40 hints; ask your AI "Which workloads
in shop ask for more CPU than they use?" See [MCP](mcp.md).

## Cost

The use is read from WatchLog's metrics store once an hour per cluster (a handful of
`quantile_over_time` and `max_over_time` queries) and kept; requests and limits are read fresh on
every request, so a changed request shows at once. On a small cluster the read takes well under a
second. For tests, `WATCHLOG_RIGHT_SIZING_WINDOW_HOURS` (default 168) and
`WATCHLOG_RIGHT_SIZING_MIN_HOURS` (default 24) on the server shorten the window and the history
needed.
