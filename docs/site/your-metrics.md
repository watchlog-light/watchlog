---
title: Your metrics
description: Send WatchLog the numbers your own apps and exporters report (a Prometheus /metrics endpoint, Prometheus remote write, or one HTTP call), see each on the workload or server it belongs to, put them on dashboards you build from widgets, pin them, and alert on them. With the limits of each plan and what is refused and why.
---

# Your metrics

WatchLog already shows what your clusters and servers do. **Your metrics** shows what your own
software counts: orders created, failed payments, checkout time, jobs waiting, the last good
backup, a GPU's temperature. They arrive in one of three ways, appear under **Your metrics**
in the sidebar, and each one sits on the workload or server it belongs to.

There is no query language to learn. A metric is shown the way its type reads (a counter as a
rate, a histogram as its p95, a timestamp as "3 h ago"), and a dashboard is built from widgets:
a metric, a shape and a size.

WatchLog's own pages (Overview, Workloads, Servers, the Service Map and the rest) stay as they
are. Dashboards exist for your own metrics only.

## What each plan includes

|                                                      | Cloud Free        | Cloud Pro                                          | Self-hosted Community                  | Self-hosted with a licence (`pro`) |
| ---------------------------------------------------- | ----------------- | -------------------------------------------------- | -------------------------------------- | ---------------------------------- |
| Series in the organisation                           | 200               | 200 for each billed node or server, at least 1,000 | the installation's cap (20,000)        | the installation's cap             |
| Series from one source                               | 100               | 500                                                | 500                                    | 500                                |
| Kept for                                             | 3 days            | 30 days                                            | the installation's retention           | the installation's retention       |
| Sources                                              | 3                 | no limit                                           | no limit                               | no limit                           |
| Dashboards                                           | 1, with 8 widgets | 50, with 24 widgets each                           | 50, with 24 widgets each               | 50, with 24 widgets each           |
| Pin to a workload's or server's page                 | yes               | yes                                                | yes                                    | yes                                |
| Alerts on your metrics                               | none              | all                                                | above, below, not reported, older than | all                                |
| Usual range, "outside its usual range", What changed | no                | yes                                                | no                                     | yes                                |

Nothing here is billed on its own: Cloud Pro's allowance follows the nodes and servers it
already pays for. A self-hosted installation sets its cap with `backend.ownMetricSeries` in
the Helm chart, or `WATCHLOG_OWN_METRIC_SERIES` with Docker Compose
([Configuration](configuration.md)).

A **series** is one metric with one set of label values: `orders_created_total{method="card"}`
and `orders_created_total{method="cash"}` are two. A series counts while it reported within
the last hour.

## Three ways in

Open **Your metrics → Add a source**. All three end in the same place.

### 1. Expose `/metrics`

Anything that serves the Prometheus text format or OpenMetrics: an exporter, or your own app
with a Prometheus client library. WatchLog's collector reads it every 30 seconds.

**In a Kubernetes cluster**, annotate the pod template:

```yaml
spec:
  template:
    metadata:
      annotations:
        watchlog.io/scrape: 'true'
        watchlog.io/port: '8080' # default: the pod's first named port
        watchlog.io/path: '/metrics' # default
```

`watchlog.io/port` takes a number or a port's name. If your pods already carry
`prometheus.io/scrape: "true"`, turn on **Also scrape pods annotated prometheus.io/scrape**
on the same page; it is off by default, per cluster.

**On a server**, give the address on that server, for example `localhost:9400/metrics`. The
collector on that server reads it. A server installed before the collector was part of the
agent gets it with `curl -fsSL https://<your WatchLog>/install.sh | sudo sh -s -- --upgrade`.

