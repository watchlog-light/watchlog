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

## Your first metric in two minutes

You need nothing installed: one HTTP call sends a number.

1. Open **Your metrics → Add a source**. It asks **Where is your number?** and opens **Push a
   value**.
2. **Create a token.** Its value (`wl_mt_…`) is shown once: copy it. A token can only send; it
   can't read anything.
3. **Say what the number is:** the server or workload it belongs to, a name and a value. The
   name decides how it is read:
   - ends in `_total`: a **counter**. Each push adds up. Push `1` for every order, and you see
     orders per minute.
   - ends in `_timestamp_seconds`: a **time**. Push the clock after a good backup, and you see
     "last good backup: 3 h ago".
   - anything else: a **gauge**. The last value wins. Push `12` for 12 jobs waiting.
4. **Run the command** where the number is. The page fills in your installation's address, your
   token and what you chose; here it is with placeholders:

<!-- snippet:push:curl -->
<!-- prettier-ignore-start -->
```bash
curl -sS -X POST https://<your WatchLog>/ingest/v1/metrics \
  -H "Authorization: Bearer wl_mt_…" \
  -H "Content-Type: application/json" \
  -d '{"name": "orders_total", "value": 1, "server": "web-1"}'
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

5. The page says **Received `orders_total` = 1** within a few seconds, with **Open it**, **Put
   it on a dashboard** and **Alert on it**.

No terminal at hand? **Send a test value for me** on the same page sends one value
(`my_first_test_value`) through your token, so you see the whole path; **Remove the test
value** takes it away again. It is an ordinary pushed value while it exists: one series of
your plan's, and no extra source.

The same call from where your number lives:

**A script run by cron**

<!-- snippet:push:cron -->
<!-- prettier-ignore-start -->
```bash
#!/usr/bin/env bash
# push.sh: run it from cron, for example every five minutes:
#   */5 * * * * /usr/local/bin/push.sh
set -euo pipefail
value=1   # your number, for example: value=$(ls /var/spool/jobs | wc -l)
curl -sS --fail -X POST https://<your WatchLog>/ingest/v1/metrics \
  -H "Authorization: Bearer wl_mt_…" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"orders_total\", \"value\": $value, \"server\": \"web-1\"}"
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**Node.js**

<!-- snippet:push:node -->
<!-- prettier-ignore-start -->
```js
// Node.js 18 or later: fetch is built in.
await fetch("https://<your WatchLog>/ingest/v1/metrics", {
  method: "POST",
  headers: { Authorization: "Bearer wl_mt_…", "Content-Type": "application/json" },
  body: JSON.stringify({ name: "orders_total", value: 1, server: "web-1" }),
});
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**Python**

<!-- snippet:push:python -->
<!-- prettier-ignore-start -->
```python
import json, urllib.request

req = urllib.request.Request(
    "https://<your WatchLog>/ingest/v1/metrics",
    data=json.dumps({"name": "orders_total", "value": 1, "server": "web-1"}).encode(),
    headers={"Authorization": "Bearer wl_mt_…", "Content-Type": "application/json"},
)
urllib.request.urlopen(req)
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**PHP**

<!-- snippet:push:php -->
<!-- prettier-ignore-start -->
```php
$context = stream_context_create(["http" => [
  "method" => "POST",
  "header" => "Authorization: Bearer wl_mt_…\r\nContent-Type: application/json",
  "content" => json_encode(["name" => "orders_total", "value" => 1, "server" => "web-1"]),
]]);
file_get_contents("https://<your WatchLog>/ingest/v1/metrics", false, $context);
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**Go**

<!-- snippet:push:go -->
<!-- prettier-ignore-start -->
```go
// import "net/http" and "strings"
body := strings.NewReader(`{"name": "orders_total", "value": 1, "server": "web-1"}`)
req, _ := http.NewRequest("POST", "https://<your WatchLog>/ingest/v1/metrics", body)
req.Header.Set("Authorization", "Bearer wl_mt_…")
req.Header.Set("Content-Type", "application/json")
if res, err := http.DefaultClient.Do(req); err == nil {
	res.Body.Close()
}
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

If nothing arrives: check that the token is copied whole, that your WatchLog's address is
reachable from the machine that runs the command, and the answer's status code (`curl -i`
shows it). `401`: the token isn't whole, or it was revoked. `400`: the body isn't right, and
the answer names the field. `429`: too many calls a second, and the answer says how long to
wait. `200` with `"stored": 0`: the answer says what was dropped and why.

