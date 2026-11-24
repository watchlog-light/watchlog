---
title: Enterprise licence
description: The WatchLog Enterprise licence key for a self-hosted install: how to add it, that it works offline and air-gapped, the units it counts, expiry and grace, and what happens over the limit.
---

# Enterprise licence

A self-hosted WatchLog is **Community** until you add a licence key: everything in it is free,
with no limit on clusters, servers or users. An **Enterprise licence key** turns on every Pro
feature on that installation, for all its organisations, and the Enterprise features as they
ship.

[WatchLog Cloud](cloud.md) doesn't use keys: its plans decide, and a key set there is ignored.

## What the key is

One line of text that starts with `wl1.`. It holds who the licence is for, how many units it
covers, its features and its end date, signed by WatchLog. WatchLog checks the signature
**on your server, offline**: it never calls home, so the key works on an air-gapped network.
Nothing about your install is sent anywhere.

The features a key lists:

| Feature   | What it turns on                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| `pro`     | Everything WatchLog Cloud Pro has: [What changed](what-changed.md), All clusters and fleets, their API and MCP tools |
| `network` | [Network devices](network.md): switches, routers and the map (Wi-Fi, NAS, NVRs and UPSes next)                       |

## Adding the key

Any one of these; the environment wins over a key pasted in the dashboard, and Settings →
License says so.

- **Settings → License** (Owners): paste the key and press **Check and save**. You see the
  result at once: who it is for, the units, the features and the end date, or why the key
  doesn't work. The key is stored encrypted, like the email server's password.
- **`WATCHLOG_LICENSE`**: the key itself, in the environment of the backend, the alert-worker
  and the anomaly-worker.
- **`WATCHLOG_LICENSE_FILE`**: a path to a file that holds the key, read on each check, so a
  mounted Secret can be replaced in place.

### Docker Compose

In `.env`:

```bash
WATCHLOG_LICENSE=wl1.…
COMPOSE_PROFILES=enterprise
```

then `docker compose up -d`. `COMPOSE_PROFILES=enterprise` starts What changed's
anomaly-worker; without a key it exits at start and stays down, so if you paste the key in
Settings instead, run `docker compose up -d` once afterwards.

### Kubernetes (Helm)

```bash
helm upgrade watchlog oci://ghcr.io/watchlog-light/charts/watchlog --reuse-values \
  --set license.key='wl1.…' --set anomalyWorker.enabled=true
```

Or keep the key in your own Secret: `--set license.existingSecret=watchlog-license`
(with the key under `license`, or name it with `license.existingSecretKey`).

## What a working key changes

- **What changed** starts learning when the key is added (never from older history), and lists
  what left its usual range after 7 days of data, as in [What changed](what-changed.md).
- **All clusters and fleets** opens instead of its upgrade page.
- The **MCP tools** `get_what_changed` and `get_all_clusters`, and their API routes, appear.
- The account menu's About line says **WatchLog Enterprise, licensed to** your company (for
  Owners; other members see WatchLog Enterprise). `GET /api/v1/health` answers
  `"edition": "enterprise", "licensed": true`, and never the key or the customer.

Everything else is the same as Community.

## Units

A licence covers a number of **units**:

- each **Kubernetes node** and each **server** (a Linux server, with whatever runs on it) is one;
- each **network device** too ([network devices](network.md)), with **Wi-Fi access points free**.

WatchLog counts them from what your agents report, hour by hour. A day's count is its busiest
hour, and the licence's count is the **highest daily count of the last 7 days**, so a burst of
autoscaling for an hour doesn't count for a week, and a node removed today still counts until
the week has passed. Settings → License shows the units used of allowed, and what they are made
of (nodes, servers).

## Over the limit

- **At once:** Owners see a banner: "58 of 50 units. Your licence covers 50; contact us for a
  larger one."
- **Monitoring never stops.** Agents, metrics, alerts, the service map and everything in
  Community keep working however many units you have: the limit is only about the licensed
  features.
- **After 30 days in a row over the limit**, licensed features take on **no new places**: a
  cluster or fleet added after that doesn't start learning What changed, and no new network
  devices can be added. Everything they already cover keeps working.
  A day at or under the limit ends the run.

## Expiry and grace

- **30 days before the end:** a banner for Owners, and one email to each Owner (through the
  email server your alerts use).
- **The 14 days after the end (grace):** licensed features keep working, and the banner says the
  day they stop.
- **After the grace days:** licensed features turn off. What changed stops scoring, and its
  pages say "Your licence ended on …" with how to renew. **Nothing is deleted**: a new key turns
  them back on with what they had learned.

Removing the key (Settings → License → **Remove key**, or unsetting the environment) is the same:
licensed features turn off, and nothing is deleted.

## Questions

- **Does WatchLog need internet access to check the key?** No. The check is a signature and a
  date, on your server.
- **Can I move the key to a new server?** Yes, while it is the same installation for the same
  company. Ask us if you run several.
- **What if the server's clock is wrong?** A key whose issue date is more than a day ahead of
  the clock is refused, so fix the clock (NTP) first.
- **Where is the Enterprise code?** In the `ee/` folder of the repository, under its own
  source-available licence; it loads only with a key that lists its feature. The rest of
  WatchLog is AGPL-3.0.