**Find endpoints for me** tries `/metrics` on the ports WatchLog already sees (a pod's declared
ports, a server's listening ports) and lists the ones that answer with metrics; each is added
with one click, with no annotation needed.

What the collector accepts: `http` and `https` addresses, an answer of up to 5 MB within 10
seconds, and no redirect to another host. **It sends no credentials**: an endpoint behind basic
auth or a bearer token can't be scraped yet. Use remote write or a push for those.

### 2. Send from Prometheus

If you already run Prometheus, send WatchLog the few metrics you want to see there. Create a
token on the **Add a source** page (it is shown once), then add to `prometheus.yml`:

```yaml
remote_write:
  - url: https://<your WatchLog>/ingest/v1/write
    authorization:
      credentials: wl_mt_…
    write_relabel_configs:
      # Send only what you want to see in WatchLog.
      - source_labels: [__name__]
        regex: 'orders_.*|checkout_duration_seconds.*|queue_jobs_waiting'
        action: keep
```

Keep the `write_relabel_configs`: without it Prometheus sends everything it scrapes, and your
plan's series fill with metrics nobody opens.

### 3. Push a value

One HTTP call from a script, a cron job or CI, with the same kind of token:

```bash
curl -sS -X POST https://<your WatchLog>/ingest/v1/metrics \
  -H "Authorization: Bearer wl_mt_…" \
  -H "Content-Type: application/json" \
  -d '{"name": "backup_last_success_timestamp_seconds",
       "value": '"$(date +%s)"', "server": "db-1"}'
```

| Field      | Meaning                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `name`     | The metric's name: letters, digits and `_`.                                                         |
| `value`    | A number.                                                                                           |
| `type`     | `counter` or `gauge`. Without it, a name ending in `_total` is a counter and anything else a gauge. |
| `labels`   | Optional: `{"queue": "emails"}`.                                                                    |
| `workload` | In a cluster: what it belongs to, as `namespace/name`.                                              |
| `server`   | On a fleet: the server it belongs to.                                                               |

A **counter** push adds its value to the metric's running total (push `1` for each order, or
`12` for the twelve since the last push). A **gauge** push keeps the last value. Several values
go in one call:

```json
{
  "workload": "shop/orders",
  "metrics": [
    { "name": "orders_created_total", "value": 3, "labels": { "method": "card" } },
    { "name": "queue_jobs_waiting", "type": "gauge", "value": 41 }
  ]
}
```

The answer says what was stored and what was dropped, and why:

```json
{
  "stored": 2,
  "dropped": {
    "reserved": 0,
    "invalid": 0,
    "cardinality": [],
    "sourceCap": 0,
    "orgCap": 0,
    "sources": false
  }
}
```

A token is limited to 100 pushes a second (bursts of 300); over that the answer is `429` with
`Retry-After`.

### Tokens

A token (`wl_mt_…`) can only **send** your own metrics and [change events](#change-events) to
the cluster or fleet it was made for. It can't read anything, and it can't send WatchLog's own
data. Owners and Admins create and revoke tokens; a revoked token stops being accepted at
once.

## What a metric belongs to

- **Scraped in a cluster:** the workload that owns the pod.
- **Scraped on a server:** that server.
- **Remote write:** in a cluster, the workload of the pod named by the series' `namespace` and
  `pod` labels; on a fleet, the server named by its `instance`, `host`, `hostname`, `server` or
  `node` label.
- **Pushed:** what the push says in `workload` or `server`.

Anything else is **Not tied to anything**. It still works everywhere (the list, dashboards,
alerts); it just can't be pinned to a page.

## What is refused, and what the page says

WatchLog's own monitoring is never affected by any of this.

- **Names starting `watchlog_`** are WatchLog's own and are refused.
- **A label with more than 100 values on one metric** (a user id, an email, a URL path) gets
  that metric refused, and the page names the label: _too many values for `user_id`_. Remove
  the label at the source, then press **Check again** on the metric.
- **Over a source's series** (100 on Free, 500 otherwise), the source's extra series are
  dropped.
- **Over your plan's series**, new series are refused. Series already known keep flowing.
- **Over your plan's sources** (3 on Free), a new source isn't stored at all.

The **Sources** table on **Add a source** shows, for each source, how it arrives, what it
belongs to, its series, when it last reported, and exactly what was dropped and why. After a
downgrade, what you have stays until it ages out; only new series and sources are refused.

## How a metric is shown

| Type      | Recognised by                                                       | Shown as                                   |
| --------- | ------------------------------------------------------------------- | ------------------------------------------ |
| Counter   | a `TYPE` line, or a name ending in `_total`                         | its rate, per second, minute or hour       |
| Histogram | a `TYPE` line, or `_bucket` series with `le` (and `_sum`, `_count`) | p95, with p50 and p99 on the metric's page |
| Gauge     | everything else                                                     | as it is                                   |
| Timestamp | a name ending in `_timestamp` or `_timestamp_seconds`               | the time since: "3 h ago"                  |
| Summary   | a `TYPE` line                                                       | its average                                |

A gauge with several series is **summed** when it counts things or bytes, and **averaged** when
it is a ratio, a percentage, a temperature or a duration.

The unit comes from the name's suffix (`_seconds`, `_bytes`, `_celsius`, `_ratio`,
`_percent`). If WatchLog guessed the type or the unit wrong, **Correct the type or unit** on
the metric's page fixes it for good.

