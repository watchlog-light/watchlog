---
title: Certificates and scheduled jobs
description: SSL/TLS certificate expiry monitoring and cron job, systemd timer and Kubernetes CronJob monitoring in WatchLog, on Linux servers and Kubernetes, with default alerts. What is read, what is sent, and what isn't covered.
---

# Certificates and scheduled jobs

Two things fail quietly until they hurt: a certificate that wasn't renewed, and a scheduled
job that stopped running or keeps failing. Since 0.10, WatchLog finds both by itself, on
[Linux servers](servers.md) and on Kubernetes, and alerts before they become an outage.
Nothing to configure: no list of hosts to check, no job to wrap in a ping.

Both are under **Applications**, next to the monitored services: the **Certificates** and
**Scheduled jobs** tabs show the cluster or fleet selected in the top bar. The Overview and
each server's page show their counts and problems, and the search (⌘K) finds them by name.

They need agent 0.10 or later (and, on Kubernetes, the agent chart's 0.10 permissions). A tab
names the servers whose agent is older; upgrade them and their certificates and jobs appear
within ten minutes.

## Certificates

### How they are found

**On a server**, the agent reads the certificate every listening TCP port presents, from the
server itself, every 10 minutes:

- a TLS handshake on each port a service, process group or container listens on; a port that
  isn't TLS is left alone for an hour;
- STARTTLS on the well-known ports: SMTP (25, 587), IMAP (143), POP3 (110), PostgreSQL (5432)
  and MySQL (3306);
- the names in the server's certificate stores, asked for one by one on each TLS port (SNI), so
  each virtual host's certificate is found: Let's Encrypt (`/etc/letsencrypt/live`), acme.sh
  and Caddy. Only the stores' directory names are read; no file in them is opened.

**On Kubernetes**, the cluster-agent reads, from inside the cluster:

- each Service's TLS port (named `https` or numbered 443) at its cluster address, the API
  server's own `default/kubernetes` included;
- each Ingress's TLS hosts, asked for by name on its Ingress controller's Service.

No traffic is decrypted, no private key is read and no Secret is opened: WatchLog sees only
what a client sees.

### What the tab shows

Each certificate once, problems first, with its names, where it is served (a service and port
on a server; a Service or an Ingress host in a cluster), its issuer, the days it has left with
a bar of its lifetime, how it renews, and its status:

| Status       | When                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Expired      | its validity ended                                                                                 |
| Expires soon | less than 3 days left                                                                              |
| Expiring     | less than 14 days left                                                                             |
| Problem      | it doesn't cover a name it is served for, or its chain is incomplete (the intermediate is missing) |
| Working      | none of these                                                                                      |

**Renewal.** WatchLog keeps every certificate it has seen under the same names. A new one
while the old one was still valid is a renewal, and the tab says when it last happened and how
many days before expiry ("renews itself; last time 32 days ago"). Until it has seen one, it
says "not seen renewing yet". When it sees the job that renews it on the same server (certbot's
timer or cron line, acme.sh's), it names it, and says so when that job is failing. A
certificate from a private CA or self-signed is marked as such.

A certificate's page lists every place it is served, its facts (issuer, validity, key, chain,
fingerprint) and every certificate seen under its names.

## Scheduled jobs

### How they are found

- **systemd timers**, from systemd itself: every timer, enabled or not, its schedule as
  systemd normalised it (`OnCalendar`, or after boot), its random delay and whether it catches
  up after a reboot (`Persistent`), and each run of the unit it starts: when, how long, the
  exit code.
- **cron jobs**, from the crontabs on the server (`/etc/crontab`, `/etc/cron.d/*` and the
  users' crontabs), matched with the processes cron really starts: a small eBPF program sees
  each command cron's child runs, and its exit gives the code. Without eBPF, cron's own lines
  in a text log (`/var/log/cron`, `/var/log/syslog`) give each run, without its exit code.
- **Kubernetes CronJobs**, from the cluster-agent: each Job a CronJob created is a run, and a
  failed Job's pod gives the exit code. `spec.timeZone` is honoured.

**Only a name leaves the server.** A cron job's name is derived from its command: the script's
or program's file name (`backup.sh`, `pg_dump`), a framework's command (`artisan
schedule:run`, `manage.py clearsessions`), or `run-parts`' directory (`cron.daily`). The
command line, its arguments, its environment, the user it runs as and its output are never
sent, so a password in a crontab line stays on the server. A timer's name is its unit's name.

### States

| Status   | When                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Failing  | its last run failed: the exit code, how many times in a row, the last good run                               |
| Missed   | a run was due and none started, with the server and the agent up; or the timer was disabled after it was due |
| Slow     | running, or ran, 3 times its usual duration and at least 5 minutes longer (once it has 5 good runs)          |
| Running  | a run is under way                                                                                           |
| Working  | none of these                                                                                                |
| Disabled | a timer that is turned off and never ran                                                                     |

A run that starts late because of a timer's random delay, a persistent timer's catch-up after a
reboot, or the hour around a daylight saving change is never counted as missed. A run that was
due while the server was off, or while the agent was stopped, is told apart and not counted
either. Times are the server's own time zone.

The table shows each job's schedule in words and its next run, its last run and how long it
took, and its last 14 runs as small bars. A job's page shows why it is in its state, its
schedule as written, its runs and their durations, and for a systemd timer its unit's log on
demand ([Logs](logs.md)). A job that runs every 5 minutes or more often keeps its last 14 runs
and an hourly count of its runs and failures, never one row or event per run.

## Default alerts

On from the first day, in every edition, for Kubernetes and servers alike, and editable in
**Alerts** like the others:

| Rule                            | When                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Certificate expiring            | 14 days left (warning); 3 days left or expired (critical)                                                    |
| Certificate name or chain wrong | a name it is served for isn't covered, or the chain is incomplete, for 10 minutes                            |
| Scheduled job failed            | its last run failed (warning); 3 in a row (critical); a job every 5 minutes or more often only at 3 in a row |
| Scheduled job missed            | a run was due and none started                                                                               |
| Scheduled job slow              | running, or ran, far longer than usual                                                                       |

One alert per certificate and problem, and per job, not per run; a new certificate or the next
good run resolves it. A certificate that renews itself on time never alerts. The message says
what, where and since when: "backup.timer failed 3 times in a row on worker-1 · exit code 2 ·
last good run 2 d ago".

Events record a certificate renewed, about to expire or expired, and a job that failed, missed
a run or recovered (one per job, reason and day, so a job every minute stays a few lines). The
[probable cause](probable-cause.md) names an expired or mismatched certificate where a failing
connection arrives, and the failing timer behind a service that failed.

## What isn't covered

- **A virtual host whose name is in no certificate store** (a certificate copied in by hand
  under a name WatchLog can't know): only the port's default certificate is read.
- **Ports bound to loopback only, with a `docker run` install**: the agent reads the host's
  ports through its network gateway, so `127.0.0.1`-only ports aren't reached. A systemd or
  package install reads them.
- **Beyond the caps**: 50 ports and 100 certificates per server or cluster; the tab says how many
  more there were.
- **Kubernetes**: Ingresses without a TLS section, the Gateway API, and Services a
  NetworkPolicy keeps the cluster-agent from reaching (counted as unreachable). Without the
  chart's 0.10 permission to list Ingresses, only TLS Services are read.
- **anacron and `at`**: anacron's own jobs run under cron as `run-parts`, which is listed;
  `at` jobs aren't.
- **cron jobs inside containers**, unless the container's cron runs in the server's process
  tree the agent sees.
- **cron's `CRON_TZ=` lines**: such jobs are evaluated in the server's time zone.
- **cron runs without eBPF and without a text log** (Debian 12's default keeps only the
  journal): its cron jobs are listed without runs and never alert.
- **Certificates on UDP** (QUIC, DTLS) and client certificates.

## API and MCP

Read-only routes list a cluster's or fleet's certificates and scheduled jobs, and one of each
with its history or runs ([API](api.md)). The MCP tools `list_certificates` and
`list_scheduled_jobs` give an assistant the same answers ([MCP](mcp.md)): "Which certificates
expire this month?", "Did last night's backup run?".