## Which way is for me

- **The number is in a script, a cron job, CI or your own code:** [push a value](#1-push-a-value).
  One command, nothing to install.
- **Your app or an exporter already has a `/metrics` page:** [expose `/metrics`](#2-expose-metrics).
  WatchLog reads it every 30 seconds.
- **You already run Prometheus:** [send from Prometheus](#3-send-from-prometheus). It sends the
  few metrics you choose.

## What each plan includes

|                                                      | Cloud Free                      | Cloud Pro                                          | Self-hosted Community                  | Self-hosted with a licence (`pro`) |
| ---------------------------------------------------- | ------------------------------- | -------------------------------------------------- | -------------------------------------- | ---------------------------------- |
| Series in the organisation                           | 200                             | 200 for each billed node or server, at least 1,000 | the installation's cap (20,000)        | the installation's cap             |
| Series from one endpoint, or one token's pushes      | 100                             | 500                                                | 500                                    | 500                                |
| Series from one token's remote write                 | up to the organisation's series | up to the organisation's series                    | up to the installation's cap           | up to the installation's cap       |
| Kept for                                             | 3 days                          | 30 days                                            | the installation's retention           | the installation's retention       |
| Sources                                              | 3                               | no limit                                           | no limit                               | no limit                           |
| Dashboards                                           | 1, with 8 widgets               | 50, with 24 widgets each                           | 50, with 24 widgets each               | 50, with 24 widgets each           |
| Pin to a workload's or server's page                 | yes                             | yes                                                | yes                                    | yes                                |
| Alerts on your metrics                               | none                            | all                                                | above, below, not reported, older than | all                                |
| Usual range, "outside its usual range", What changed | no                              | yes                                                | no                                     | yes                                |

Nothing here is billed on its own: Cloud Pro's allowance follows the nodes and servers it
already pays for. A self-hosted installation sets its cap with `backend.ownMetricSeries` in
the Helm chart, or `WATCHLOG_OWN_METRIC_SERIES` with Docker Compose
([Configuration](configuration.md)).

**A series is one line on a chart: one metric with one set of labels.** `orders_total` is 1
series however often you send it. `orders_total` split by 3 payment methods is 3. There is no
limit on how many times you send: "1,000 series" is not "1,000 calls". A series counts while it
reported within the last hour.

## Three ways in

Open **Your metrics → Add a source**. All three end in the same place.

### 1. Push a value

One HTTP call with a token, from a script, a cron job, CI or your own code:
[Your first metric in two minutes](#your-first-metric-in-two-minutes) has it start to finish, in
curl, Bash, Node.js, Python, PHP and Go.

| Field      | Meaning                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `name`     | The metric's name: letters, digits and `_`.                                                         |
| `value`    | A number.                                                                                           |
| `type`     | `counter` or `gauge`. Without it, a name ending in `_total` is a counter and anything else a gauge. |
| `labels`   | Optional: `{"queue": "emails"}`.                                                                    |
| `workload` | In a cluster: what it belongs to, as `namespace/name`.                                              |
| `server`   | On a fleet: the server it belongs to.                                                               |

A **counter** push adds its value to the metric's running total (push `1` for each order, or
`12` for the twelve since the last push). A **gauge** push keeps the last value. A timestamp is
pushed like this, after the job it is about:

<!-- snippet:push-timestamp -->
<!-- prettier-ignore-start -->
```bash
#!/usr/bin/env bash
# push.sh: run it from cron, for example every five minutes:
#   */5 * * * * /usr/local/bin/push.sh
set -euo pipefail
value=$(date +%s)   # now: run this after the job succeeded
curl -sS --fail -X POST https://<your WatchLog>/ingest/v1/metrics \
  -H "Authorization: Bearer wl_mt_…" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"backup_last_success_timestamp_seconds\", \"value\": $value, \"server\": \"web-1\"}"
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

Several values go in one call, at most 500:

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

### 2. Expose `/metrics`

Many apps and every Prometheus exporter have an address that lists their numbers as plain
text. Give WatchLog that address and its collector reads it every 30 seconds, in the Prometheus
text format or OpenMetrics. The page looks like this:

<!-- snippet:metrics-sample -->
<!-- prettier-ignore-start -->
```text
# TYPE orders_total counter
orders_total{method="card"} 1842
# TYPE queue_jobs_waiting gauge
queue_jobs_waiting{queue="emails"} 12
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**On a server**, give the address on that server, for example `localhost:9400/metrics`. The
collector on that server reads it. A server installed before the collector was part of the
agent gets it with `curl -fsSL https://<your WatchLog>/install.sh | sudo sh -s -- --upgrade`.

**In a Kubernetes cluster**, choose the workload and give its port (and its path, when it isn't
`/metrics`). **Scrape it** adds the port in WatchLog: nothing in the cluster changes and no pod
restarts.

**Test** reads the address once, through that server's or that cluster's collector, before
anything is added, and says what it found: how many series and a few of their names; nothing is
listening on that port; it answered, but not with metrics (a web page); it asks for a password,
which scraping can't send yet; too slow (over 10 seconds) or too big (over 5 MB). When a cap
would cut it, it says how many series would be kept. Test needs the collector from 1.0.3; with
an older one it says the collector didn't answer, and **Scrape it** still works.

**Find endpoints for me** tries `/metrics` on the ports WatchLog already sees (a pod's declared
ports, a server's listening ports), says which ports it tried and which it left out (SSH and
databases never serve metrics), and lists the ones that answer; each is added with one click.

**No `/metrics` page yet?** Three ways forward:

- [Push a value](#1-push-a-value) instead. The quickest.
- Add one to your app with the Prometheus library for your language. One counter on port 9400:

  **Node.js**

<!-- snippet:expose:node -->
<!-- prettier-ignore-start -->
```js
// npm install @prometheus-io/client   (the library that was "prom-client")
const http = require("http");
const client = require("@prometheus-io/client");

const orders = new client.Counter({ name: "orders_total", help: "Orders created" });
// where an order is created:
orders.inc();

http.createServer(async (req, res) => {
  res.setHeader("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
}).listen(9400);
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**Python**

<!-- snippet:expose:python -->
<!-- prettier-ignore-start -->
```python
# pip install prometheus-client
from prometheus_client import Counter, start_http_server

orders = Counter("orders", "Orders created")  # exposed as orders_total
start_http_server(9400)
# where an order is created:
orders.inc()
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**Go**

<!-- snippet:expose:go -->
<!-- prettier-ignore-start -->
```go
// go get github.com/prometheus/client_golang
import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var orders = promauto.NewCounter(prometheus.CounterOpts{Name: "orders_total", Help: "Orders created"})

func main() {
	// where an order is created: orders.Inc()
	http.Handle("/metrics", promhttp.Handler())
	http.ListenAndServe(":9400", nil)
}
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**PHP**

<!-- snippet:expose:php -->
<!-- prettier-ignore-start -->
```php
// composer require promphp/prometheus_client_php
// metrics.php, served at /metrics (APCu keeps the count between requests)
$registry = new Prometheus\CollectorRegistry(new Prometheus\Storage\APC());
// where an order is created:
$registry->getOrRegisterCounter("", "orders_total", "Orders created")->inc();

header("Content-Type: " . Prometheus\RenderTextFormat::MIME_TYPE);
echo (new Prometheus\RenderTextFormat())->render($registry->getMetricFamilySamples());
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

**Java**

<!-- snippet:expose:java -->
<!-- prettier-ignore-start -->
```java
// Maven: io.prometheus:prometheus-metrics-core
//    and io.prometheus:prometheus-metrics-exporter-httpserver
import io.prometheus.metrics.core.metrics.Counter;
import io.prometheus.metrics.exporter.httpserver.HTTPServer;

Counter orders = Counter.builder().name("orders_total").help("Orders created").register();
HTTPServer server = HTTPServer.builder().port(9400).buildAndStart();
// where an order is created:
orders.inc();
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

- Use an exporter: a small program that publishes numbers for something else (a GPU, a queue,
  a device). WatchLog already collects each server's and container's CPU, memory, disk and
  network, so node_exporter and cAdvisor aren't needed.

**Or keep it with the workload:** annotate its pod template, as one command or in its manifest.
Changing the pod template restarts its pods.

<!-- snippet:kubectl-patch -->
<!-- prettier-ignore-start -->
```bash
kubectl -n shop patch deployment orders --type merge \
  -p '{"spec":{"template":{"metadata":{"annotations":{"watchlog.io/scrape":"true","watchlog.io/port":"8080"}}}}}'
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

<!-- snippet:annotation -->
<!-- prettier-ignore-start -->
```yaml
spec:
  template:
    metadata:
      annotations:
        watchlog.io/scrape: "true"
        watchlog.io/port: "8080"      # default: the first named port
        watchlog.io/path: "/metrics"  # default
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

`watchlog.io/port` takes a number or a port's name. If your pods already carry
`prometheus.io/scrape: "true"`, turn on **Also scrape pods annotated prometheus.io/scrape**
on the same page; it is off by default, per cluster.

What the collector accepts: `http` and `https` addresses, an answer of up to 5 MB within 10
seconds, and no redirect to another host. **It sends no credentials**: an endpoint behind basic
auth or a bearer token can't be scraped yet. Use remote write or a push for those.

### 3. Send from Prometheus

Only if you already run Prometheus. It keeps scraping as before, and also sends WatchLog the
few metrics you name. Create a token on the **Add a source** page (it is shown once), then add
to `prometheus.yml` and reload it:

<!-- snippet:remote-write -->
<!-- prettier-ignore-start -->
```yaml
remote_write:
  - url: https://<your WatchLog>/ingest/v1/write
    authorization:
      credentials: wl_mt_…
    write_relabel_configs:
      # Send only what you want to see in WatchLog.
      - source_labels: [__name__]
        regex: "orders_.*|checkout_duration_seconds.*|queue_jobs_waiting"
        action: keep
```
<!-- prettier-ignore-end -->
<!-- /snippet -->

Keep the `write_relabel_configs`: without it Prometheus sends everything it scrapes, and your
plan's series fill with metrics nobody opens. The page says when the first samples arrive.

### Tokens

A token (`wl_mt_…`) can only **send** your own metrics and [change events](#change-events) to
the cluster or fleet it was made for. It can't read anything, and it can't send WatchLog's own
data. Owners and Admins create and revoke tokens; a revoked token stops being accepted at
once.

## Limits on sending

Three limits protect the installation, and WatchLog's own monitoring comes first under all of
them: its agents' data is never the thing that gives way.

| Limit                                 | Pushes                         | Remote write               | The answer over it                               |
| ------------------------------------- | ------------------------------ | -------------------------- | ------------------------------------------------ |
| One token                             | 100 a second, bursts of 300    | 20 a second, bursts of 100 | `429` with `Retry-After`                         |
| All of an organisation's tokens       | 300 a second, bursts of 900    | 60 a second, bursts of 300 | `429` with `Retry-After`; it says "organization" |
| The installation, when it is strained | own-metric calls are set aside | the same                   | `503` with `Retry-After: 15`                     |

- **`429`: slow down.** Wait the seconds `Retry-After` says and send again. Prometheus does this
  by itself; a script should too. Nothing is lost on WatchLog's side that you didn't send.
- **`503`: the installation is busy.** Its backend is behind (its event loop, its writes to the
  metrics store or its database connections), so calls with your own metrics are refused for a
  moment while the agents' data keeps being taken. Send again after `Retry-After`. A
  self-hosted installation sets the thresholds with `WATCHLOG_SHED_EVENT_LOOP_LAG_MS`,
  `WATCHLOG_SHED_METRIC_WRITES_IN_FLIGHT` and `WATCHLOG_SHED_DB_WAITING`
  ([Configuration](configuration.md)).
- **One push** carries at most 500 values and 128 KB (`400` and `413` say so).
- **Tokens:** an organisation has at most 20, over all its clusters and fleets.

These are limits on calls. They have nothing to do with your plan's **series**, which count
lines on charts, not how often you send.

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
  dropped. A source here is one scraped endpoint, or one token's pushes.
- **A token's remote write has no cap of its own** (since 1.0.1): one Prometheus sends
  thousands of series through one token, so your plan's series are its only limit. The rule
  of 100 values for a label holds for it like for everything else.
- **Over your plan's series**, new series are refused. Series already known keep flowing. A
  series is one line on a chart (one metric with one set of labels), not a call: sending the
  same series more often never uses more of them.
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
`POST /ingest/v1/metrics` (push: [the call in six languages](#your-first-metric-in-two-minutes),
[its fields](#1-push-a-value) and [its limits](#limits-on-sending)) and `POST /api/v1/events`
(change events).