`go_*`, `process_*`, `promhttp_*` and `scrape_*` metrics, which every exporter has, are stored
within your plan's series but left off the list. **Show all** brings them back.

## The page

**All metrics** lists every metric with a few words made from its name, where it comes from,
its last hour and its value now. Search, or filter by namespace or server. A metric's page
shows:

- its value now and its line over the selected time range;
- **Split by** one label: the five highest values now, and the rest as one line;
- its labels, how many series it has, and where it is used;
- **Add to a dashboard**, **Pin to** the workload or server it belongs to, **Alert on it**,
  **Watch with What changed** (Pro), and correcting its type or unit.

## Pinning

Pin up to **6** metrics to a workload's page (in a cluster) or a server's page (on a fleet).
They appear there as **Its own metrics**, next to the CPU, memory and restarts WatchLog already
shows, each with its value now and its last hour.

## Dashboards

A dashboard belongs to your organisation. Owners and Admins build it; everyone reads it. It is
a grid of **widgets**, and a widget is:

- a **metric**;
- a **shape**: Number, Line, Area or Bars;
- optionally **one label to split by** (Bars with a split are that label's values ranked by
  their value now);
- a **size**: Small, A third, Medium, Two thirds or Wide (3, 4, 6, 8 or 12 of the grid's 12
  columns);
- a **title**, which you can rename.

Press **Edit**. The side panel makes or changes a widget with a live preview. Drag a widget by
its handle to move it and by its corner to resize it; the same can be done with the buttons on
each widget, or with the arrow keys on the handle and on the corner. **Done** saves everything
at once, and leaving with unsaved changes asks first.

A dashboard has one time range (the picker at the top) and reads again every 30 seconds while
its tab is visible. On a phone it is one column. A widget whose metric stopped reporting says
so, and comes back by itself when the metric does.

**What there isn't, on purpose:** a query language, variables, formulas, thresholds drawn on
charts, WatchLog's own metrics on a dashboard, sharing links and exports. If you need those,
keep Grafana for them: your Prometheus can send the same metrics to both.

## Alerts

Open **Your metrics → Alerts**, or press **Alert on it** on a metric. A rule is:

- **When** a metric
- **is** above a value, below a value, outside its usual range (Pro), not reported for a
  while, or (a timestamp) older than a while;
- **for** how long before it fires;
- a **severity** and the **channels** it goes to.

Before you save it, **It will say** shows the sentence with the metric's real value:
_Jobs waiting on shop/worker is 612, above 500 for 15 min._

- A value is typed as the page shows it: a rate per second, minute or hour; a share in percent.
- **Not reported for** fires when a workload's or a server's series of the metric stop
  arriving. **Older than** is for timestamps: _Backup last success on db-1 is 27 h old_.
- A metric that belongs to several workloads or servers is checked for each, and each gets its
  own alert, named after it.

These are ordinary [alert rules](alerts.md): they are listed under **Alerts** with every other
rule, grouped, silenced and sent the same way, and their alerts show under **Needs attention**
on the workload or server the metric belongs to. Community has the value rules; "outside its
usual range" is part of Pro. Cloud Free has no alerts on your own metrics: the tab says so.

## The usual range, and What changed

On Pro, press **Watch with What changed** on a metric. WatchLog then learns what is usual for
it at each hour of the week, from the last 14 days, the same way [What changed](what-changed.md)
does for everything else. It needs a week of the metric before it says anything.

A watched metric:

- shows its usual range next to its value (_usual 3.6 – 5.1 /min_), on its page, on a
  dashboard's numbers and on a pinned tile, and as a soft band under its line;
- can be alerted on with **outside its usual range**;
- is one more series in What changed, on the workload or server it belongs to: when something
  breaks, _orders created_ left its range is in the same list and the same story as the CPU and
  the response time. (A metric tied to nothing has its range on its own page only.)

An organisation watches at most **50** metrics. A timestamp has no usual range: alert on it
with "older than".

## Change events

Tell WatchLog when **you** changed something: a deploy from CI, a config change, a migration,
a feature flag. One call, with the same kind of token as a push:

```bash
curl -sS -X POST https://<your WatchLog>/api/v1/events \
  -H "Authorization: Bearer wl_mt_…" \
  -H "Content-Type: application/json" \
  -d '{"title": "Deployed orders 2.15.0", "kind": "deploy",
       "workload": "shop/orders", "link": "https://ci.example.com/runs/812"}'
```

| Field      | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `title`    | What happened, in your words.                                                  |
| `kind`     | `deploy` (the default), `config`, `migration`, `flag` or `other`.              |
| `workload` | In a cluster: what it is about, as `namespace/name`.                           |
| `server`   | On a fleet: the server it is about.                                            |
| `link`     | Optional: the pipeline run or the pull request.                                |
| `time`     | Optional: when it happened (unix seconds or ISO 8601, within the last 7 days). |

The event then appears:

- in **Events**, on the workload or server it names, with the token's name as who said it;
- as a line on the **charts** of that workload or server, and on its own metrics' charts;
- under **Changed around then** in What changed, and as a step in **probable cause** when
  something broke right after it.

An event never raises an alert by itself. A token sends one event a second (bursts of 30);
over that the answer is `429` with `Retry-After`.

**GitHub Actions**, as the last step of a deploy job:

```yaml
- name: Tell WatchLog
  if: success()
  run: |
    curl -sS -X POST "$WATCHLOG_URL/api/v1/events" \
      -H "Authorization: Bearer $WATCHLOG_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"title\": \"Deployed orders ${GITHUB_SHA::7}\", \"kind\": \"deploy\",
           \"workload\": \"shop/orders\",
           \"link\": \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"}"
  env:
    WATCHLOG_URL: ${{ vars.WATCHLOG_URL }}
    WATCHLOG_TOKEN: ${{ secrets.WATCHLOG_TOKEN }}
```

**GitLab CI**:

```yaml
tell-watchlog:
  stage: .post
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - |
      curl -sS -X POST "$WATCHLOG_URL/api/v1/events" \
        -H "Authorization: Bearer $WATCHLOG_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"title\": \"Deployed orders $CI_COMMIT_SHORT_SHA\", \"kind\": \"deploy\",
             \"workload\": \"shop/orders\", \"link\": \"$CI_PIPELINE_URL\"}"
```

Keep the token in the CI's secrets. It can only send; it can't read anything.

## The API

The read routes are part of the [public API](api.md) and work with an API token:

- `GET /api/v1/clusters/{id}/own-metrics`: what is used, the limits, the sources and tokens.
- `GET /api/v1/clusters/{id}/own-metrics/metrics`: each metric with its value now.
- `GET /api/v1/clusters/{id}/own-metrics/metrics/{metricId}` and `…/series?from=&to=&by=`.
- `GET /api/v1/own-dashboards` and `GET /api/v1/own-dashboards/{id}`.
- `GET /api/v1/clusters/{id}/own-metrics/alerts`: the alert rules on your metrics.

Sending uses an own-metrics token, not an API token: `POST /ingest/v1/write` (remote write),
`POST /ingest/v1/metrics` (push) and `POST /api/v1/events` (change events).
